import * as vscode from 'vscode';
import type { App } from './app';

/** The connection of the active SQL editor, bottom left. Click to change it. */
export class ConnectionStatusBar implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  private readonly subs: { dispose(): void };

  constructor(private readonly app: Pick<App, 'bindings' | 'connections'>) {
    const update = () => this.update();
    const all = [
      this.item,
      vscode.window.onDidChangeActiveTextEditor(update),
      app.bindings.onDidChange(update),
      app.connections.onDidChange(update),
    ];
    this.subs = { dispose: () => all.forEach((d) => d.dispose()) };
    this.item.command = 'betterSqlTools.selectConnection';
    this.update();
  }

  dispose() { this.subs.dispose(); }

  private update() {
    const doc = vscode.window.activeTextEditor?.document;
    if (!doc || doc.languageId !== 'sql') {
      this.item.hide();
      return;
    }
    const id = this.app.bindings.effective(doc.uri);
    const info = id ? this.app.connections.info(id) : undefined;
    if (!info) {
      this.item.text = '$(plug) No connection';
      this.item.tooltip = 'Choose a connection for this editor';
    } else {
      const icon = info.state === 'connected' ? '$(database)' : info.state === 'connecting' ? '$(loading~spin)' : info.state === 'error' ? '$(error)' : '$(circle-slash)';
      this.item.text = `${icon} ${info.profile.name}`;
      this.item.tooltip = `${info.descriptor?.displayName ?? info.profile.driver} · ${info.state}${info.error ? `\n${info.error}` : ''}\nClick to change connection`;
    }
    this.item.show();
  }
}
