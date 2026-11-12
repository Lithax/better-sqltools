import { suggestBookmarkName } from '../domain/bookmark';
import type { Bookmark, ConnectionId } from '../domain/model';
import type { Event } from './events';
import type { BookmarkRepository } from './ports';

export interface NewBookmark {
  sql: string;
  /** Left out or blank: taken from the SQL. */
  name?: string;
  connectionId?: ConnectionId;
}

/** Saved queries: what to call them, what order they come in, and which rules a bookmark must obey. */
export class BookmarkService {
  readonly onDidChange: Event<void>;

  constructor(
    private readonly repo: BookmarkRepository,
    private readonly now: () => number = Date.now,
  ) {
    this.onDidChange = repo.onDidChange;
  }

  /** By name (ignoring case), then oldest first. */
  list(): Bookmark[] {
    return [...this.repo.list()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }) || a.createdAt - b.createdAt);
  }

  get(id: string): Bookmark | undefined {
    return this.repo.list().find((b) => b.id === id);
  }

  async add(input: NewBookmark): Promise<Bookmark> {
    const sql = input.sql.trim();
    if (!sql) throw new Error('There is nothing to bookmark.');
    const createdAt = this.now();
    const bookmark: Bookmark = {
      id: `${createdAt}-${Math.random().toString(36).slice(2, 8)}`,
      name: input.name?.trim() || suggestBookmarkName(sql),
      sql,
      ...(input.connectionId ? { connectionId: input.connectionId } : {}),
      createdAt,
    };
    await this.repo.save([...this.repo.list(), bookmark]);
    return bookmark;
  }

  async rename(id: string, name: string): Promise<void> {
    const trimmed = name.trim();
    if (!trimmed) throw new Error('A bookmark needs a name.');
    await this.change(id, (b) => ({ ...b, name: trimmed }));
  }

  async remove(id: string): Promise<void> {
    const all = this.repo.list();
    if (all.some((b) => b.id === id)) await this.repo.save(all.filter((b) => b.id !== id));
  }

  /** Drops every bookmark. */
  async clear(): Promise<void> {
    await this.repo.save([]);
  }

  private async change(id: string, fn: (b: Bookmark) => Bookmark): Promise<void> {
    const all = this.repo.list();
    if (!all.some((b) => b.id === id)) throw new Error('That bookmark no longer exists.');
    await this.repo.save(all.map((b) => (b.id === id ? fn(b) : b)));
  }
}
