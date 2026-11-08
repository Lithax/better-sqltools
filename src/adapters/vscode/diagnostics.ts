import * as path from 'node:path';
import * as vscode from 'vscode';
import { LinterUnavailableError, errorMessage } from '../../domain/errors';
import type { LintIssue } from '../../domain/model';
import type { App } from './app';

const RULES_URL = vscode.Uri.parse('https://docs.sqlfluff.com/en/stable/reference/rules.html');

/** Where sqlfluff should run so it finds the project's .sqlfluff. */
export function cwdFor(doc: vscode.TextDocument): string | undefined {
  const folder = vscode.workspace.getWorkspaceFolder(doc.uri)?.uri.fsPath;
  if (folder) return folder;
  return doc.uri.scheme === 'file' ? path.dirname(doc.uri.fsPath) : undefined;
}

export const fullRange = (doc: vscode.TextDocument) =>
  new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length));

function toDiagnostic(doc: vscode.TextDocument, i: LintIssue, normal: vscode.DiagnosticSeverity): vscode.Diagnostic {
  const line = Math.max(0, Math.min(i.line - 1, doc.lineCount - 1));
  const col = Math.max(0, i.column - 1);
  const range =
    i.endLine !== undefined && i.endColumn !== undefined
      ? new vscode.Range(line, col, Math.max(0, i.endLine - 1), Math.max(0, i.endColumn - 1))
      : (doc.getWordRangeAtPosition(new vscode.Position(line, col)) ?? new vscode.Range(line, col, line, col + 1));
  const severity =
    i.severity === 'error' ? vscode.DiagnosticSeverity.Error : i.severity === 'info' ? vscode.DiagnosticSeverity.Information : normal;
  const d = new vscode.Diagnostic(range, i.message, severity);
  d.source = 'sqlfluff';
  d.code = i.code ? { value: i.rule ? `${i.code} ${i.rule}` : i.code, target: RULES_URL } : undefined;
  return d;
}

/** Diagnostics from sqlfluff, in the dialect of the connection the editor is bound to. */
export class LintController implements vscode.Disposable {
  private readonly collection = vscode.languages.createDiagnosticCollection('Better SQLTools');
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly running = new Map<string, AbortController>();
  private warned = false;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly app: Pick<App, 'lint' | 'bindings' | 'settings' | 'logger'>) {
    const s = app.settings;
    this.subs = [
      this.collection,
      vscode.workspace.onDidOpenTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidSaveTextDocument((d) => this.schedule(d, 0)),
      vscode.workspace.onDidChangeTextDocument((e) => s.lintMode() === 'onType' && this.schedule(e.document, 600)),
      vscode.workspace.onDidCloseTextDocument((d) => this.forget(d)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('betterSqlTools.lint')) {
          this.warned = false;
          this.relintAll();
        }
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => this.relintAll()),
      app.bindings.onDidChange(() => this.relintAll()),
    ];
    this.relintAll();
  }

  dispose() {
    this.subs.forEach((s) => s.dispose());
    this.timers.forEach(clearTimeout);
    this.running.forEach((a) => a.abort());
  }

  relintAll() {
    for (const d of vscode.workspace.textDocuments) this.schedule(d, 0);
  }

  private schedule(doc: vscode.TextDocument, delay: number) {
    if (doc.languageId !== 'sql') return;
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    if (!this.app.settings.lintEnabled()) {
      this.collection.delete(doc.uri);
      return;
    }
    if (this.app.settings.lintMode() === 'manual') return;
    this.timers.set(key, setTimeout(() => void this.lintDocument(doc), delay));
  }

  private forget(doc: vscode.TextDocument) {
    const key = doc.uri.toString();
    clearTimeout(this.timers.get(key));
    this.timers.delete(key);
    this.running.get(key)?.abort();
    this.running.delete(key);
    this.collection.delete(doc.uri);
  }

  /** Lints now, regardless of the "run" setting. Returns the number of issues, or undefined if it could not run. */
  async lintDocument(doc: vscode.TextDocument): Promise<number | undefined> {
    if (doc.languageId !== 'sql' || !this.app.settings.lintEnabled()) return undefined;
    const key = doc.uri.toString();
    this.running.get(key)?.abort();
    const abort = new AbortController();
    this.running.set(key, abort);
    const version = doc.version;
    try {
      const issues = await this.app.lint.lint({
        text: doc.getText(),
        connectionId: this.app.bindings.effective(doc.uri),
        cwd: cwdFor(doc),
        signal: abort.signal,
      });
      if (abort.signal.aborted || doc.version !== version) return undefined;
      const normal = this.app.settings.lintSeverity();
      this.collection.set(doc.uri, issues.map((i) => toDiagnostic(doc, i, normal)));
      return issues.length;
    } catch (e) {
      if (abort.signal.aborted) return undefined;
      this.collection.delete(doc.uri);
      if (e instanceof LinterUnavailableError) this.warnUnavailable(e);
      else this.app.logger.warn(`sqlfluff failed on ${doc.uri.fsPath || doc.uri.toString()}: ${errorMessage(e)}`);
      return undefined;
    } finally {
      if (this.running.get(key) === abort) this.running.delete(key);
    }
  }

  private warnUnavailable(e: LinterUnavailableError) {
    if (this.warned) return;
    this.warned = true;
    void vscode.window.showInformationMessage(`${e.message} Linting is skipped until it is available.`, 'Open Settings').then((pick) => {
      if (pick) void vscode.commands.executeCommand('workbench.action.openSettings', 'betterSqlTools.lint');
    });
  }
}

/** "Format Document" for SQL files, via `sqlfluff format` (layout rules only). */
export class SqlFormatter implements vscode.DocumentFormattingEditProvider {
  constructor(private readonly app: Pick<App, 'lint' | 'bindings' | 'settings'>) {}

  async provideDocumentFormattingEdits(doc: vscode.TextDocument, _o: vscode.FormattingOptions, token: vscode.CancellationToken) {
    if (!vscode.workspace.isTrusted) return [];
    const abort = new AbortController();
    token.onCancellationRequested(() => abort.abort());
    try {
      const text = await this.app.lint.format({
        text: doc.getText(),
        connectionId: this.app.bindings.effective(doc.uri),
        cwd: cwdFor(doc),
        signal: abort.signal,
      });
      return text === doc.getText() ? [] : [vscode.TextEdit.replace(fullRange(doc), text)];
    } catch (e) {
      if (!abort.signal.aborted) void vscode.window.showErrorMessage(`Format failed: ${errorMessage(e)}`);
      return [];
    }
  }
}

/** Quick fix on sqlfluff diagnostics: apply every auto-fixable rule. */
export class SqlFixActions implements vscode.CodeActionProvider {
  static readonly metadata = { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] };

  provideCodeActions(_doc: vscode.TextDocument, _range: vscode.Range, ctx: vscode.CodeActionContext): vscode.CodeAction[] {
    const ours = ctx.diagnostics.filter((d) => d.source === 'sqlfluff');
    if (!ours.length) return [];
    const action = new vscode.CodeAction('Fix all auto-fixable issues with sqlfluff', vscode.CodeActionKind.QuickFix);
    action.diagnostics = ours;
    action.command = { command: 'betterSqlTools.fixDocument', title: 'Fix lint issues with sqlfluff' };
    return [action];
  }
}
