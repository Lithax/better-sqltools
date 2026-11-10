/**
 * Project configuration and groups through the real composition root: `.better-sqltools.toml` and
 * `.better-sqltools/*.toml` on disk, the real SQLite driver, and only the `vscode` module replaced.
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { SqliteDriverFactory } from '../drivers/sqlite/src';
import { tmpDir } from './helpers';
import { installVscodeMock } from './vscode-mock';

const ws = tmpDir();
const rootToml = path.join(ws, '.better-sqltools.toml');
const lines = (...l: string[]) => l.join('\n') + '\n';
const ROOT = lines(
  '[project]',
  'name = "Arom backend"',
  'group = "arom-backend"',
  '',
  '[groups.arom-backend]',
  'icon = "server"',
  'color = "charts.blue"',
  'description = "Everything for the Arom backend"',
  '',
  '[settings]',
  '"results.maxRows" = 2',
  '"nope.setting" = 1',
  '',
  '[[connections]]',
  'name = "Arom dev"',
  'driver = "sqlite"',
  '[connections.options]',
  'path = "${workspaceFolder}/arom.db"',
  '',
  '[[connections]]',
  'name = "Orphan"',
  'driver = "oracle"',
);
fs.writeFileSync(rootToml, ROOT);
fs.mkdirSync(path.join(ws, '.better-sqltools'));
fs.writeFileSync(
  path.join(ws, '.better-sqltools', 'extra.toml'),
  lines('[[connections]]', 'name = "Scratch"', 'driver = "sqlite"', 'group = "personal"', '[connections.options]', 'path = ":memory:"'),
);

const mock = installVscodeMock(ws);
const { state, vscode } = mock;
const ext = require('../src/extension') as typeof import('../src/extension');
const run = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(`betterSqlTools.${id}`, ...args);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const tree = () => state.treeProviders['betterSqlTools.connections'];
const dnd = () => state.treeViewOptions['betterSqlTools.connections'].dragAndDropController;
const lastResults = () => [...state.resultsMessages].reverse().find((m) => m.type === 'state').state;
const userGroups = () => state.config.user['betterSqlTools.groups'] as { id: string; name: string }[] | undefined;
const userConnections = () => (state.config.user['betterSqlTools.connections'] ?? []) as { id: string; name: string; group?: string; options: any }[];
const changed = () => mock.events.config.fire({ affectsConfiguration: () => true });

async function waitFor<T>(fn: () => T | undefined, ms = 10_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(30);
  }
}

const roots = async () => tree().getChildren();
const item = (n: any) => tree().getTreeItem(n);
const groupNode = (id: string) => ({ type: 'group', id });
const connectionNamed = async (name: string) => {
  const all: any[] = [];
  for (const r of await roots()) all.push(...(r.type === 'group' ? await tree().getChildren(r) : [r]));
  return all.find((n) => item(n).label === name);
};

before(async () => {
  const api = await ext.activate(mock.context as any);
  mock.addExtension({
    id: 'better-sqltools.better-sqltools-sqlite',
    packageJSON: { version: '0.1.0', betterSqlTools: { drivers: [{ id: 'sqlite', name: 'SQLite' }] } },
    activate: () => void api.registerDriver(new SqliteDriverFactory()),
  });
  await waitFor(() => state.treeProviders['betterSqlTools.drivers'].getChildren().find((d: any) => d.state === 'ready'));
  await waitFor(async () => (await roots()).length);
});
after(async () => {
  await ext.deactivate();
  mock.uninstall();
});

test('project: groups and connections from .better-sqltools.toml and .better-sqltools/ fill the tree', async () => {
  const top = await roots();
  assert.deepEqual(top.map((n: any) => [n.type, n.id]), [['group', 'arom-backend'], ['group', 'personal']], 'groups by name, no loose connections');

  const arom = item(top[0]);
  assert.equal(arom.label, 'Arom backend');
  assert.equal(arom.contextValue, 'group.project');
  assert.equal(arom.iconPath.id, 'server');
  assert.equal(arom.iconPath.color.id, 'charts.blue');
  assert.match(arom.description, /^2 · project$/);
  assert.match(String(arom.tooltip.value), /Everything for the Arom backend[\s\S]*\.better-sqltools\.toml/);

  const personal = item(top[1]);
  assert.equal(personal.contextValue, 'group.implicit', 'referenced by a connection, defined nowhere');
  assert.equal(personal.label, 'personal');

  const aromChildren = await tree().getChildren(top[0]);
  assert.deepEqual(aromChildren.map((n: any) => item(n).label), ['Arom dev', 'Orphan']);
  assert.match(String(item(aromChildren[0]).tooltip.value), /\.better-sqltools\.toml/);
  assert.equal(tree().getParent(aromChildren[0]).id, 'arom-backend');
  assert.deepEqual((await tree().getChildren(top[1])).map((n: any) => item(n).label), ['Scratch']);

  const orphan = item(aromChildren[1]);
  assert.equal(orphan.contextValue, 'connection.nodriver');
  assert.match(orphan.description, /oracle · driver not installed/);
});

test('project: a connection from a file connects, with ${workspaceFolder} expanded, and [settings] apply', async () => {
  const dev = await connectionNamed('Arom dev');
  assert.match(dev.id, /^arom-dev@[0-9a-f]{6}$/);
  await run('connect', dev);
  assert.equal(item(dev).contextValue, 'connection.connected');
  // (the database file appears once something is written to it)

  await mock.openSql('create table t (x); insert into t values (1), (2), (3); select * from t;');
  await run('runFile');
  const done = lastResults();
  assert.equal(done.status, 'done');
  assert.equal(done.result.statements.at(-1).rows.length, 2, 'results.maxRows = 2 came from the TOML file');
  assert.equal(done.result.statements.at(-1).truncated, true);
  assert.ok(fs.existsSync(path.join(ws, 'arom.db')), 'created at the expanded path');
  await run('disconnect', dev);
});

test('project: problems show up in the Problems panel and clear when the file is fixed', async () => {
  const uri = `file:${rootToml}`;
  const diags = await waitFor(() => state.diagnostics.get(uri));
  assert.equal(diags.length, 1);
  assert.match(diags[0].message, /Unknown setting "nope.setting"/);
  assert.equal(diags[0].severity, 1, 'a warning');
  assert.equal(diags[0].range.start.line, ROOT.split('\n').findIndex((l) => l.includes('nope.setting')));

  fs.writeFileSync(rootToml, ROOT.replace('"nope.setting" = 1\n', ''));
  mock.events.fsChange.fire();
  await waitFor(() => !state.diagnostics.has(uri));
});

test('project: connections from a file are edited in the file, not in the UI', async () => {
  const dev = await connectionNamed('Arom dev');
  state.messages.length = 0;
  await run('deleteConnection', dev);
  const msg = state.messages.find((m) => /is defined in \.better-sqltools\.toml/.test(m.message));
  assert.ok(msg, 'explains where it is defined');
  assert.deepEqual(msg.items, ['Open Config File']);
  assert.ok(await connectionNamed('Arom dev'), 'still there');

  await run('editConnection', dev);
  const editor = state.activeEditor!;
  assert.ok(String(editor.document.uri).endsWith('.better-sqltools.toml'));
  const line = editor.document.getText().split('\n').findIndex((l: string) => l.includes('Arom dev'));
  assert.equal(editor.selection.active.line, line, 'on the connection');

  await run('duplicateConnection', dev);
  const copy = userConnections().find((c) => c.name === 'Arom dev (copy)')!;
  assert.ok(copy, 'a copy can be edited');
  assert.equal(copy.group, 'arom-backend');
  assert.equal((copy as any).file, undefined);
  state.config.user['betterSqlTools.connections'] = [];
  changed();
});

test('groups: create, move, rename and delete from the view', async () => {
  state.config.user['betterSqlTools.connections'] = [{ id: 'mine', name: 'Mine', driver: 'sqlite', options: { path: ':memory:' } }];
  changed();
  await waitFor(async () => (await connectionNamed('Mine')));

  state.inputAnswers.push('Personal DBs');
  await run('newGroup');
  assert.deepEqual(userGroups(), [{ id: 'personal-dbs', name: 'Personal DBs' }]);

  state.quickPickAnswers.push('Personal DBs');
  await run('moveToGroup', await connectionNamed('Mine'), []);
  assert.equal(userConnections()[0].group, 'personal-dbs');
  assert.equal(tree().getParent(await connectionNamed('Mine')).id, 'personal-dbs');

  state.inputAnswers.push('Private');
  await run('renameGroup', groupNode('personal-dbs'));
  assert.equal(userGroups()![0].name, 'Private');
  assert.equal(item(groupNode('personal-dbs')).label, 'Private');

  state.messages.length = 0;
  state.inputAnswers.push('Nope');
  await run('renameGroup', groupNode('arom-backend'));
  assert.ok(state.messages.some((m) => /Group "Arom backend" is defined in \.better-sqltools\.toml/.test(m.message)));

  state.messageAnswers.push('Delete');
  await run('deleteGroup', groupNode('personal-dbs'));
  assert.equal(userGroups(), undefined);
  assert.equal(userConnections()[0].group, undefined, 'the connection stays');
});

test('groups: drag and drop files connections under groups', async () => {
  const mine = await connectionNamed('Mine');
  const data = new Map<string, any>();
  dnd().handleDrag([mine], data);
  assert.deepEqual(data.get(dnd().dragMimeTypes[0]).value, ['mine']);

  await dnd().handleDrop(groupNode('arom-backend'), data);
  assert.equal(userConnections()[0].group, 'arom-backend');
  assert.equal(item(groupNode('arom-backend')).description, '3 · project');

  await dnd().handleDrop(undefined, data);
  assert.equal(userConnections()[0].group, undefined, 'dropping on empty space ungroups');

  const dev = await connectionNamed('Arom dev');
  const fromFile = new Map<string, any>();
  dnd().handleDrag([dev], fromFile);
  state.messages.length = 0;
  await dnd().handleDrop(groupNode('personal'), fromFile);
  assert.ok(state.messages.some((m) => /is defined in \.better-sqltools\.toml/.test(m.message)), 'project connections stay where the file puts them');
});

test('project: nothing is read until the workspace is trusted', async () => {
  const names = async () => (await roots()).length;
  assert.ok(await names());
  vscode.workspace.isTrusted = false;
  mock.events.trust.fire();
  await waitFor(async () => !(await connectionNamed('Arom dev')));
  assert.equal((state.config.user['betterSqlTools.connections'] as unknown[]).length, 1, 'settings connections are untouched');

  vscode.workspace.isTrusted = true;
  mock.events.trust.fire();
  await waitFor(() => connectionNamed('Arom dev'));
});

test('project: the command creates a starter file and opens it', async () => {
  fs.rmSync(rootToml);
  fs.rmSync(path.join(ws, '.better-sqltools'), { recursive: true });
  mock.events.fsChange.fire();
  await waitFor(async () => !(await connectionNamed('Arom dev')));

  await run('createProjectConfig');
  assert.ok(fs.existsSync(rootToml));
  assert.match(fs.readFileSync(rootToml, 'utf8'), /^# Better SQLTools project configuration\./);
  assert.ok(String(state.activeEditor!.document.uri).endsWith('.better-sqltools.toml'));
  // the starter parses cleanly: it only has a [project] name and comments
  mock.events.fsChange.fire();
  await tick(150);
  assert.deepEqual([...state.diagnostics.values()].flat(), []);
});
