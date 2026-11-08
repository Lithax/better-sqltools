import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { toCsv, toJson } from '../../domain/export';
import type { RunResult } from '../../domain/model';
import { webviewHtml } from './webview-html';

export type ViewState =
  | { status: 'idle' }
  | { status: 'running'; connection: string; sql: string; startedAt: number }
  | { status: 'done'; result: RunResult }
  | { status: 'error'; connection: string; message: string };

/** The "Results" view in the bottom panel. State lives here so the page can be rebuilt at any time. */
export class ResultsView implements vscode.WebviewViewProvider {
  static readonly viewId = 'betterSqlTools.results';

  private view?: vscode.WebviewView;
  private state: ViewState = { status: 'idle' };
  private abort?: AbortController;

  constructor(private readonly extensionUri: vscode.Uri) {}

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
    this.set({ status: 'running', connection, sql, startedAt: Date.now() });
  }
  showResult(result: RunResult) {
    this.abort = undefined;
    this.set({ status: 'done', result });
  }
  showError(connection: string, message: string) {
    this.abort = undefined;
    this.set({ status: 'error', connection, message });
  }
  showIdle() {
    this.abort = undefined;
    this.set({ status: 'idle' });
  }

  private set(state: ViewState) {
    this.state = state;
    this.post();
  }

  private post() {
    void this.view?.webview.postMessage({ type: 'state', state: this.state });
  }

  private async onMessage(m: { type?: string; text?: string; format?: string; index?: number }): Promise<void> {
    try {
      switch (m?.type) {
        case 'ready':
          this.post();
          break;
        case 'cancel':
          this.abort?.abort();
          break;
        case 'copy':
          await vscode.env.clipboard.writeText(String(m.text ?? ''));
          break;
        case 'export':
          await this.export(m.format === 'json' ? 'json' : 'csv', Number(m.index));
          break;
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Results: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  private async export(format: 'csv' | 'json', index: number) {
    if (this.state.status !== 'done') return;
    const s = this.state.result.statements.find((x) => x.index === index);
    if (!s || !s.columns.length) return;

    const name = `result-${index + 1}.${format}`;
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const uri = await vscode.window.showSaveDialog({
      defaultUri: folder ? vscode.Uri.joinPath(folder, name) : vscode.Uri.file(path.join(os.homedir(), name)),
      filters: format === 'csv' ? { CSV: ['csv'] } : { JSON: ['json'] },
    });
    if (!uri) return;
    const text = format === 'csv' ? toCsv(s.columns, s.rows) : toJson(s.columns, s.rows);
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));

    const note = s.truncated ? ' (the result was cut at the row limit)' : '';
    const pick = await vscode.window.showInformationMessage(`Saved ${s.rows.length} rows to ${path.basename(uri.fsPath)}${note}.`, 'Open');
    if (pick === 'Open') await vscode.commands.executeCommand('vscode.open', uri);
  }
}
