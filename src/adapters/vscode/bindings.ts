import * as vscode from 'vscode';
import type { ConnectionId } from '../../domain/model';

const KEY = 'betterSqlTools.bindings';

/**
 * Which connection each SQL editor talks to. Saved files remember it per workspace;
 * untitled editors remember it until they close.
 */
export class EditorBindings implements vscode.Disposable {
  private readonly memory = new Map<string, ConnectionId>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  readonly onDidChange = this.emitter.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly exists: (id: ConnectionId) => boolean,
    /** The connection to assume for an editor nobody chose one for (e.g. the only live connection). */
    private readonly fallback: () => ConnectionId | undefined = () => undefined,
  ) {}

  dispose() { this.emitter.dispose(); }

  private stored(): Record<string, ConnectionId> {
    return this.state.get<Record<string, ConnectionId>>(KEY, {});
  }

  get(uri: vscode.Uri): ConnectionId | undefined {
    const key = uri.toString();
    const id = this.memory.get(key) ?? (uri.scheme === 'file' ? this.stored()[key] : undefined);
    return id && this.exists(id) ? id : undefined;
  }

  /** The explicit choice, else the fallback. Use for anything that must not ask the user (completion, linting, labels). */
  effective(uri: vscode.Uri): ConnectionId | undefined {
    return this.get(uri) ?? this.fallback();
  }

  async set(uri: vscode.Uri, id: ConnectionId): Promise<void> {
    const key = uri.toString();
    this.memory.set(key, id);
    if (uri.scheme === 'file') await this.state.update(KEY, { ...this.stored(), [key]: id });
    this.emitter.fire(uri);
  }

  /** Called when connections are added, removed or edited. */
  touch() { this.emitter.fire(undefined); }
}
