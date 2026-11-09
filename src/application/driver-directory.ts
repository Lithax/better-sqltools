import type { DriverDescriptor, DriverIcon } from '../domain/driver-descriptor';
import { errorMessage } from '../domain/errors';
import type { DriverRegistry } from './driver-registry';
import { Emitter } from './events';
import type { DriverExtensionHost, Logger } from './ports';

/**
 * ready    - the driver registered its factory and can be used
 * inactive - its extension is installed but has not registered yet
 * failed   - its extension is installed but threw while activating
 */
export type DriverState = 'ready' | 'inactive' | 'failed';

/** One driver as the UI sees it: what is registered plus what is merely installed. */
export interface DriverEntry {
  id: string;
  displayName: string;
  description?: string;
  version?: string;
  icon?: DriverIcon;
  /** Folder URI (as a string) that relative icon paths are resolved against. */
  iconBase?: string;
  extensionId?: string;
  state: DriverState;
  error?: string;
  /** Only when `state` is `ready`. */
  descriptor?: DriverDescriptor;
}

/**
 * The merged view of drivers: registered ones come from the DriverRegistry, installed-but-quiet ones
 * from the host's extension manifests. Also the thing that wakes driver extensions up.
 */
export class DriverDirectory {
  private readonly failures = new Map<string, string>(); // extensionId -> message
  private readonly pending = new Map<string, Promise<void>>(); // extensionId -> activation, so each is woken once
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly registry: DriverRegistry,
    private readonly host: DriverExtensionHost,
    private readonly logger: Logger,
  ) {
    registry.onDidChange(() => this.changed.fire());
    host.onDidChange(() => {
      this.changed.fire();
      void this.activateNew(); // a driver installed while the editor runs
    });
    registry.setActivator((id) => this.activateFor(id));
  }

  list(): DriverEntry[] {
    const installed = new Map(this.host.list().map((d) => [d.id, d]));
    const out = new Map<string, DriverEntry>();
    for (const d of this.registry.list()) {
      const inst = installed.get(d.id);
      out.set(d.id, {
        id: d.id,
        displayName: d.displayName,
        description: d.description,
        version: d.version ?? inst?.version,
        icon: d.icon ?? inst?.icon,
        iconBase: inst?.baseUri,
        extensionId: inst?.extensionId,
        state: 'ready',
        descriptor: d,
      });
    }
    for (const [id, inst] of installed) {
      if (out.has(id)) continue;
      const error = this.failures.get(inst.extensionId);
      out.set(id, {
        id,
        displayName: inst.name,
        description: inst.description,
        version: inst.version,
        icon: inst.icon,
        iconBase: inst.baseUri,
        extensionId: inst.extensionId,
        state: error ? 'failed' : 'inactive',
        error,
      });
    }
    return [...out.values()].sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  get(id: string): DriverEntry | undefined {
    return this.list().find((d) => d.id === id);
  }

  /** Wakes every installed driver extension. Call it after activation, never from inside it. */
  async activateAll(): Promise<void> {
    const ids = [...new Set(this.host.list().map((d) => d.extensionId))];
    await Promise.allSettled(ids.map((id) => this.activateExtension(id)));
  }

  private async activateNew(): Promise<void> {
    const ids = new Set(this.host.list().map((d) => d.extensionId));
    await Promise.allSettled([...ids].filter((id) => !this.pending.has(id)).map((id) => this.activateExtension(id)));
  }

  private async activateFor(driverId: string): Promise<boolean> {
    const inst = this.host.list().find((d) => d.id === driverId);
    if (!inst) return false;
    await this.activateExtension(inst.extensionId);
    return true;
  }

  /** Wakes an extension at most once; a failed one may be tried again on the next request. */
  private activateExtension(extensionId: string): Promise<void> {
    let p = this.pending.get(extensionId);
    if (!p) {
      p = this.host.activate(extensionId).then(
        () => {
          if (this.failures.delete(extensionId)) this.changed.fire();
        },
        (e) => {
          this.pending.delete(extensionId);
          this.failures.set(extensionId, errorMessage(e));
          this.logger.error(`Driver extension ${extensionId} failed to activate: ${errorMessage(e)}`);
          this.changed.fire();
          throw e;
        },
      );
      this.pending.set(extensionId, p);
    }
    return p;
  }
}
