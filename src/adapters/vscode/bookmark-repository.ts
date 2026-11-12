import type * as vscode from 'vscode';
import { Emitter } from '../../application/events';
import type { BookmarkRepository } from '../../application/ports';
import type { Bookmark } from '../../domain/model';

const KEY = 'betterSqlTools.bookmarks';

/** Bookmarks live in the extension's global state: they follow the user across workspaces. */
export class VsCodeBookmarks implements BookmarkRepository {
  private readonly changed = new Emitter<void>();
  readonly onDidChange = this.changed.event;

  constructor(private readonly state: vscode.Memento) {}

  list(): Bookmark[] {
    const stored = this.state.get<unknown>(KEY, []);
    // the state is only ever written by this class, but a hand-edited or older file must not break the view
    return Array.isArray(stored)
      ? stored.filter((b): b is Bookmark => !!b && typeof b.id === 'string' && typeof b.name === 'string' && typeof b.sql === 'string')
      : [];
  }

  async save(all: Bookmark[]): Promise<void> {
    await this.state.update(KEY, all);
    this.changed.fire();
  }
}
