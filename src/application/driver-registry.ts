import { BetterSqlToolsError, DriverNotFoundError, ValidationError } from '../domain/errors';
import type { DriverDescriptor } from '../domain/driver-descriptor';
import { validateDescriptor } from '../domain/validation';
import { Emitter, type Disposable } from './events';
import type { DriverFactory } from './ports';

/** Where drivers meet the core. Built-in and third-party drivers go through the same door. */
export class DriverRegistry {
  private readonly factories = new Map<string, DriverFactory>();
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

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

  list(): DriverDescriptor[] {
    return [...this.factories.values()]
      .map((f) => f.descriptor)
      .sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
}
