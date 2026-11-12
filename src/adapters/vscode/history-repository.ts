import type * as vscode from 'vscode';
import { Emitter } from '../../application/events';
import type { HistoryRepository } from '../../application/ports';
import type { HistoryEntry } from '../../domain/model';

const KEY = 'betterSqlTools.history';

export class VsCodeHistory implements HistoryRepository {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(
    private readonly state: vscode.Memento,
    private readonly limit: () => number,
  ) {}

  list(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(KEY, []);
  }

  async add(entry: HistoryEntry): Promise<void> {
    await this.state.update(KEY, [entry, ...this.list()].slice(0, this.limit()));
    this.changed.fire();
  }

  async remove(id: string): Promise<void> {
    const all = this.list();
    if (!all.some((e) => e.id === id)) return;
    await this.state.update(KEY, all.filter((e) => e.id !== id));
    this.changed.fire();
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, []);
    this.changed.fire();
  }
}
