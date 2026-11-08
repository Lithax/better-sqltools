import * as vscode from 'vscode';
import { Emitter } from '../../application/events';
import type { ProfileRepository } from '../../application/ports';
import type { ConnectionId, ConnectionProfile, ProfileScope } from '../../domain/model';

const SECTION = 'betterSqlTools';
const KEY = 'connections';

/** The shape written to settings.json. Hand-written entries may omit `id`. */
interface Stored {
  id?: string;
  name: string;
  driver: string;
  options?: Record<string, unknown>;
}

export const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'connection';
const idOf = (p: Stored) => p.id ?? slug(p.name);

/**
 * Profiles live in `betterSqlTools.connections`, in user or workspace settings, so they sync,
 * diff and commit like any other setting. Passwords never get here.
 */
export class SettingsProfileRepository implements ProfileRepository, vscode.Disposable {
  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;
  // list() sits on hot paths (completion, CodeLens, tree, status bar), so it is cached until settings change
  private cache?: ConnectionProfile[];
  private readonly subs = [
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration(`${SECTION}.${KEY}`)) this.refresh();
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
  ];

  dispose() { this.subs.forEach((s) => s.dispose()); }

  /** Drop the cache and re-announce the list, e.g. after the workspace became trusted. */
  refresh() {
    this.cache = undefined;
    this.emitter.fire();
  }

  private read(scope: ProfileScope): Stored[] {
    const i = vscode.workspace.getConfiguration(SECTION).inspect<Stored[]>(KEY);
    const v = scope === 'user' ? i?.globalValue : i?.workspaceValue;
    return Array.isArray(v) ? [...v] : [];
  }

  private async write(scope: ProfileScope, items: Stored[]) {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(KEY, items.length ? items : undefined, scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  }

  list(): ConnectionProfile[] {
    return (this.cache ??= this.load());
  }

  private load(): ConnectionProfile[] {
    const out: ConnectionProfile[] = [];
    const seen = new Set<string>();
    for (const scope of ['user', 'workspace'] as const) {
      for (const p of this.read(scope)) {
        if (!p || typeof p.name !== 'string' || typeof p.driver !== 'string') continue;
        let id = idOf(p);
        while (seen.has(id)) id += '_';
        seen.add(id);
        out.push({ id, name: p.name, driver: p.driver, options: { ...(p.options ?? {}) }, scope });
      }
    }
    return out;
  }

  async save(profile: ConnectionProfile): Promise<void> {
    const scope = profile.scope ?? 'user';
    const stored: Stored = { id: profile.id, name: profile.name, driver: profile.driver, options: profile.options };
    const mine = this.read(scope);
    const at = mine.findIndex((p) => idOf(p) === profile.id);
    if (at >= 0) mine[at] = stored;
    else mine.push(stored);
    await this.write(scope, mine);
    this.cache = undefined;

    // Editing may have moved the profile between user and workspace settings.
    const other: ProfileScope = scope === 'user' ? 'workspace' : 'user';
    const theirs = this.read(other);
    const rest = theirs.filter((p) => idOf(p) !== profile.id);
    if (rest.length !== theirs.length) await this.write(other, rest);
    this.cache = undefined;
  }

  async remove(id: ConnectionId): Promise<void> {
    for (const scope of ['user', 'workspace'] as const) {
      const items = this.read(scope);
      const rest = items.filter((p) => idOf(p) !== id);
      if (rest.length !== items.length) await this.write(scope, rest);
    }
    this.cache = undefined;
  }
}
