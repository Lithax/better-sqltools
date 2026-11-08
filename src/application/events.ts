export interface Disposable {
  dispose(): void;
}
export type Listener<T> = (e: T) => void;
export type Event<T> = (listener: Listener<T>) => Disposable;

/** Minimal typed emitter so the core needs no UI framework. */
export class Emitter<T> {
  private readonly listeners = new Set<Listener<T>>();

  readonly event: Event<T> = (listener) => {
    this.listeners.add(listener);
    return { dispose: () => void this.listeners.delete(listener) };
  };

  fire(e: T): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error('[better-sqltools] listener threw', err);
      }
    }
  }
}
