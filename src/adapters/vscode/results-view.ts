import * as os from 'node:os';
import * as path from 'node:path';
import * as vscode from 'vscode';
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
}

/** The "Results" view in the bottom panel. State lives here so the page can be rebuilt at any time. */
export class ResultsView implements vscode.WebviewViewProvider, vscode.Disposable {
  static readonly viewId = 'betterSqlTools.results';

  private view?: vscode.WebviewView;
  private state: ViewState = { status: 'idle' };
  private abort?: AbortController;
  private readonly sub: vscode.Disposable;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly settings: ResultsSettings,
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
      }
    } catch (e) {
      void vscode.window.showErrorMessage(`Results: ${e instanceof Error ? e.message : String(e)}`);
    }
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
