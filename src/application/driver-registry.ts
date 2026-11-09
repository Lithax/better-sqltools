import { BetterSqlToolsError, DriverNotFoundError, ValidationError, errorMessage } from '../domain/errors';
import type { DriverDescriptor } from '../domain/driver-descriptor';
import { validateDescriptor } from '../domain/validation';
import { Emitter, type Disposable } from './events';
import type { DriverFactory } from './ports';

/**
 * Asked to load the extension that provides driver `id`. Resolves true when it found and
 * activated one. The registry then waits for that extension to register its factory.
 */
export type DriverActivator = (id: string) => Promise<boolean>;

/** Where drivers meet the core. Every driver is a plugin that registers itself through the same door. */
export class DriverRegistry {
  private readonly factories = new Map<string, DriverFactory>();
  private readonly changed = new Emitter<void>();
  private activator?: DriverActivator;
  readonly onDidChange = this.changed.event;

  setActivator(activator: DriverActivator | undefined): void {
    this.activator = activator;
  }

  register(factory: DriverFactory): Disposable {
    const problems = validateDescriptor(factory.descriptor);
    if (problems.length) throw new ValidationError(problems);
    const id = factory.descriptor.id;
    if (this.factories.has(id)) {
      throw new BetterSqlToolsError(`A driver with id "${id}" is already registered.`, 'DRIVER_DUPLICATE');
    }
    this.factories.set(id, factory);
    this.changed.fire();
    return {
      dispose: () => {
        if (this.factories.get(id) === factory) {
          this.factories.delete(id);
          this.changed.fire();
        }
      },
    };
  }

  get(id: string): DriverFactory | undefined {
    return this.factories.get(id);
  }

  require(id: string): DriverFactory {
    const f = this.factories.get(id);
    if (!f) throw new DriverNotFoundError(id);
    return f;
  }

  /**
   * Like `require`, but loads the driver's extension first when it is installed and has not
   * registered yet. This is what makes drivers lazy plugins.
   */
  async ensure(id: string, waitMs = 10_000): Promise<DriverFactory> {
    const have = this.factories.get(id);
    if (have) return have;

    let detail: string | undefined;
    let activated = false;
    if (this.activator) {
      try {
        activated = await this.activator(id);
      } catch (e) {
        detail = errorMessage(e);
      }
    }
    const after = this.factories.get(id);
    if (after) return after;
    if (activated) {
      // activate() has returned, but an extension may register a moment later
      const late = await this.waitFor(id, waitMs);
      if (late) return late;
      detail = 'its extension is active but never registered it';
    }
    throw new DriverNotFoundError(id, detail);
  }

  list(): DriverDescriptor[] {
    return [...this.factories.values()]
      .map((f) => f.descriptor)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  private waitFor(id: string, ms: number): Promise<DriverFactory | undefined> {
    return new Promise((resolve) => {
      let sub: Disposable | undefined;
      const timer = setTimeout(() => {
        sub?.dispose();
        resolve(undefined);
      }, ms);
      sub = this.onDidChange(() => {
        const f = this.factories.get(id);
        if (!f) return;
        clearTimeout(timer);
        sub?.dispose();
        resolve(f);
      });
    });
  }
}
