import * as vscode from 'vscode';
import type { ConnectionInspection } from '../../application/connection-manager';
import { errorMessage } from '../../domain/errors';
import type { ConnectionId } from '../../domain/model';
import type { App } from './app';
import { webviewHtml } from './webview-html';

const REFRESH_MS = 10_000;

/**
 * "Inspect connection": uptime, what the core measured since connecting (statements, errors, rows, timings)
 * and whatever the driver reports about the database (version, size, settings, health checks). One panel per
 * connection; it refreshes while visible and says so when the connection goes away.
 */
export class InspectView {
  private static readonly open = new Map<ConnectionId, InspectView>();

  static show(app: App, connectionId: ConnectionId): void {
    const existing = InspectView.open.get(connectionId);
    if (existing) existing.panel.reveal();
    else new InspectView(app, connectionId);
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly subs: vscode.Disposable[] = [];
  private timer?: ReturnType<typeof setInterval>;
  private busy = false;
  private last?: ConnectionInspection;

  private constructor(
    private readonly app: App,
    private readonly id: ConnectionId,
  ) {
    const media = vscode.Uri.joinPath(app.context.extensionUri, 'media');
    const name = app.connections.info(id)?.profile.name ?? id;
    this.panel = vscode.window.createWebviewPanel('betterSqlTools.inspect', `Inspect: ${name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [media],
    });
    this.panel.iconPath = vscode.Uri.joinPath(media, 'icon.svg');
    this.subs.push(
      this.panel.webview.onDidReceiveMessage((m) => void this.onMessage(m)),
      app.connections.onDidChange((e) => {
        if (e.id === id) void this.refresh();
      }),
    );
    this.panel.webview.html = webviewHtml(this.panel.webview, app.context.extensionUri, 'inspect', 'Inspect connection');
    this.timer = setInterval(() => {
      if (this.panel.visible) void this.refresh();
    }, REFRESH_MS);
    this.panel.onDidDispose(() => {
      clearInterval(this.timer);
      this.subs.forEach((s) => s.dispose());
      InspectView.open.delete(id);
    });
    InspectView.open.set(id, this);
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: { type?: string }): Promise<void> {
    switch (m?.type) {
      case 'ready':
      case 'refresh':
        return this.refresh();
      case 'copy':
        if (this.last) {
          await vscode.env.clipboard.writeText(JSON.stringify(this.last, null, 2));
          void vscode.window.setStatusBarMessage('Copied the inspection as JSON.', 2500);
        }
    }
  }

  private async refresh(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    try {
      this.last = await this.app.connections.inspect(this.id);
      this.post({ type: 'inspection', data: this.last });
    } catch (e) {
      this.last = undefined;
      this.post({ type: 'unavailable', message: errorMessage(e) });
    } finally {
      this.busy = false;
    }
  }
}
