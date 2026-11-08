import { randomBytes } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import { errorMessage } from '../../domain/errors';
import type { ConnectionProfile, ProfileScope } from '../../domain/model';
import { normalizeOptions } from '../../domain/validation';
import type { App } from './app';
import { slug } from './profile-repository';
import { webviewHtml } from './webview-html';

interface Draft {
  name: string;
  driver: string;
  scope: ProfileScope;
  options: Record<string, unknown>;
  secrets: Record<string, string>;
  saveSecrets: boolean;
}

/**
 * Host for the connection form page. The form is generated from the driver's connectionSchema,
 * so drivers contribute no UI code. Validation and secrets handling stay on this side.
 */
export class ConnectionForm {
  private static readonly open = new Map<string, ConnectionForm>();

  static show(app: App, opts: { profile?: ConnectionProfile; driverId?: string } = {}): void {
    const key = opts.profile?.id ?? 'new';
    const existing = ConnectionForm.open.get(key);
    if (existing) existing.panel.reveal();
    else new ConnectionForm(app, opts.profile, opts.driverId, key);
  }

  private readonly panel: vscode.WebviewPanel;

  private constructor(
    private readonly app: App,
    private readonly profile: ConnectionProfile | undefined,
    private readonly driverId: string | undefined,
    key: string,
  ) {
    const media = vscode.Uri.joinPath(app.context.extensionUri, 'media');
    this.panel = vscode.window.createWebviewPanel(
      'betterSqlTools.connectionForm',
      profile ? `Edit connection: ${profile.name}` : 'New connection',
      vscode.ViewColumn.Active,
      // retainContextWhenHidden: switching editor tabs must not throw away what has been typed
      { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media] },
    );
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m)); // before the page can load and say `ready`
    this.panel.webview.html = webviewHtml(this.panel.webview, app.context.extensionUri, 'connection-form', 'Connection');
    this.panel.onDidDispose(() => ConnectionForm.open.delete(key));
    ConnectionForm.open.set(key, this);
  }

  private post(message: unknown) {
    void this.panel.webview.postMessage(message);
  }

  private async onMessage(m: { type?: string; draft?: Draft; key?: string }): Promise<void> {
    try {
      switch (m?.type) {
        case 'ready': return await this.sendInit();
        case 'test': return await this.test(m.draft as Draft);
        case 'save': return await this.save(m.draft as Draft);
        case 'browse': return await this.browse(String(m.key));
        case 'cancel': return this.panel.dispose();
      }
    } catch (e) {
      this.app.logger.error(`Connection form: ${errorMessage(e)}`);
      this.post({ type: m?.type === 'test' ? 'testResult' : 'saveError', ok: false, message: errorMessage(e) });
    }
  }

  private async sendInit() {
    const p = this.profile;
    const drivers = this.app.registry.list();
    this.post({
      type: 'init',
      mode: p ? 'edit' : 'new',
      drivers,
      profile: {
        name: p?.name ?? '',
        driver: p?.driver ?? this.driverId ?? drivers[0]?.id ?? '',
        options: p?.options ?? {},
        scope: p?.scope ?? 'user',
      },
      storedSecrets: p ? await this.app.secrets.storedKeys(p.id) : [],
      canUseWorkspace: !!vscode.workspace.workspaceFolders?.length,
    });
  }

  private toProfile(d: Draft, id: string): ConnectionProfile {
    const desc = this.app.registry.require(d.driver).descriptor;
    const secretKeys = new Set(desc.connectionSchema.filter((f) => f.type === 'password').map((f) => f.key));
    const options: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(d.options ?? {})) {
      if (secretKeys.has(k) || v === undefined || v === null || v === '') continue;
      options[k] = v;
    }
    const scope: ProfileScope = d.scope === 'workspace' && vscode.workspace.workspaceFolders?.length ? 'workspace' : 'user';
    return { id, name: d.name.trim(), driver: d.driver, options, scope };
  }

  private async test(d: Draft) {
    const profile = this.toProfile(d, this.profile?.id ?? '__draft__');
    try {
      await this.app.connections.test({ profile, secrets: d.secrets });
      this.post({ type: 'testResult', ok: true, message: 'Connection successful.' });
    } catch (e) {
      this.post({ type: 'testResult', ok: false, message: errorMessage(e) });
    }
  }

  private async save(d: Draft) {
    const factory = this.app.registry.get(d.driver);
    if (!factory) return this.post({ type: 'saveError', message: `Driver "${d.driver}" is not installed.` });
    const desc = factory.descriptor;

    const problems: string[] = [];
    if (!d.name?.trim()) problems.push('Give the connection a name.');
    problems.push(...normalizeOptions(desc, this.toProfile(d, 'x').options).problems);
    if (problems.length) return this.post({ type: 'saveError', message: problems.join('\n') });

    let id = this.profile?.id;
    if (!id) {
      const taken = new Set(this.app.profiles.list().map((p) => p.id));
      id = slug(d.name);
      if (taken.has(id)) id += `-${randomBytes(2).toString('hex')}`;
    }
    await this.app.profiles.save(this.toProfile(d, id));

    if (desc.connectionSchema.some((f) => f.type === 'password')) {
      if (d.saveSecrets) {
        for (const f of desc.connectionSchema) {
          const v = f.type === 'password' ? d.secrets?.[f.key] : undefined;
          if (v) await this.app.secrets.set(id, f.key, v);
        }
      } else {
        await this.app.secrets.deleteAll(id);
      }
    }
    this.panel.dispose();
  }

  private async browse(key: string) {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Select' });
    const file = picked?.[0]?.fsPath;
    if (!file) return;
    // Inside the workspace, store a portable path so workspace-scoped profiles work for teammates.
    const ws = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const value = ws && file.startsWith(ws + path.sep) ? '${workspaceFolder}/' + path.relative(ws, file).split(path.sep).join('/') : file;
    this.post({ type: 'browsed', key, path: value });
  }
}
