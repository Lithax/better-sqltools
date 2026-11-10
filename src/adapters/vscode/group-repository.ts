import * as vscode from 'vscode';
import { Emitter } from '../../application/events';
import type { GroupRepository, StoredGroup } from '../../application/ports';
import type { ConnectionGroup } from '../../domain/model';
import { toGroupId } from '../../domain/project-config';

const SECTION = 'betterSqlTools';
const KEY = 'groups';
type Scope = 'user' | 'workspace';

const text = (v: unknown): string | undefined => (typeof v === 'string' && v.trim() ? v : undefined);

/** Groups live in `betterSqlTools.groups`, in user or workspace settings, next to the connections. */
export class SettingsGroupRepository implements GroupRepository, vscode.Disposable {
  private readonly emitter = new Emitter<void>();
  readonly onDidChange = this.emitter.event;
  private cache?: StoredGroup[];
  private readonly sub = vscode.workspace.onDidChangeConfiguration((e) => {
    if (e.affectsConfiguration(`${SECTION}.${KEY}`)) {
      this.cache = undefined;
      this.emitter.fire();
    }
  });

  dispose() { this.sub.dispose(); }

  private read(scope: Scope): ConnectionGroup[] {
    const i = vscode.workspace.getConfiguration(SECTION).inspect<ConnectionGroup[]>(KEY);
    const v = scope === 'user' ? i?.globalValue : i?.workspaceValue;
    return Array.isArray(v) ? [...v] : [];
  }

  private async write(scope: Scope, items: ConnectionGroup[]) {
    await vscode.workspace
      .getConfiguration(SECTION)
      .update(KEY, items.length ? items : undefined, scope === 'user' ? vscode.ConfigurationTarget.Global : vscode.ConfigurationTarget.Workspace);
  }

  list(): StoredGroup[] {
    return (this.cache ??= this.load());
  }

  private load(): StoredGroup[] {
    const out: StoredGroup[] = [];
    const seen = new Set<string>();
    for (const scope of ['user', 'workspace'] as const) {
      for (const g of this.read(scope)) {
        const raw = text(g?.id);
        if (!raw) continue;
        const id = toGroupId(raw);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ id, name: text(g.name) ?? id, description: text(g.description), icon: text(g.icon), color: text(g.color), scope });
      }
    }
    return out;
  }

  async save(group: ConnectionGroup, scope: Scope): Promise<void> {
    const clean = Object.fromEntries(Object.entries(group).filter(([, v]) => v !== undefined)) as unknown as ConnectionGroup;
    const mine = this.read(scope);
    const at = mine.findIndex((g) => toGroupId(g.id) === group.id);
    if (at >= 0) mine[at] = clean;
    else mine.push(clean);
    await this.write(scope, mine);
    this.cache = undefined;

    // editing may have moved it between user and workspace settings
    const other: Scope = scope === 'user' ? 'workspace' : 'user';
    const theirs = this.read(other);
    const rest = theirs.filter((g) => toGroupId(g.id) !== group.id);
    if (rest.length !== theirs.length) await this.write(other, rest);
    this.cache = undefined;
  }

  async remove(id: string): Promise<void> {
    for (const scope of ['user', 'workspace'] as const) {
      const items = this.read(scope);
      const rest = items.filter((g) => toGroupId(g.id) !== id);
      if (rest.length !== items.length) await this.write(scope, rest);
    }
    this.cache = undefined;
  }
}
