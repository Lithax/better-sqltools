import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import type { EditService, EditSession } from '../../application/edit-service';
import { toCsv, toJson, toTsv } from '../../domain/export';
import type { Cell, Column, RunResult } from '../../domain/model';
import type { ColumnFit, ResultsPrefs } from './settings';
import { webviewHtml } from './webview-html';

export type ViewState =
  | { status: 'idle' }
  | { status: 'running'; connection: string; sql: string; startedAt: number }
  | { status: 'done'; result: RunResult }
  | { status: 'error'; connection: string; message: string };

/** What the view needs from the settings: how to look, and a way to remember the column-fit choice. */
export interface ResultsSettings {
  resultsPrefs(): ResultsPrefs;
  setResultsColumnFit(mode: ColumnFit): Promise<void>;
}

const FORMATS = { csv: { label: 'CSV', build: toCsv }, json: { label: 'JSON', build: toJson }, tsv: { label: 'tab-separated text', build: toTsv } } as const;
type Format = keyof typeof FORMATS;
const isFormat = (f: unknown): f is Format => typeof f === 'string' && Object.prototype.hasOwnProperty.call(FORMATS, f);
const FITS: readonly string[] = ['fitAll', 'fitName', 'fitNameAndValue'];

interface PageMessage {
  type?: string;
  text?: string;
  format?: string;
  action?: string;
  index?: number;
  /** Row indexes in the order the page shows them: what is left after filtering, in the sort order. */
  rows?: unknown;
  mode?: string;
  /** An edit: the cell (as indexes into the statement's own rows and columns) and what was typed; null means NULL. */
  row?: number;
  col?: number;
  value?: string | null;
  /** Lets the page match a reply to the edit it sent. */
  id?: number;
}

/** The "Results" view in the bottom panel. State lives here so the page can be rebuilt at any time. */
export class ResultsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'betterSqlTools.results';

  private view?: vscode.WebviewView;
  private state: ViewState = { status: 'idle' };
  private abort?: AbortController;
  private readonly sub: vscode.Disposable;
  /** The editing of each statement of the result on show, by statement index. */
  private sessions = new Map<number, EditSession>();
  private openToken = 0;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly settings: ResultsSettings,
    private readonly edits: EditService,
  ) {
    this.sub = vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('betterSqlTools.results')) this.refreshSettings();
    });
  }

  dispose(): void {
    this.sub.dispose();
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, 'media')],
    };
    view.webview.onDidReceiveMessage((m) => this.onMessage(m)); // before the page can load and say `ready`
    view.webview.html = webviewHtml(view.webview, this.extensionUri, 'results', 'Results');
    view.onDidDispose(() => {
      if (this.view === view) this.view = undefined;
    });
  }

  /** Shows the panel without stealing focus from the editor when it already exists. */
  async reveal(): Promise<void> {
    if (this.view) this.view.show(true);
    else await vscode.commands.executeCommand(`${ResultsView.viewId}.focus`);
  }

  showRunning(connection: string, sql: string, abort: AbortController) {
    this.abort = abort;
    this.forgetEditing();
    this.set({ status: 'running', connection, sql, startedAt: Date.now() });
  }
  showResult(result: RunResult) {
    this.abort = undefined;
    this.forgetEditing();
    this.set({ status: 'done', result });
    void this.openEditing(result);
  }
  showError(connection: string, message: string) {
    this.abort = undefined;
    this.forgetEditing();
    this.set({ status: 'error', connection, message });
  }
  showIdle() {
    this.abort = undefined;
    this.forgetEditing();
    this.set({ status: 'idle' });
  }

  /**
   * Called before anything replaces the result on show. Edits that were not committed are not lost silently: the person
   * chooses to commit them or roll them back, or to cancel and keep working. Returns false on cancel.
   */
  async resolvePending(): Promise<boolean> {
    const waiting = [...this.sessions.entries()].filter(([, s]) => s.status().pending.length > 0);
    if (!waiting.length) return true;
    const total = waiting.reduce((n, [, s]) => n + s.status().pending.length, 0);
    const commit = 'Commit';
    const choice = await vscode.window.showWarningMessage(
      `${total} ${total === 1 ? 'edit is' : 'edits are'} not committed yet.`,
      { modal: true, detail: 'Commit them to keep them, or roll them back to undo them. Cancel leaves everything as it is.' },
      commit,
      'Roll back',
    );
    if (!choice) return false;
    for (const [index] of waiting) {
      if (!(await this.endEdits(index, choice === commit ? 'commit' : 'rollback'))) return false;
    }
    return true;
  }

  private forgetEditing() {
    this.openToken++;
    this.sessions = new Map();
  }

  /** Works out, for each statement of a new result, what can be edited. Nothing is changed by doing so. */
  private async openEditing(result: RunResult): Promise<void> {
    const token = this.openToken;
    const mode = this.settings.resultsPrefs().editMode;
    for (const s of result.statements) {
      if (s.error || !s.columns.length) continue;
      try {
        const session = await this.edits.open(result.connectionId, s, mode);
        if (token !== this.openToken) return; // a newer result replaced this one meanwhile
        this.sessions.set(s.index, session);
        this.postEditStatus(s.index);
      } catch {
        // without editing information the result simply stays read-only
      }
    }
  }

  private postEditStatus(index: number) {
    const session = this.sessions.get(index);
    if (session) void this.view?.webview.postMessage({ type: 'editStatus', index, status: session.status() });
  }

  /** The look-and-feel settings changed (in VS Code's settings or a project's TOML file). */
  refreshSettings(): void {
    void this.view?.webview.postMessage({ type: 'settings', settings: this.settings.resultsPrefs() });
  }

  private set(state: ViewState) {
    this.state = state;
    this.post();
  }

  private post() {
    void this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  private async onMessage(m: PageMessage): Promise<void> {
    try {
      switch (m?.type) {
        case 'ready':
          this.refreshSettings();
          this.post();
          for (const index of this.sessions.keys()) this.postEditStatus(index);
          break;
        case 'cancel':
          this.abort?.abort();
          break;
        case 'copy': // a cell
          await vscode.env.clipboard.writeText(String(m.text ?? ''));
          break;
        case 'export':
          await this.export(isFormat(m.format) ? m.format : 'csv', m.action === 'save' ? 'save' : 'copy', Number(m.index), m.rows);
          break;
        case 'setColumnFit':
          if (typeof m.mode === 'string' && FITS.includes(m.mode)) await this.settings.setResultsColumnFit(m.mode as ColumnFit);
          break;
        case 'edit':
          await this.editCell(m);
          break;
        case 'commit':
        case 'rollback':
          await this.endEdits(Number(m.index), m.type);
          break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Results: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  /** The page asked to change one cell. The reply says what the cell holds now, or why the edit was refused. */
  private async editCell(m: PageMessage): Promise<void> {
    const index = Number(m.index);
    const reply = (outcome: object) =>
      void this.view?.webview.postMessage({ type: 'editResult', id: m.id, index, row: m.row, col: m.col, ...outcome });
    const session = this.sessions.get(index);
    if (!session) return reply({ ok: false, error: 'This result is no longer open for editing. Run the query again.' });
    if (m.value !== null && typeof m.value !== 'string') return reply({ ok: false, error: 'There is nothing to store.' });
    reply(await session.edit(Number(m.row), Number(m.col), m.value));
    this.postEditStatus(index);
  }

  /** Commits or rolls back the pending edits of one statement's result; the page learns which cells went back. */
  private async endEdits(index: number, kind: 'commit' | 'rollback'): Promise<boolean> {
    const session = this.sessions.get(index);
    if (!session) return false;
    const outcome = kind === 'commit' ? await session.commit() : await session.rollback();
    void this.view?.webview.postMessage({ type: 'editEnd', index, kind, ...outcome });
    this.postEditStatus(index);
    const noun = (n: number) => `${n} ${n === 1 ? 'edit' : 'edits'}`;
    if (!outcome.ok) void vscode.window.showErrorMessage(`${kind === 'commit' ? 'Commit' : 'Roll back'} failed: ${outcome.error}`);
    else if (outcome.count) void vscode.window.setStatusBarMessage(`${kind === 'commit' ? 'Committed' : 'Rolled back'} ${noun(outcome.count)}`, 3000);
    return outcome.ok;
  }

  /** The rows the page asked for, in its order; everything when it did not say. Anything that is not a row is ignored. */
  private pick(rows: Cell[][], wanted: unknown): Cell[][] {
    if (!Array.isArray(wanted)) return rows;
    return wanted.filter((i): i is number => Number.isInteger(i) && i >= 0 && i < rows.length).map((i) => rows[i]);
  }

  private async export(format: Format, action: 'copy' | 'save', index: number, wanted: unknown) {
    if (this.state.status !== 'done') return;
    const s = this.state.result.statements.find((x) => x.index === index);
    if (!s || !s.columns.length) return;
    const rows = this.pick(s.rows, wanted);
    const text = FORMATS[format].build(s.columns as Column[], rows);
    const count = `${rows.length} ${rows.length === 1 ? 'row' : 'rows'}`;

    if (action === 'copy') {
      await vscode.env.clipboard.writeText(text);
      void vscode.window.setStatusBarMessage(`Copied ${count} as ${FORMATS[format].label}`, 3000);
      return;
    }

    const name = `result-${index + 1}.${format}`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(path.join(os.homedir(), name)),
      filters: { [FORMATS[format].label]: [format === 'tsv' ? 'tsv' : format] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));

    const note = s.truncated ? ' (the result was cut at the row limit)' : '';
    const pick = await vscode.window.showInformationMessage(`Saved ${count} to ${path.basename(uri.fsPath)}${note}.`, 'Open');
    if (pick === 'Open') await vscode.commands.executeCommand('vscode.open', uri);
  }
}
