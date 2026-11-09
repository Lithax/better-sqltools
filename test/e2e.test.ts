/**
 * End to end through the real composition root: extension.ts, real services, the real SQLite driver and
 * (when installed) the real sqlfluff, with only the `vscode` module replaced. The webviews are driven
 * with the same messages their pages send.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, before, test } from 'node:test';
import { toCsv } from '../src/domain/export';
import { SqliteDriverFactory } from '../drivers/sqlite/src';
import { fakeFactory, type FakeDriverState } from './fakes';
import { tmpDir } from './helpers';
import { installVscodeMock } from './vscode-mock';

const ws = tmpDir();
const mock = installVscodeMock(ws);
const { state, vscode } = mock;
// loaded after the mock is installed, so `import 'vscode'` resolves to it
const ext = require('../src/extension') as typeof import('../src/extension');
const pkg = require('../package.json');
const hasSqlfluff = spawnSync('sqlfluff', ['--version']).status === 0;

let api: import('../src/api').BetterSqlToolsApi;
const run = (id: string, ...args: unknown[]) => vscode.commands.executeCommand(`betterSqlTools.${id}`, ...args);
const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));
const connectionsTree = () => state.treeProviders['betterSqlTools.connections'];
const lastResults = () => [...state.resultsMessages].reverse().find((m) => m.type === 'state').state;
const profilesInSettings = () => state.config.user['betterSqlTools.connections'] as { id: string; name: string; driver: string; options: any }[] | undefined;

async function waitFor<T>(fn: () => T | undefined, ms = 20_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) throw new Error('timed out waiting');
    await tick(50);
  }
}

before(async () => {
  api = await ext.activate(mock.context as any);
  // SQLite is a separate extension. Install it the way VS Code lists one: the core finds it through its
  // package.json manifest, wakes it after activating, and the driver registers through the public API.
  mock.addExtension({
    id: 'better-sqltools.better-sqltools-sqlite',
    packageJSON: { version: '0.1.0', betterSqlTools: { drivers: [{ id: 'sqlite', name: 'SQLite', icon: 'media/sqlite.svg' }] } },
    activate: () => void api.registerDriver(new SqliteDriverFactory()),
  });
  await waitFor(() => state.treeProviders['betterSqlTools.drivers'].getChildren().find((d: any) => d.state === 'ready'));
});
after(async () => { await ext.deactivate(); mock.uninstall(); });

test('activation wires every contribution in the manifest', () => {
  assert.equal(api.apiVersion, 1);
  for (const c of pkg.contributes.commands) assert.ok(state.commands.has(c.command), `command ${c.command}`);
  for (const v of ['betterSqlTools.connections', 'betterSqlTools.drivers']) assert.ok(state.treeProviders[v], v);
  assert.ok(state.webviewViewProviders['betterSqlTools.results']);
  for (const k of ['completion', 'formatting', 'codeActions', 'codeLens'] as const) assert.ok(state.providers[k], k);
  assert.ok(mock.context.subscriptions.length >= 10);
});

test('drivers: SQLite is a plugin like any third-party driver, and both share one door', () => {
  const tree = state.treeProviders['betterSqlTools.drivers'];
  assert.deepEqual(tree.getChildren().map((d: any) => d.id), ['sqlite']);
  assert.equal(tree.getTreeItem(tree.getChildren()[0]).label, 'SQLite');
  const icon = tree.getTreeItem(tree.getChildren()[0]).iconPath;
  assert.ok(String(icon).endsWith('/better-sqltools.better-sqltools-sqlite/media/sqlite.svg'), 'the driver ships its own icon');

  const reg = api.registerDriver(fakeFactory({ opened: 0, closed: 0, executed: [], openDelayMs: 0 }));
  assert.deepEqual(tree.getChildren().map((d: any) => d.id), ['fake', 'sqlite']);
  assert.throws(() => api.registerDriver(fakeFactory({ opened: 0, closed: 0, executed: [], openDelayMs: 0 })), /already registered/);
  reg.dispose();
  assert.deepEqual(tree.getChildren().map((d: any) => d.id), ['sqlite']);
});

test('connection form: generated from the driver schema, validates, tests and saves', async () => {
  await run('newConnection');
  const panel = state.panels.at(-1)!;
  assert.match(panel.webview.html, /Content-Security-Policy[^>]*script-src 'nonce-/);
  assert.match(panel.webview.html, /connection-form\.js/);

  await panel.send({ type: 'ready' });
  const init = panel.last('init');
  assert.equal(init.mode, 'new');
  assert.equal(init.canUseWorkspace, true);
  assert.deepEqual(init.drivers.map((d: any) => d.id), ['sqlite']);
  assert.deepEqual(init.drivers[0].connectionSchema.map((f: any) => f.key), ['path', 'readOnly', 'createIfMissing', 'foreignKeys']);

  const draft = { name: 'Local', driver: 'sqlite', scope: 'user', options: {} as any, secrets: {}, saveSecrets: true };
  await panel.send({ type: 'test', draft });
  assert.equal(panel.last('testResult').ok, false);
  assert.match(panel.last('testResult').message, /"Database file" is required/);

  draft.options = { path: '${workspaceFolder}/e2e.db' };
  await panel.send({ type: 'test', draft });
  assert.deepEqual([panel.last('testResult').ok, panel.last('testResult').message], [true, 'Connection successful.']);
  assert.ok(!fs.existsSync(path.join(ws, 'e2e.db')), 'testing a connection does not create the database file');
  assert.equal(profilesInSettings(), undefined, 'testing saves nothing');

  await panel.send({ type: 'save', draft: { ...draft, name: '  ' } });
  assert.match(panel.last('saveError').message, /name/i);

  await panel.send({ type: 'save', draft });
  assert.ok(panel.disposed, 'the form closes after saving');
  assert.deepEqual(profilesInSettings(), [{ id: 'local', name: 'Local', driver: 'sqlite', options: { path: '${workspaceFolder}/e2e.db' } }]);
});

test('connection form: browsing inside the workspace stores a portable path', async () => {
  await run('newConnection');
  const panel = state.panels.at(-1)!;
  await panel.send({ type: 'ready' });
  state.openDialogAnswers.push(path.join(ws, 'sub', 'x.db'));
  await panel.send({ type: 'browse', key: 'path' });
  assert.deepEqual(panel.last('browsed'), { type: 'browsed', key: 'path', path: '${workspaceFolder}/sub/x.db' });
  panel.dispose();
});

test('tree: a disconnected connection connects on click and then opens expanded', async () => {
  const tree = connectionsTree();
  const [conn] = await tree.getChildren();
  let item = tree.getTreeItem(conn);
  assert.equal(item.label, 'Local');
  assert.equal(item.contextValue, 'connection.disconnected');
  assert.equal(item.collapsibleState, 0);
  assert.equal(item.command.command, 'betterSqlTools.connect');

  await run('connect', ...item.command.arguments);
  item = tree.getTreeItem(conn);
  assert.equal(item.contextValue, 'connection.connected');
  assert.equal(item.collapsibleState, 2);
  assert.match(item.id, /\/connected$/, 'state is part of the id so the item re-opens expanded');

  const roots = await tree.getChildren(conn);
  assert.deepEqual(roots.map((n: any) => tree.getTreeItem(n).label), ['Tables', 'Views', 'Indexes', 'Triggers']);
  assert.equal(tree.getTreeItem(roots[0]).contextValue, 'node.folder');
});

test('run a script, then statements, from an editor; errors are reported, not thrown', async () => {
  const script = "create table people (id integer primary key, name text not null);\ninsert into people (name) values ('Ada'), ('Linus'), ('<img src=x onerror=alert(1)>');\nselect * from people order by id|;";
  const { doc, editor } = await mock.openSql(script);

  await run('runFile'); // one connection exists, so the editor binds to it without asking
  let s = lastResults();
  assert.equal(s.status, 'done');
  assert.deepEqual(s.result.statements.map((x: any) => [x.columns.length, x.affectedRows ?? null, x.error ?? null]), [[0, 0, null], [0, 3, null], [2, null, null]]);
  assert.deepEqual(s.result.statements[2].rows.slice(0, 2), [[1, 'Ada'], [2, 'Linus']]);
  assert.equal(s.result.statements[2].rows[2][1], '<img src=x onerror=alert(1)>', 'values arrive verbatim; the page renders them as text');
  assert.ok(fs.existsSync(path.join(ws, 'e2e.db')), 'the first write created the file');
  JSON.stringify(s);

  assert.equal(state.statusBar.text?.includes('Local'), true);

  editor.selection = { ...editor.selection, active: doc.positionAt(script.indexOf('select') + 3) };
  await run('runStatement');
  s = lastResults();
  assert.equal(s.result.statements.length, 1);
  assert.equal(s.result.statements[0].sql, 'select * from people order by id');

  await mock.openSql('select * from nope|');
  await run('runStatement');
  s = lastResults();
  assert.equal(s.status, 'done');
  assert.match(s.result.statements[0].error.message, /no such table: nope/);
});

test('the tree announces its own changes: DDL, connection state, profiles, drivers', async () => {
  const tree = connectionsTree();
  let fired = 0;
  const sub = tree.onDidChangeTreeData(() => fired++);
  // VS Code re-reads children only when told to, so "the data changed" is not enough: the event must fire
  const expectRefresh = async (what: string, action: () => unknown) => {
    const before = fired;
    await action();
    await tick(10);
    assert.ok(fired > before, `${what} refreshes the tree`);
  };

  await mock.openSql('create table scratch (x);');
  await expectRefresh('DDL run from an editor', () => run('runFile'));
  await mock.openSql('drop table scratch;');
  await expectRefresh('more DDL', () => run('runFile'));
  await expectRefresh('a manual refresh', () => run('refresh'));

  const [conn] = await tree.getChildren();
  await expectRefresh('duplicating a connection', () => run('duplicateConnection', conn));
  const copy = (await tree.getChildren()).find((n: any) => n.id === 'local-copy');
  assert.ok(copy, 'the duplicate is listed');
  state.messageAnswers.push('Delete');
  await expectRefresh('deleting a connection', () => run('deleteConnection', copy));
  assert.equal((await tree.getChildren()).some((n: any) => n.id === 'local-copy'), false);

  let reg!: { dispose(): void };
  await expectRefresh('a driver appearing', () => { reg = api.registerDriver(fakeFactory({ opened: 0, closed: 0, executed: [], openDelayMs: 0 })); });
  await expectRefresh('a driver going away', () => reg.dispose());
  await expectRefresh('disconnecting', () => run('disconnect', conn));
  await expectRefresh('connecting', () => run('connect', conn));
  sub.dispose();
});

test('the schema tree and completion pick up DDL without a manual refresh', async () => {
  const tree = connectionsTree();
  const [conn] = await tree.getChildren();
  const [tables] = await tree.getChildren(conn);
  const people = (await tree.getChildren(tables))[0];
  assert.equal(tree.getTreeItem(people).contextValue, 'node.table');
  const cols = await tree.getChildren(people);
  assert.deepEqual(cols.map((c: any) => [tree.getTreeItem(c).label, tree.getTreeItem(c).iconPath.id]), [['id', 'key'], ['name', 'symbol-field']]);

  await tick(100); // the catalog is re-warmed in the background after DDL
  const provider = state.providers.completion;
  const complete = async (src: string) => {
    const { doc, editor } = await mock.openSql(src);
    return provider.provideCompletionItems(doc, editor.selection.active).map((i: any) => i.label);
  };
  assert.ok((await complete('select * from |')).includes('people'));
  assert.deepEqual(await complete('select p.| from people p'), ['id', 'name']);
  assert.ok((await complete('select | from people')).includes('name'));
});

test('table actions: show data, generate SELECT, show DDL, copy name', async () => {
  const tree = connectionsTree();
  const [conn] = await tree.getChildren();
  const [tables] = await tree.getChildren(conn);
  const people = (await tree.getChildren(tables))[0];

  await run('showTableData', people);
  assert.equal(lastResults().result.statements[0].sql, 'SELECT *\nFROM "people"\nLIMIT 1000');
  assert.equal(lastResults().result.statements[0].rows.length, 3);

  await run('generateSelect', people);
  assert.equal(state.activeEditor!.document.text, 'SELECT *\nFROM "people"\nLIMIT 100;\n');

  await run('showDDL', people);
  assert.match(state.activeEditor!.document.text, /^CREATE TABLE people \(id integer primary key, name text not null\);/);

  await run('copyName', people);
  assert.equal(state.clipboard, '"people"');
});

test('results panel protocol: ready, copy, export', async () => {
  const handler = state.resultsHandler!;
  const before = state.resultsMessages.length;
  await handler({ type: 'ready' });
  assert.equal(state.resultsMessages.length, before + 1, 'ready re-sends the current state');

  await handler({ type: 'copy', text: 'a\tb' });
  assert.equal(state.clipboard, 'a\tb');

  const out = path.join(ws, 'out.csv');
  state.saveDialogAnswers.push(out);
  await handler({ type: 'export', format: 'csv', index: 0 });
  const r = lastResults().result.statements[0];
  assert.equal(fs.readFileSync(out, 'utf8'), toCsv(r.columns, r.rows));
  assert.match(fs.readFileSync(out, 'utf8'), /^id,name\r\n1,Ada\r\n/);

  state.saveDialogAnswers.push(undefined);
  await handler({ type: 'export', format: 'json', index: 0 }); // cancelled dialog: no throw
});

test('CodeLens and history', async () => {
  const { doc } = await mock.openSql('select 1;\nselect 2;');
  const lenses = state.providers.codeLens.provideCodeLenses(doc);
  assert.deepEqual(lenses.map((l: any) => l.command.title), ['$(database) Local', '$(play) Run', '$(play) Run']);
  assert.deepEqual(lenses[2].command.arguments[1], 10);

  await run('showHistory');
  assert.ok(state.activeEditor!.document.text.length > 0);
  assert.equal(state.activeEditor!.document.languageId, 'sql');
});

test('an editor nobody bound uses the only live connection, but never guesses between several', async () => {
  const fake: FakeDriverState = { opened: 0, closed: 0, executed: [], openDelayMs: 0 };
  const reg = api.registerDriver(fakeFactory(fake));
  const tree = connectionsTree();
  const lens = async () => state.providers.codeLens.provideCodeLenses((await mock.openSql('select 1|')).doc)[0].command.title;

  assert.equal(await lens(), '$(database) Local', 'one live connection is assumed');

  await run('newConnection');
  const panel = state.panels.at(-1)!;
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'save', draft: { name: 'Second', driver: 'fake', scope: 'user', options: { host: 'h' }, secrets: { password: 'x' }, saveSecrets: true } });
  const second = (await tree.getChildren()).find((n: any) => n.id === 'second');
  await run('connect', second);
  assert.equal(await lens(), '$(plug) Select connection', 'two live connections: ask, do not guess');

  await run('disconnect', second);
  await run('deleteConnection', second); // asks for confirmation; nobody answers, so it is declined
  assert.equal(profilesInSettings()!.length, 2);
  state.messageAnswers.push('Delete');
  await run('deleteConnection', second);
  assert.deepEqual(profilesInSettings()!.map((p) => p.id), ['local']);
  assert.deepEqual([...state.secrets.keys()].filter((k) => k.includes('/second/')), [], 'its stored password is gone too');
  reg.dispose();
  assert.equal(await lens(), '$(database) Local');
});

test('passwords: stored encrypted when asked, prompted when not, never written to settings', async () => {
  const fake: FakeDriverState = { opened: 0, closed: 0, executed: [], openDelayMs: 0 };
  const reg = api.registerDriver(fakeFactory(fake));
  const secretKeys = () => [...state.secrets.keys()].filter((k) => !k.endsWith('__keys'));

  await run('newConnection');
  let panel = state.panels.at(-1)!;
  await panel.send({ type: 'ready' });
  const draft = { name: 'Remote', driver: 'fake', scope: 'user', options: { host: 'db.internal' }, secrets: { password: 'hunter2' }, saveSecrets: true };
  await panel.send({ type: 'save', draft });
  const saved = profilesInSettings()!.find((p) => p.id === 'remote')!;
  assert.deepEqual(saved.options, { host: 'db.internal' });
  assert.ok(!JSON.stringify(state.config).includes('hunter2'));
  assert.deepEqual(secretKeys(), ['betterSqlTools/remote/password']);

  const tree = connectionsTree();
  const node = (await tree.getChildren()).find((n: any) => n.id === 'remote');
  await run('connect', node);
  assert.deepEqual(fake.config?.secrets, { password: 'hunter2' });
  assert.equal(state.inputAnswers.length, 0);
  await run('disconnect', node);

  // editing without retyping keeps the stored secret; unticking "remember" forgets it
  await run('editConnection', node);
  panel = state.panels.at(-1)!;
  await panel.send({ type: 'ready' });
  assert.deepEqual(panel.last('init').storedSecrets, ['password']);
  await panel.send({ type: 'save', draft: { ...draft, secrets: {}, saveSecrets: true } });
  assert.deepEqual(secretKeys(), ['betterSqlTools/remote/password']);

  await run('editConnection', node);
  panel = state.panels.at(-1)!;
  await panel.send({ type: 'ready' });
  await panel.send({ type: 'save', draft: { ...draft, secrets: {}, saveSecrets: false } });
  assert.deepEqual(secretKeys(), []);

  state.inputAnswers.push('typed-at-prompt');
  await run('connect', node);
  assert.deepEqual(fake.config?.secrets, { password: 'typed-at-prompt' });
  await run('disconnect', node);

  // dismissing the prompt is not an error
  const errorsBefore = state.messages.filter((m) => m.kind === 'error').length;
  state.inputAnswers.push(undefined);
  await run('connect', node);
  assert.equal(state.messages.filter((m) => m.kind === 'error').length, errorsBefore);
  assert.equal(connectionsTree().getTreeItem(node).contextValue, 'connection.disconnected');

  // a missing driver is shown, not hidden
  reg.dispose();
  const orphan = (await tree.getChildren()).find((n: any) => n.id === 'remote');
  const item = tree.getTreeItem(orphan);
  assert.equal(item.contextValue, 'connection.nodriver');
  assert.match(item.description, /driver not installed/);
  assert.equal(item.command.command, 'betterSqlTools.findDrivers');
});

test('connect failures surface as an error state with a way to retry', async () => {
  const fake: FakeDriverState = { opened: 0, closed: 0, executed: [], openDelayMs: 0, failOpen: 'ECONNREFUSED 10.0.0.1:5432' };
  const reg = api.registerDriver(fakeFactory(fake));
  const tree = connectionsTree();
  const node = (await tree.getChildren()).find((n: any) => n.id === 'remote');
  state.inputAnswers.push('pw');
  await run('connect', node);
  const item = tree.getTreeItem(node);
  assert.equal(item.contextValue, 'connection.error');
  assert.equal(item.command.command, 'betterSqlTools.connect');
  assert.match(item.tooltip.value, /ECONNREFUSED/);
  const err = state.messages.filter((m) => m.kind === 'error').at(-1)!;
  assert.match(err.message, /ECONNREFUSED/);
  assert.deepEqual(err.items, ['Show Log']);
  reg.dispose();
});

test('deleting a connection removes its profile and its secrets', async () => {
  const tree = connectionsTree();
  const node = (await tree.getChildren()).find((n: any) => n.id === 'local');
  state.messageAnswers.push('Delete');
  await run('deleteConnection', node);
  assert.deepEqual(profilesInSettings()!.map((p) => p.id), ['remote']);
  assert.deepEqual((await tree.getChildren()).map((n: any) => n.id), ['remote']);
});

test('sqlfluff: diagnostics, quick fix, formatter and fix command', { skip: !hasSqlfluff }, async () => {
  const { doc } = await mock.openSql('SELECT a,b FROM people WHERE id=1\n');
  const diags = await waitFor(() => state.diagnostics.get(doc.uri.toString()));
  assert.ok(diags.length >= 3);
  assert.ok(diags.every((d: any) => d.source === 'sqlfluff' && /^[A-Z]{2}\d{2}/.test(d.code.value)));
  assert.ok(diags.every((d: any) => d.severity === 1), 'style issues use the configured severity');

  const actions = state.providers.codeActions.provideCodeActions(doc, diags[0].range, { diagnostics: diags });
  assert.equal(actions.length, 1);
  assert.equal(actions[0].command.command, 'betterSqlTools.fixDocument');
  assert.deepEqual(state.providers.codeActions.provideCodeActions(doc, diags[0].range, { diagnostics: [] }), []);

  const token = { onCancellationRequested: () => ({ dispose() {} }) };
  const edits = await state.providers.formatting.provideDocumentFormattingEdits(doc, {}, token);
  assert.equal(edits[0].newText, 'SELECT\n    a,\n    b\nFROM people\nWHERE id = 1\n');

  await run('fixDocument');
  assert.equal(doc.text, 'SELECT\n    a,\n    b\nFROM people\nWHERE id = 1\n');
  await run('fixDocument');
  assert.equal(state.messages.at(-1)!.message, 'Nothing to fix.');

  await run('lintNow');
  assert.equal(state.messages.at(-1)!.message, 'sqlfluff found no issues.');
});

test('sqlfluff: a missing executable produces one helpful notice, not a stream of errors', async () => {
  state.config.user['betterSqlTools.lint.sqlfluffPath'] = 'definitely-not-sqlfluff-xyz';
  state.messages.length = 0;
  const { doc } = await mock.openSql('select 1;\n');
  await waitFor(() => state.messages.find((m) => /not found/.test(m.message)));
  await mock.openSql('select 2;\n');
  await tick(300);
  assert.equal(state.messages.filter((m) => /not found/.test(m.message)).length, 1);
  assert.equal(state.diagnostics.get(doc.uri.toString()), undefined);
  delete state.config.user['betterSqlTools.lint.sqlfluffPath'];
});
