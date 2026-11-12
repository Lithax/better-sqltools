import * as vscode from 'vscode';
import { suggestBookmarkName } from '../../domain/bookmark';
import type { Bookmark, ConnectionId, HistoryEntry } from '../../domain/model';
import { oneLine } from '../../domain/text';
import type { App } from './app';

/** What the history and bookmark commands borrow from the main command module. */
export interface Helpers {
  cmd(id: string, fn: (...args: any[]) => unknown): vscode.Disposable;
  openSql(connectionId: ConnectionId, content: string): Promise<void>;
  pickConnection(placeHolder: string, filter?: (state: string) => boolean): Promise<ConnectionId | undefined>;
  statementSql(doc: vscode.TextDocument, connectionId: ConnectionId | undefined): string | undefined;
}

export const HISTORY_VIEW = 'betterSqlTools.history';
export const BOOKMARKS_VIEW = 'betterSqlTools.bookmarks';
const FILTER_KEY = 'betterSqlTools.historyFilterActive';

const duration = (ms: number) => (ms < 1 ? '<1 ms' : ms < 1000 ? `${Math.round(ms)} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`);

/** A code block for a tooltip; long statements are cut so the hover stays readable. */
function sqlTooltip(sql: string, ...lines: string[]): vscode.MarkdownString {
  const text = sql.trim();
  const md = new vscode.MarkdownString();
  md.appendCodeblock(text.length > 1500 ? `${text.slice(0, 1500)}\n…` : text, 'sql');
  md.appendMarkdown(`\n\n${lines.join('  \n')}`);
  return md;
}

// ---- query history ---------------------------------------------------------------------------

export type HistoryNode =
  | { type: 'day'; key: string; label: string; entries: HistoryEntry[] }
  | { type: 'entry'; entry: HistoryEntry };

const dayKey = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Past queries, newest first, grouped by the day they ran. */
export class HistoryTree implements vscode.TreeDataProvider<HistoryNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<HistoryNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private text = '';
  private readonly sub: { dispose(): void };

  constructor(
    private readonly app: App,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.sub = app.history.onDidChange(() => this.changed.fire(undefined));
  }

  get filter(): string {
    return this.text;
  }

  setFilter(text: string): void {
    this.text = text.trim();
    this.changed.fire(undefined);
  }

  /** Entries that pass the filter: every word has to appear in the SQL or the connection's name. */
  visible(): HistoryEntry[] {
    const words = this.text.toLowerCase().split(/\s+/).filter(Boolean);
    const all = this.app.history.list();
    return words.length ? all.filter((e) => words.every((w) => `${e.sql} ${e.connectionName}`.toLowerCase().includes(w))) : all;
  }

  private dayLabel(key: string, date: Date): string {
    const today = this.now();
    if (key === dayKey(today)) return 'Today';
    const yesterday = new Date(today);
    yesterday.setDate(yesterday.getDate() - 1);
    if (key === dayKey(yesterday)) return 'Yesterday';
    return date.toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  }

  getChildren(el?: HistoryNode): HistoryNode[] {
    if (el?.type === 'day') return el.entries.map((entry) => ({ type: 'entry', entry }));
    if (el) return [];
    const days = new Map<string, HistoryNode & { type: 'day' }>();
    for (const entry of this.visible()) {
      const date = new Date(entry.at);
      const key = dayKey(date);
      let day = days.get(key);
      if (!day) days.set(key, (day = { type: 'day', key, label: this.dayLabel(key, date), entries: [] }));
      day.entries.push(entry);
    }
    return [...days.values()];
  }

  getTreeItem(el: HistoryNode): vscode.TreeItem {
    if (el.type === 'day') {
      const recent = this.getChildren().slice(0, 2).some((d) => d.type === 'day' && d.key === el.key);
      const item = new vscode.TreeItem(el.label, recent ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.Collapsed);
      item.id = `day:${el.key}`;
      item.description = `${el.entries.length} ${el.entries.length === 1 ? 'query' : 'queries'}`;
      item.contextValue = 'historyDay';
      item.iconPath = new vscode.ThemeIcon('calendar');
      return item;
    }
    const e = el.entry;
    const when = new Date(e.at);
    const item = new vscode.TreeItem(oneLine(e.sql, 100), vscode.TreeItemCollapsibleState.None);
    item.id = e.id;
    item.description = `${e.connectionName} · ${when.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })} · ${duration(e.durationMs)}`;
    item.iconPath = new vscode.ThemeIcon(e.ok ? 'check' : 'error', new vscode.ThemeColor(e.ok ? 'testing.iconPassed' : 'testing.iconFailed'));
    item.tooltip = sqlTooltip(e.sql, `**${e.connectionName}**`, `${when.toLocaleString()} · ${duration(e.durationMs)}`, e.ok ? 'Succeeded' : 'Failed');
    item.contextValue = 'historyEntry';
    item.command = { command: 'betterSqlTools.history.open', title: 'Open in Editor', arguments: [el] };
    return item;
  }

  dispose(): void {
    this.sub.dispose();
    this.changed.dispose();
  }
}

// ---- bookmarks -------------------------------------------------------------------------------

export type BookmarkNode = { type: 'bookmark'; bookmark: Bookmark };

export class BookmarksTree implements vscode.TreeDataProvider<BookmarkNode>, vscode.Disposable {
  private readonly changed = new vscode.EventEmitter<BookmarkNode | undefined>();
  readonly onDidChangeTreeData = this.changed.event;
  private readonly subs: { dispose(): void }[];

  constructor(private readonly app: App) {
    // a connection that is renamed or removed changes what a bookmark's tooltip says
    this.subs = [app.bookmarks.onDidChange(() => this.changed.fire(undefined)), app.connections.onDidChange(() => this.changed.fire(undefined))];
  }

  getChildren(el?: BookmarkNode): BookmarkNode[] {
    return el ? [] : this.app.bookmarks.list().map((bookmark) => ({ type: 'bookmark', bookmark }));
  }

  getTreeItem(el: BookmarkNode): vscode.TreeItem {
    const b = el.bookmark;
    const connection = b.connectionId ? this.app.connections.info(b.connectionId)?.profile.name : undefined;
    const item = new vscode.TreeItem(b.name, vscode.TreeItemCollapsibleState.None);
    item.id = b.id;
    item.description = oneLine(b.sql, 80);
    item.iconPath = new vscode.ThemeIcon('bookmark');
    item.tooltip = sqlTooltip(
      b.sql,
      b.connectionId ? (connection ? `Saved from **${connection}**` : 'Saved from a connection that no longer exists') : 'Not tied to a connection',
    );
    item.contextValue = 'bookmark';
    item.command = { command: 'betterSqlTools.bookmarks.open', title: 'Open in Editor', arguments: [el] };
    return item;
  }

  dispose(): void {
    this.subs.forEach((s) => s.dispose());
    this.changed.dispose();
  }
}

// ---- registration ----------------------------------------------------------------------------

export function registerHistoryAndBookmarks(app: App, h: Helpers): vscode.Disposable[] {
  const { connections, history, bookmarks } = app;
  const historyTree = new HistoryTree(app);
  const bookmarksTree = new BookmarksTree(app);
  const historyView = vscode.window.createTreeView(HISTORY_VIEW, { treeDataProvider: historyTree, showCollapseAll: true, canSelectMany: true });
  const bookmarksView = vscode.window.createTreeView(BOOKMARKS_VIEW, { treeDataProvider: bookmarksTree, canSelectMany: false });

  const showFilter = () => {
    const text = historyTree.filter;
    void vscode.commands.executeCommand('setContext', FILTER_KEY, !!text);
    historyView.description = text ? `Filter: ${text}` : undefined;
    historyView.message = text && !historyTree.visible().length ? `No queries match \u201c${text}\u201d.` : undefined;
  };
  const sub = history.onDidChange(showFilter);

  const entryOf = (n?: HistoryNode): HistoryEntry => {
    if (n?.type !== 'entry') throw new Error('Pick a query in the Query History view.');
    return n.entry;
  };
  const bookmarkOf = (n?: BookmarkNode): Bookmark => {
    if (n?.type !== 'bookmark') throw new Error('Pick a bookmark in the Bookmarks view.');
    return n.bookmark;
  };
  /** The connection a saved query ran on, else one the user picks. */
  const connectionFor = async (id: ConnectionId | undefined): Promise<ConnectionId | undefined> =>
    id && connections.info(id) ? id : h.pickConnection('That connection no longer exists. Use\u2026');
  const toast = (text: string) => void vscode.window.setStatusBarMessage(text, 3000);
  const copy = async (sql: string) => {
    await vscode.env.clipboard.writeText(sql);
    toast('Copied the query');
  };

  async function bookmarkIt(sql: string, connectionId: ConnectionId | undefined) {
    const name = await vscode.window.showInputBox({
      title: 'Bookmark this query',
      prompt: 'A name for the bookmark',
      value: suggestBookmarkName(sql),
      validateInput: (v) => (v.trim() ? undefined : 'A bookmark needs a name.'),
    });
    if (name === undefined) return;
    const saved = await bookmarks.add({ sql, name, connectionId });
    toast(`Bookmarked \u201c${saved.name}\u201d`);
  }

  return [
    historyTree, bookmarksTree, historyView, bookmarksView, sub,

    // history
    h.cmd('history.open', async (n?: HistoryNode) => {
      const e = entryOf(n);
      const id = await connectionFor(e.connectionId);
      if (id) await h.openSql(id, e.sql);
    }),
    h.cmd('history.run', async (n?: HistoryNode) => {
      const e = entryOf(n);
      const id = await connectionFor(e.connectionId);
      if (id) await app.runner.run(id, e.sql);
    }),
    h.cmd('history.copy', (n?: HistoryNode) => copy(entryOf(n).sql)),
    h.cmd('history.bookmark', (n?: HistoryNode) => {
      const e = entryOf(n);
      return bookmarkIt(e.sql, connections.info(e.connectionId) ? e.connectionId : undefined);
    }),
    h.cmd('history.delete', async (n?: HistoryNode, selected?: HistoryNode[]) => {
      // with several rows selected VS Code passes them all as the second argument
      const targets = (selected?.length ? selected : [n]).filter((x): x is HistoryNode & { type: 'entry' } => x?.type === 'entry');
      if (!targets.length) throw new Error('Pick a query in the Query History view.');
      for (const t of targets) await history.remove(t.entry.id);
    }),
    h.cmd('history.filter', async () => {
      const text = await vscode.window.showInputBox({
        title: 'Filter the query history',
        prompt: 'Words that must appear in the SQL or the connection\u2019s name',
        value: historyTree.filter,
      });
      if (text === undefined) return;
      historyTree.setFilter(text);
      showFilter();
    }),
    h.cmd('history.clearFilter', () => {
      historyTree.setFilter('');
      showFilter();
    }),

    // bookmarks
    h.cmd('bookmarkQuery', async () => {
      const doc = vscode.window.activeTextEditor?.document;
      if (!doc) return void vscode.window.showInformationMessage('Open a SQL file first.');
      const connectionId = app.bindings.effective(doc.uri);
      const sql = h.statementSql(doc, connectionId);
      if (!sql?.trim()) return void vscode.window.showInformationMessage('There is no SQL statement at the cursor.');
      await bookmarkIt(sql, connectionId);
    }),
    h.cmd('runBookmark', async () => {
      const all = bookmarks.list();
      if (!all.length) return void vscode.window.showInformationMessage('No bookmarks yet. Use \u201cBookmark Query\u201d in a SQL editor.');
      const picked = await vscode.window.showQuickPick(
        all.map((b) => ({
          label: `$(bookmark) ${b.name}`,
          description: oneLine(b.sql, 70),
          detail: (b.connectionId && connections.info(b.connectionId)?.profile.name) || undefined,
          bookmark: b,
        })),
        { placeHolder: 'Run a bookmarked query', matchOnDescription: true, matchOnDetail: true },
      );
      if (!picked) return;
      const id = await connectionFor(picked.bookmark.connectionId);
      if (id) await app.runner.run(id, picked.bookmark.sql);
    }),
    h.cmd('bookmarks.open', async (n?: BookmarkNode) => {
      const b = bookmarkOf(n);
      const id = await connectionFor(b.connectionId);
      if (id) await h.openSql(id, b.sql);
    }),
    h.cmd('bookmarks.run', async (n?: BookmarkNode) => {
      const b = bookmarkOf(n);
      const id = await connectionFor(b.connectionId);
      if (id) await app.runner.run(id, b.sql);
    }),
    h.cmd('bookmarks.copy', (n?: BookmarkNode) => copy(bookmarkOf(n).sql)),
    h.cmd('bookmarks.rename', async (n?: BookmarkNode) => {
      const b = bookmarkOf(n);
      const name = await vscode.window.showInputBox({
        title: 'Rename bookmark',
        value: b.name,
        validateInput: (v) => (v.trim() ? undefined : 'A bookmark needs a name.'),
      });
      if (name !== undefined) await bookmarks.rename(b.id, name);
    }),
    h.cmd('bookmarks.delete', async (n?: BookmarkNode) => {
      const b = bookmarkOf(n);
      const ok = await vscode.window.showWarningMessage(`Delete the bookmark \u201c${b.name}\u201d?`, { modal: true }, 'Delete');
      if (ok) await bookmarks.remove(b.id);
    }),
  ];
}
