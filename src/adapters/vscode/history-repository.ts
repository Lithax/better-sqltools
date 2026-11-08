import type * as vscode from 'vscode';
import type { HistoryRepository } from '../../application/ports';
import type { HistoryEntry } from '../../domain/model';

const KEY = 'betterSqlTools.history';

export class VsCodeHistory implements HistoryRepository {
  constructor(
    private readonly state: vscode.Memento,
    private readonly limit: () => number,
  ) {}

  list(): HistoryEntry[] {
    return this.state.get<HistoryEntry[]>(KEY, []);
  }

  async add(entry: HistoryEntry): Promise<void> {
    await this.state.update(KEY, [entry, ...this.list()].slice(0, this.limit()));
  }

  async clear(): Promise<void> {
    await this.state.update(KEY, []);
  }
}
