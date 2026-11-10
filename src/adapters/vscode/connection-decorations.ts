import * as vscode from 'vscode';
import type { App } from './app';

export const CONNECTION_SCHEME = 'better-sqltools-connection';
export const connectionUri = (id: string): vscode.Uri => vscode.Uri.parse(`${CONNECTION_SCHEME}:/${encodeURIComponent(id)}`);

/**
 * With a driver's own icon in front of a connection the icon can no longer say whether it is connected,
 * so the state is shown the way VS Code shows Git state: a coloured label. (Connecting and failed
 * connections keep their own icons.)
 */
export class ConnectionDecorations implements vscode.FileDecorationProvider, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | vscode.Uri[] | undefined>();
  readonly onDidChangeFileDecorations = this.emitter.event;
  private readonly subs: vscode.Disposable[];

  constructor(private readonly app: Pick<App, 'connections' | 'settings'>) {
    this.subs = [
      vscode.window.registerFileDecorationProvider(this),
      app.connections.onDidChange(() => this.emitter.fire(undefined)),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('betterSqlTools.explorer')) this.emitter.fire(undefined);
      }),
    ];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.emitter.dispose();
  }

  provideFileDecoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== CONNECTION_SCHEME || !this.app.settings.explorerDriverIcons()) return undefined;
    const info = this.app.connections.info(decodeURIComponent(uri.path.replace(/^\//, '')));
    if (info?.state === 'connected') return new vscode.FileDecoration(undefined, 'Connected', new vscode.ThemeColor('charts.green'));
    return undefined;
  }
}
