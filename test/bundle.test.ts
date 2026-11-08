/** The shipped artifact, not the sources: activate dist/extension.js and run a query through it. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { installVscodeMock } from './vscode-mock';
import { tmpDir } from './helpers';

// BST_BUNDLE lets CI point this at the copy extracted from the .vsix
const bundle = process.env.BST_BUNDLE ?? path.join(__dirname, '..', 'dist', 'extension.js');

test('the production bundle activates, finds its WASM, and runs SQL', { skip: !fs.existsSync(bundle) && 'run "npm run build" first' }, async () => {
  assert.ok(fs.existsSync(path.join(path.dirname(bundle), 'sql-wasm.wasm')), 'the WASM ships next to the bundle');
  const mock = installVscodeMock(tmpDir());
  const { state, vscode } = mock;
  state.config.user['betterSqlTools.connections'] = [{ id: 'b', name: 'Bundle', driver: 'sqlite', options: { path: ':memory:' } }];

  const ext = require(bundle);
  const api = await ext.activate(mock.context);
  assert.equal(api.apiVersion, 1);

  const tree = state.treeProviders['betterSqlTools.connections'];
  await vscode.commands.executeCommand('betterSqlTools.connect', (await tree.getChildren())[0]);
  await mock.openSql("create table t (x); insert into t values (1), (2); select sum(x) as total from t;");
  await vscode.commands.executeCommand('betterSqlTools.runFile');

  const done = [...state.resultsMessages].reverse().find((m) => m.type === 'state').state;
  assert.equal(done.status, 'done');
  assert.deepEqual(done.result.statements.at(-1).rows, [[3]]);

  await ext.deactivate();
  mock.uninstall();
});
