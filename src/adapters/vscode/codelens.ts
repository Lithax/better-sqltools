import * as vscode from 'vscode';
import { splitStatements } from '../../domain/sql/splitter';
import { tokenizerOptions } from '../../domain/sql/tokenizer';
import type { App } from './app';

const MAX_CHARS = 500_000;

/** "Run" above each statement, plus the connection the editor is bound to on line one. */
export class SqlCodeLensProvider implements vscode.CodeLensProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeCodeLenses = this.emitter.event;
  private readonly subs: { dispose(): void }[];

  constructor(private readonly app: Pick<App, 'bindings' | 'connections' | 'settings'>) {
    const fire = () => this.emitter.fire();
    this.subs = [
      this.emitter,
      app.bindings.onDidChange(fire),
      app.connections.onDidChange(fire),
      vscode.workspace.onDidChangeConfiguration((e) => e.affectsConfiguration('betterSqlTools.codeLens') && fire()),
    ];
  }

  dispose() { this.subs.forEach((s) => s.dispose()); }

  provideCodeLenses(doc: vscode.TextDocument): vscode.CodeLens[] {
    if (!this.app.settings.codeLensEnabled()) return [];
    const text = doc.getText();
    if (text.length > MAX_CHARS) return [];

    const id = this.app.bindings.effective(doc.uri);
    const info = id ? this.app.connections.info(id) : undefined;
    const top = new vscode.Range(0, 0, 0, 0);
    const lenses = [
      new vscode.CodeLens(top, {
        title: info ? `$(database) ${info.profile.name}` : '$(plug) Select connection',
        tooltip: 'Choose the connection this editor runs against',
        command: 'betterSqlTools.selectConnection',
      }),
    ];
    for (const st of splitStatements(text, tokenizerOptions(info?.descriptor?.dialect))) {
      const p = doc.positionAt(st.start);
      lenses.push(
        new vscode.CodeLens(new vscode.Range(p, p), {
          title: '$(play) Run',
          tooltip: 'Run this statement',
          command: 'betterSqlTools.runStatement',
          arguments: [doc.uri, st.start],
        }),
      );
    }
    return lenses;
  }
}
