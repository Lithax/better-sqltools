/** The shipped artifacts, not the sources: activate the bundles and run a query through them. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { installVscodeMock } from './vscode-mock';
import { tmpDir } from './helpers';

const root = path.join(__dirname, '..');
// BST_BUNDLE / BST_DRIVER_BUNDLE let CI point this at the copies extracted from the .vsix files
const coreBundle = process.env.BST_BUNDLE ?? path.join(root, 'dist', 'extension.js');
const driverBundle = process.env.BST_DRIVER_BUNDLE ?? path.join(root, 'drivers', 'sqlite', 'dist', 'extension.js');
const built = fs.existsSync(coreBundle) && fs.existsSync(driverBundle);

test('the production bundles activate, the driver finds its WASM, and SQL runs', { skip: !built && 'run "npm run build" first' }, async () => {
  assert.ok(fs.existsSync(path.join(path.dirname(driverBundle), 'sql-wasm.wasm')), 'the WASM ships next to the driver bundle');
  const mock = installVscodeMock(tmpDir());
  const { state, vscode } = mock;
  state.config.user['betterSqlTools.connections'] = [{ id: 'b', name: 'Bundle', driver: 'sqlite', options: { path: ':memory:' } }];

  const core = require(coreBundle);
  const api = await core.activate(mock.context);
  assert.equal(api.apiVersion, 1);

  // the driver is its own extension: activate its bundle against the real core API, as VS Code would
  mock.addExtension({ id: 'better-sqltools.better-sqltools', packageJSON: {}, activate: () => api });
  const driver = require(driverBundle);
  const driverContext = { subscriptions: [] as { dispose(): void }[] };
  await driver.activate(driverContext);
  assert.equal(driverContext.subscriptions.length, 1, 'the driver registered itself');

  const tree = state.treeProviders['betterSqlTools.connections'];
  await vscode.commands.executeCommand('betterSqlTools.connect', (await tree.getChildren())[0]);
  await mock.openSql('create table t (x); insert into t values (1), (2); select sum(x) as total from t;');
  await vscode.commands.executeCommand('betterSqlTools.runFile');

  const done = [...state.resultsMessages].reverse().find((m) => m.type === 'state').state;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result.statements.at(-1).rows, [[3]]);

  for (const d of driverContext.subscriptions) d.dispose();
  await core.deactivate();
  mock.uninstall();
});
