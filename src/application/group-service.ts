import { ProjectManagedError } from '../domain/errors';
import type { ConnectionGroup, ConnectionId } from '../domain/model';
import { toGroupId } from '../domain/project-config';
import { Emitter, type Disposable, type Event } from './events';
import type { GroupRepository, ProfileRepository } from './ports';
import type { ProjectConfigService } from './project-config-service';

/**
 * user, workspace  saved in settings, can be changed here
 * project          defined in a project's TOML file, read-only here
 * implicit         only referenced by a connection's `group`; it exists as long as someone uses it
 */
export type GroupScope = 'user' | 'workspace' | 'project' | 'implicit';

export interface GroupInfo extends ConnectionGroup {
  scope: GroupScope;
  /** The config file, for project groups. */
  file?: string;
}

type ProjectView = Pick<ProjectConfigService, 'current' | 'onDidChange'>;

const defined = <T extends object>(o: T): Partial<T> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
const byName = (a: GroupInfo, b: GroupInfo) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.id.localeCompare(b.id);

/** Groups ("projects") that connections are filed under: the stored ones, the project files' and the implicit ones. */
export class GroupService implements Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange: Event<void> = this.changed.event;
  private readonly subs: Disposable[];

  constructor(private readonly deps: { groups: GroupRepository; project: ProjectView; profiles: ProfileRepository }) {
    const fire = () => this.changed.fire();
    this.subs = [deps.groups.onDidChange(fire), deps.project.onDidChange(fire), deps.profiles.onDidChange(fire)];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  list(): GroupInfo[] {
    const map = new Map<string, GroupInfo>();
    for (const g of this.deps.groups.list()) map.set(g.id, { ...g });
    for (const g of this.deps.project.current().groups) {
      const { file, ...rest } = g;
      // a project file refines a stored group field by field, and owns the group from then on
      map.set(g.id, { ...map.get(g.id), ...defined(rest), scope: 'project', file } as GroupInfo);
    }
    for (const p of this.deps.profiles.list()) {
      if (p.group && !map.has(p.group)) map.set(p.group, { id: p.group, name: p.group, scope: 'implicit' });
    }
    return [...map.values()].sort(byName);
  }

  get(id: string): GroupInfo | undefined {
    return this.list().find((g) => g.id === id);
  }

  /** The id of the group called `nameOrId`; the group is created when there is none. */
  async ensure(nameOrId: string, scope: 'user' | 'workspace' = 'user'): Promise<string> {
    const wanted = nameOrId.trim();
    const lower = wanted.toLowerCase();
    const all = this.list();
    const hit = all.find((g) => g.id === lower || g.id === toGroupId(wanted) || g.name.toLowerCase() === lower);
    if (hit) return hit.id;
    const taken = new Set(all.map((g) => g.id));
    const base = toGroupId(wanted);
    let id = base;
    for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
    await this.deps.groups.save({ id, name: wanted }, scope);
    return id;
  }

  async rename(id: string, name: string): Promise<void> {
    const g = this.get(id);
    if (!g) return;
    if (g.scope === 'project') throw new ProjectManagedError(`Group "${g.name}"`, g.file);
    const { scope, file: _file, ...def } = g;
    await this.deps.groups.save({ ...def, name: name.trim() }, scope === 'workspace' ? 'workspace' : 'user');
  }

  /** Deletes the group; its connections stay and become ungrouped. */
  async remove(id: string): Promise<void> {
    const g = this.get(id);
    if (!g) return;
    if (g.scope === 'project') throw new ProjectManagedError(`Group "${g.name}"`, g.file);
    if (g.scope !== 'implicit') await this.deps.groups.remove(id);
    for (const p of this.deps.profiles.list()) {
      if (p.group === id && p.scope !== 'project') await this.deps.profiles.save({ ...p, group: undefined });
    }
  }

  /** Files a connection under a group, or takes it out of its group with `undefined`. */
  async assign(profileId: ConnectionId, groupId: string | undefined): Promise<void> {
    const p = this.deps.profiles.list().find((x) => x.id === profileId);
    if (!p || p.group === groupId) return;
    await this.deps.profiles.save({ ...p, group: groupId });
  }
}
