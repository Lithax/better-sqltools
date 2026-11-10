/**
 * The connections explorer and the tools around it, through the real composition root and the real SQLite
 * driver: driver icon and name, folder and row counts, the settings that toggle them, filtering, searching
 * and "Inspect connection". Only the `vscode` module is replaced.
 */
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { SqliteDriverFactory } from '../drivers/sqlite/src';
import { tmpDir } from './helpers';
import { installVscodeMock } from './vscode-mock';

const ws = tmpDir();
const mock = installVscodeMock(ws);
const { state, vscode } = mock;
const ext = require('../src/extension') as typeof import('../src/extension');
const run = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(`betterSqlTools.${id}`, ...args);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const tree = () => state.treeProviders['betterSqlTools.connections'];
const item = (n: any) => tree().getTreeItem(n);
const setting = (key: string, value: unknown) => {
  state.config.user[`betterSqlTools.explorer.${key}`] = value;
  mock.events.config.fire({ affectsConfiguration: () => true });
};

async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(30);
  }
}

const connection = async () => (await tree().getChildren())[0];
const folders = async () => tree().getChildren(await connection());
const folder = async (label: string) => (await folders()).find((f: any) => item(f).label === label);
const names = async (label: string) => {
  const f = await folder(label);
  return f ? (await tree().getChildren(f)).map((n: any) => item(n).label) : undefined;
};

before(async () => {
  const api = await ext.activate(mock.context as any);
  mock.addExtension({
    id: 'better-sqltools.better-sqltools-sqlite',
    packageJSON: { version: '0.1.0', betterSqlTools: { drivers: [{ id: 'sqlite', name: 'SQLite', icon: 'media/sqlite.svg' }] } },
    activate: () => void api.registerDriver(new SqliteDriverFactory()),
  });
  await waitFor(() => state.treeProviders['betterSqlTools.drivers'].getChildren().find((d: any) => d.state === 'ready'));

  state.config.user['betterSqlTools.connections'] = [
    { id: 'lib', name: 'Library', driver: 'sqlite', options: { path: '${workspaceFolder}/library.db', createIfMissing: true } },
  ];
  mock.events.config.fire({ affectsConfiguration: () => true });
  await waitFor(async () => (await tree().getChildren()).length);
  await run('connect', ...item(await connection()).command.arguments);

  await mock.openSql(
    [
      'create table books (id integer primary key, title text not null, year integer);',
      'create table authors (id integer primary key, name text not null);',
      "insert into books (title, year) values ('Dune', 1965), ('Emma', 1815), ('Ulysses', 1922);",
      "insert into authors (name) values ('Herbert');",
      'create view recent_books as select title from books where year > 1900;',
      'create index books_year on books (year);',
      'select 1|;',
    ].join('\n'),
  );
  await run('runFile');
  await run('refresh');
});
after(async () => {
  await ext.deactivate();
  mock.uninstall();
});

test('a connection shows the driver icon and name, and the state as a coloured label', async () => {
  const conn = await connection();
  const i = item(conn);
  assert.equal(i.label, 'Library');
  assert.equal(i.description, 'SQLite');
  assert.notEqual(i.iconPath.id, 'database', 'the driver brings its own icon');
  assert.equal(i.resourceUri.scheme, 'better-sqltools-connection');

  const deco = state.decorationProvider.provideFileDecoration(i.resourceUri);
  assert.equal(deco.tooltip, 'Connected');
  assert.equal(deco.color.id, 'charts.green');
  assert.equal(state.decorationProvider.provideFileDecoration(vscode.Uri.parse('file:///x.sql')), undefined, 'other resources are left alone');
});

test('driver icon and driver name are settings; switching them off restores the plain look', async () => {
  setting('driverIcons', false);
  let i = item(await connection());
  assert.equal(i.iconPath.id, 'database');
  assert.equal(i.iconPath.color.id, 'charts.green');
  assert.equal(i.resourceUri, undefined);

  setting('showDriverName', false);
  i = item(await connection());
  assert.equal(i.description, undefined);

  setting('driverIcons', undefined);
  setting('showDriverName', undefined);
  i = item(await connection());
  assert.equal(i.description, 'SQLite', 'defaults are on');
});

test('folders show how many objects they hold, unless the setting says otherwise', async () => {
  const counts = async () => Promise.all((await folders()).map(async (f: any) => `${item(f).label}:${item(f).description}`));
  assert.deepEqual(await counts(), ['Tables:2', 'Views:1', 'Indexes:1', 'Triggers:0']);

  setting('showCounts', false);
  assert.deepEqual(await counts(), ['Tables:undefined', 'Views:undefined', 'Indexes:undefined', 'Triggers:undefined']);
  setting('showCounts', undefined);
});

test('row counts are off by default and cost a query per table only when switched on', async () => {
  const f = await folder('Tables');
  const descriptions = async () => Promise.all((await tree().getChildren(f)).map(async (n: any) => `${item(n).label}:${item(n).description}`));
  assert.deepEqual(await descriptions(), ['authors:undefined', 'books:undefined']);

  setting('showRowCounts', true);
  assert.deepEqual(await descriptions(), ['authors:1 row', 'books:3 rows']);
  setting('showRowCounts', undefined);
});

test('filter: only matching objects stay, containers without a match disappear, clearing restores everything', async () => {
  state.inputAnswers.push('book');
  await run('filterObjects');
  assert.ok(state.executed.some(([id, a]) => id === 'setContext' && (a as unknown[])[0] === 'betterSqlTools.filterActive' && (a as unknown[])[1] === true));
  assert.equal(tree().activeFilter, 'book');

  assert.deepEqual((await folders()).map((f: any) => item(f).label), ['Tables', 'Views', 'Indexes'], 'Triggers holds nothing that matches');
  assert.deepEqual(await names('Tables'), ['books']);
  assert.deepEqual(await names('Views'), ['recent_books']);
  assert.equal(item(await folder('Tables')).description, undefined, 'a count of everything would contradict the filtered list');

  state.inputAnswers.push('*_b?oks');
  await run('filterObjects');
  assert.deepEqual((await folders()).map((f: any) => item(f).label), ['Views'], 'wildcards work');

  state.inputAnswers.push('nothing like this');
  await run('filterObjects');
  assert.deepEqual(await folders(), []);

  await run('clearFilter');
  assert.equal(tree().activeFilter, '');
  assert.deepEqual((await folders()).map((f: any) => item(f).label), ['Tables', 'Views', 'Indexes', 'Triggers']);
  assert.ok(state.executed.some(([id, a]) => id === 'setContext' && (a as unknown[])[0] === 'betterSqlTools.filterActive' && (a as unknown[])[1] === false));
});

test('search: finds tables and columns across the connection and acts on the pick', async () => {
  state.quickPickAnswers.push(
    (items: any[]) => {
      assert.ok(items.some((i) => i.label.endsWith('recent_books') && i.detail.startsWith('view')), 'views are searchable too');
      return items.find((i) => i.label.endsWith('books.title'));
    },
    'Copy name',
  );
  await run('searchObjects', await connection());
  assert.equal(state.clipboard, 'books.title');
});

test('inspect: uptime, what the core measured and what the driver reports', async () => {
  await run('inspectConnection', await connection());
  const panel = state.panels.filter((p) => p.type === 'betterSqlTools.inspect').at(-1)!;
  try {
    assert.match(panel.webview.html, /inspect\.js/);
    assert.equal(panel.title, 'Inspect: Library');

    await panel.send({ type: 'ready' });
    const { data } = await waitFor(() => panel.last('inspection'));
    assert.equal(data.name, 'Library');
    assert.equal(data.driverName, 'SQLite');
    assert.ok(data.uptimeMs >= 0);
    assert.ok(data.stats.statements >= 1, 'the setup script counts');
    assert.equal(typeof data.stats.errors, 'number');
    assert.ok(data.driver, 'SQLite reports on itself');

    await run('inspectConnection', await connection());
    assert.equal(state.panels.filter((p) => p.type === 'betterSqlTools.inspect' && !p.disposed).length, 1, 'one panel per connection');

    await run('disconnect', await connection());
    await waitFor(() => panel.last('unavailable'));
  } finally {
    panel.dispose(); // its refresh timer would keep the process alive
  }
});
