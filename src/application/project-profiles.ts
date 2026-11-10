import { ProjectManagedError } from '../domain/errors';
import type { ConnectionId, ConnectionProfile } from '../domain/model';
import { Emitter, type Disposable } from './events';
import type { ProfileRepository } from './ports';
import type { ProjectConfigService } from './project-config-service';

type ProjectView = Pick<ProjectConfigService, 'current' | 'onDidChange'>;

/**
 * Settings-backed profiles plus the connections a project's TOML files define. Project connections are
 * read-only here: changing or deleting one means editing the file, so those calls throw ProjectManagedError.
 */
export class ProjectAwareProfiles implements ProfileRepository, Disposable {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly subs: Disposable[];

  constructor(
    private readonly stored: ProfileRepository,
    private readonly project: ProjectView,
  ) {
    const fire = () => this.changed.fire();
    this.subs = [stored.onDidChange(fire), project.onDidChange(fire)];
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
  }

  list(): ConnectionProfile[] {
    const mine = this.stored.list();
    const taken = new Set(mine.map((p) => p.id));
    return [...mine, ...this.project.current().connections.filter((p) => !taken.has(p.id))];
  }

  async save(profile: ConnectionProfile): Promise<void> {
    this.guard(profile.id, profile.scope, profile.name);
    await this.stored.save(profile);
  }

  async remove(id: ConnectionId): Promise<void> {
    this.guard(id);
    await this.stored.remove(id);
  }

  private guard(id: ConnectionId, scope?: string, name?: string): void {
    const own = this.project.current().connections.find((c) => c.id === id);
    if (own || scope === 'project') throw new ProjectManagedError(`Connection "${own?.name ?? name ?? id}"`, own?.file);
  }
}
