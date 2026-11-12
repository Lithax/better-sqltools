/**
 * The Query History and Bookmarks views and their commands, through the real composition root and the real
 * SQLite driver. Only the `vscode` module is replaced.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SqliteDriverFactory } from '../drivers/sqlite/src';
import { VsCodeBookmarks } from '../src/adapters/vscode/bookmark-repository';
import type { Bookmark, HistoryEntry } from '../src/domain/model';
import { tmpDir } from './helpers';
import { installVscodeMock } from './vscode-mock';

const ws = tmpDir();
const mock = installVscodeMock(ws);
const { state, vscode } = mock;
const ext = require('../src/extension') as typeof import('../src/extension');
const run = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(`betterSqlTools.${id}`, ...args);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const memento = mock.context.globalState;

const historyTree = () => state.treeProviders['betterSqlTools.history'];
const bookmarksTree = () => state.treeProviders['betterSqlTools.bookmarks'];
const connectionsTree = () => state.treeProviders['betterSqlTools.connections'];
const item = (tree: any, n: any) => tree.getTreeItem(n);
const days = () => historyTree().getChildren();
const entriesOf = (day: any) => historyTree().getChildren(day);
const allEntries = async () => (await days()).flatMap((d: any) => entriesOf(d));
const bookmarkNodes = () => bookmarksTree().getChildren();
const bookmarkNames = () => bookmarkNodes().map((n: any) => item(bookmarksTree(), n).label);
const errors = () => state.messages.filter((m) => m.kind === 'error').map((m) => m.message);

async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(30);
  }
}

const at = (daysAgo: number, hour = 12) => {
  const d = new Date();
  d.setDate(d.getDate() - daysAgo);
  d.setHours(hour, 0, 0, 0);
  return d.getTime();
};
const entry = (id: string, sql: string, daysAgo: number, extra: Partial<HistoryEntry> = {}): HistoryEntry => ({
  id, sql, connectionId: 'lib', connectionName: 'Library', at: at(daysAgo), durationMs: 3.4, ok: true, ...extra,
});
const seedHistory = (...entries: HistoryEntry[]) => memento.update('betterSqlTools.history', entries);
const seedBookmarks = (...items: Bookmark[]) => memento.update('betterSqlTools.bookmarks', items);

/** The last finished result the results panel was sent. */
const lastResult = () => [...state.resultsMessages].reverse().find((m) => m.type === 'state' && m.state.status === 'done')?.state.result;

before(async () => {
  const api = await ext.activate(mock.context as any);
  mock.addExtension({
    id: 'better-sqltools.better-sqltools-sqlite',
    packageJSON: { version: '0.1.0', betterSqlTools: { drivers: [{ id: 'sqlite', name: 'SQLite' }] } },
    activate: () => void api.registerDriver(new SqliteDriverFactory()),
  });
  await waitFor(() => state.treeProviders['betterSqlTools.drivers'].getChildren().find((d: any) => d.state === 'ready'));
  state.config.user['betterSqlTools.connections'] = [
    { id: 'lib', name: 'Library', driver: 'sqlite', options: { path: '${workspaceFolder}/library.db', createIfMissing: true } },
  ];
  mock.events.config.fire({ affectsConfiguration: () => true });
  await waitFor(async () => (await connectionsTree().getChildren()).length);
  const conn = (await connectionsTree().getChildren())[0];
  await run('connect', ...item(connectionsTree(), conn).command.arguments);
  await mock.openSql('create table books (id integer primary key, title text);\ninsert into books (title) values (\'Dune\'), (\'Emma\');');
  await run('runFile');
});
after(async () => {
  await ext.deactivate();
  mock.uninstall();
});

test('history: entries are grouped by day, newest first, and describe themselves', async () => {
  await seedHistory(
    entry('h1', 'select *\n  from books', 0),
    entry('h2', 'select nope', 0, { ok: false, durationMs: 0.2 }),
    entry('h3', 'select 3', 1, { durationMs: 2500 }),
    entry('h4', 'select 4', 40),
  );
  const groups = await days();
  const older = new Date(at(40)).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
  assert.deepEqual(groups.map((d: any) => item(historyTree(), d).label), ['Today', 'Yesterday', older]);
  assert.deepEqual(groups.map((d: any) => item(historyTree(), d).collapsibleState), [2, 2, 1], 'the two most recent days start open');
  assert.deepEqual(groups.map((d: any) => item(historyTree(), d).description), ['2 queries', '1 query', '1 query']);

  const [first, second] = entriesOf(groups[0]).map((n: any) => item(historyTree(), n));
  assert.equal(first.label, 'select * from books', 'one line');
  assert.match(first.description, /^Library · .+ · 3 ms$/);
  assert.equal(first.iconPath.id, 'check');
  assert.equal(first.iconPath.color.id, 'testing.iconPassed');
  assert.equal(first.contextValue, 'historyEntry');
  assert.equal(first.command.command, 'betterSqlTools.history.open');
  assert.match(first.tooltip.value, /select \*\n  from books/, 'the tooltip keeps the SQL as written');
  assert.match(first.tooltip.value, /Succeeded/);

  assert.match(second.description, /<1 ms$/);
  assert.equal(second.iconPath.id, 'error');
  assert.equal(second.iconPath.color.id, 'testing.iconFailed');
  assert.match(second.tooltip.value, /Failed/);

  assert.match(item(historyTree(), entriesOf(groups[1])[0]).description, /2\.5 s$/);
  assert.equal(item(historyTree(), groups[0]).id, `day:${groups[0].key}`, 'stable ids let VS Code remember what the user opened');
});

test('history: a filter keeps entries that contain every word in the SQL or the connection name', async () => {
  await seedHistory(entry('h1', 'select title from books', 0), entry('h2', 'select 1', 0), entry('h3', 'delete from books', 1));
  const texts = async () => (await allEntries()).map((n: any) => item(historyTree(), n).label);
  assert.deepEqual(await texts(), ['select title from books', 'select 1', 'delete from books']);

  state.inputAnswers.push('BOOKS from');
  await run('history.filter');
  assert.deepEqual(await texts(), ['select title from books', 'delete from books'], 'every word, any case');
  assert.equal(state.treeViews['betterSqlTools.history'].description, 'Filter: BOOKS from');
  assert.equal(state.treeViews['betterSqlTools.history'].message, undefined);
  const setContext = (v: boolean) => state.executed.filter(([id, a]) => id === 'setContext' && (a as unknown[])[0] === 'betterSqlTools.historyFilterActive' && (a as unknown[])[1] === v).length;
  assert.ok(setContext(true) >= 1);

  state.inputAnswers.push('library select');
  await run('history.filter');
  assert.deepEqual(await texts(), ['select title from books', 'select 1'], 'the connection name counts');

  state.inputAnswers.push('nothing like this');
  await run('history.filter');
  assert.deepEqual(await days(), []);
  assert.equal(state.treeViews['betterSqlTools.history'].message, 'No queries match \u201cnothing like this\u201d.');

  state.inputAnswers.push(undefined); // Escape keeps the filter as it was
  await run('history.filter');
  assert.equal(historyTree().filter, 'nothing like this');

  await run('history.clearFilter');
  assert.equal((await texts()).length, 3);
  assert.equal(state.treeViews['betterSqlTools.history'].description, undefined);
  assert.equal(state.treeViews['betterSqlTools.history'].message, undefined);
  assert.ok(setContext(false) >= 1);
});

test('history: a new query shows up without a refresh', async () => {
  await seedHistory();
  assert.deepEqual(await days(), []);
  let fired = 0;
  historyTree().onDidChangeTreeData(() => fired++);
  await mock.openSql('select 7 as seven|;');
  await run('runStatement');
  await waitFor(() => fired > 0);
  assert.equal(item(historyTree(), (await allEntries())[0]).label, 'select 7 as seven');
});

test('history: open, run again, copy and delete act on the entry', async () => {
  await seedHistory(entry('h1', 'select 42 as answer', 0), entry('h2', 'select 2', 0), entry('h3', 'select 3', 0), entry('h4', 'select 4', 0));
  const nodes = await allEntries();

  await run('history.open', nodes[0]);
  assert.equal(state.documents.at(-1)!.getText(), 'select 42 as answer');
  assert.equal(state.documents.at(-1)!.languageId, 'sql');

  state.resultsMessages.length = 0;
  await run('history.run', nodes[0]);
  const result = await waitFor(lastResult);
  assert.match(JSON.stringify(result.statements[0].rows), /42/, 'it ran on the connection it ran on before');

  await run('history.copy', nodes[1]);
  assert.equal(state.clipboard, 'select 2');

  await run('history.delete', nodes[1]);
  assert.deepEqual((await allEntries()).map((n: any) => n.entry.id).filter((id: string) => id.startsWith('h')), ['h1', 'h3', 'h4']);
  await run('history.delete', nodes[2], [nodes[2], nodes[3]]); // several rows selected: VS Code passes them all
  assert.deepEqual((await allEntries()).map((n: any) => n.entry.id).filter((id: string) => id.startsWith('h')), ['h1']);

  await run('history.delete', (await days())[0]);
  assert.match(errors().at(-1)!, /Pick a query in the Query History view/, 'a day is not an entry');
});

test('history: an entry whose connection is gone asks which connection to use instead', async () => {
  await seedHistory(entry('h1', 'select 1', 0, { connectionId: 'gone', connectionName: 'Old DB' }));
  state.quickPickAnswers.push('Library');
  await run('history.open', (await allEntries())[0]);
  assert.equal(state.documents.at(-1)!.getText(), 'select 1');

  const before = state.documents.length;
  state.quickPickAnswers.push(() => undefined); // dismissed (a bare undefined would mean "take the first item" in the mock)
  await run('history.open', (await allEntries())[0]);
  assert.equal(state.documents.length, before, 'nothing opens when the pick is dismissed');
});

test('bookmarks: the statement under the cursor is saved with its connection, after asking for a name', async () => {
  await seedBookmarks();
  await mock.openSql('select 1;\nselect * from books where id > 1|;');
  await run('runStatement'); // binds the editor to the connection
  state.inputAnswers.push('  Books after one ');
  await run('bookmarkQuery');
  const [b] = new VsCodeBookmarks(memento).list();
  assert.equal(b.name, 'Books after one');
  assert.match(b.sql, /^select \* from books where id > 1/);
  assert.equal(b.connectionId, 'lib');

  state.inputAnswers.push(undefined);
  await run('bookmarkQuery');
  assert.equal(new VsCodeBookmarks(memento).list().length, 1, 'Escape saves nothing');

  await mock.openSql('   |');
  await run('bookmarkQuery');
  assert.match(state.messages.at(-1)!.message, /no SQL statement at the cursor/);
  assert.equal(new VsCodeBookmarks(memento).list().length, 1);
});

test('bookmarks: listed by name, with the SQL beside it and a tooltip that names the connection', async () => {
  await seedBookmarks(
    { id: 'b1', name: 'zebra', sql: 'select  *\nfrom books', connectionId: 'lib', createdAt: 1 },
    { id: 'b2', name: 'Apple', sql: 'select 2', connectionId: 'gone', createdAt: 2 },
    { id: 'b3', name: 'mango', sql: 'select 3', createdAt: 3 },
  );
  assert.deepEqual(bookmarkNames(), ['Apple', 'mango', 'zebra']);
  const [apple, mango, zebra] = bookmarkNodes().map((n: any) => item(bookmarksTree(), n));
  assert.equal(zebra.description, 'select * from books');
  assert.equal(zebra.iconPath.id, 'bookmark');
  assert.equal(zebra.contextValue, 'bookmark');
  assert.equal(zebra.command.command, 'betterSqlTools.bookmarks.open');
  assert.match(zebra.tooltip.value, /Saved from \*\*Library\*\*/);
  assert.match(apple.tooltip.value, /connection that no longer exists/);
  assert.match(mango.tooltip.value, /Not tied to a connection/);
});

test('bookmarks: open, run, copy, rename and delete', async () => {
  await seedBookmarks({ id: 'b1', name: 'Count books', sql: 'select count(*) as n from books', connectionId: 'lib', createdAt: 1 });
  await run('bookmarks.copy', bookmarkNodes()[0]);
  assert.equal(state.clipboard, 'select count(*) as n from books');

  await run('bookmarks.open', bookmarkNodes()[0]);
  assert.equal(state.documents.at(-1)!.getText(), 'select count(*) as n from books');

  state.resultsMessages.length = 0;
  await run('bookmarks.run', bookmarkNodes()[0]);
  assert.match(JSON.stringify((await waitFor(lastResult)).statements[0].rows), /2/);

  state.inputAnswers.push('Number of books');
  await run('bookmarks.rename', bookmarkNodes()[0]);
  assert.deepEqual(bookmarkNames(), ['Number of books']);
  state.inputAnswers.push(undefined);
  await run('bookmarks.rename', bookmarkNodes()[0]);
  assert.deepEqual(bookmarkNames(), ['Number of books'], 'Escape keeps the name');

  state.messageAnswers.push(undefined); // the modal confirmation is dismissed
  await run('bookmarks.delete', bookmarkNodes()[0]);
  assert.equal(bookmarkNodes().length, 1);
  state.messageAnswers.push('Delete');
  await run('bookmarks.delete', bookmarkNodes()[0]);
  assert.equal(bookmarkNodes().length, 0);
  assert.match(state.messages.filter((m) => m.kind === 'warning').at(-1)!.message, /Delete the bookmark .Number of books./);
});

test('bookmarks: Run Bookmarked Query picks one from the palette, or says there are none', async () => {
  await seedBookmarks();
  await run('runBookmark');
  assert.match(state.messages.at(-1)!.message, /No bookmarks yet/);

  await seedBookmarks(
    { id: 'b1', name: 'Titles', sql: 'select title from books order by title', connectionId: 'lib', createdAt: 1 },
    { id: 'b2', name: 'Count', sql: 'select count(*) as n from books', connectionId: 'lib', createdAt: 2 },
  );
  state.quickPickAnswers.push((items: any[]) => {
    assert.deepEqual(items.map((i) => i.label), ['$(bookmark) Count', '$(bookmark) Titles'], 'by name');
    assert.equal(items[0].detail, 'Library');
    return items[1];
  });
  state.resultsMessages.length = 0;
  await run('runBookmark');
  assert.match(JSON.stringify((await waitFor(lastResult)).statements[0].rows), /Dune/);
});

test('bookmarks: a bookmark outlives the session, and damaged stored data cannot break the view', async () => {
  const good: Bookmark = { id: 'b1', name: 'Keep', sql: 'select 1', createdAt: 1 };
  await memento.update('betterSqlTools.bookmarks', [good, null, 'text', { id: 1 }, { id: 'x', name: 'no sql' }, 42]);
  assert.deepEqual(new VsCodeBookmarks(memento).list(), [good]);
  await memento.update('betterSqlTools.bookmarks', 'not even a list');
  assert.deepEqual(new VsCodeBookmarks(memento).list(), []);
});
