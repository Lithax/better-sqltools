import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? sourceFiles(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

const declaredCommands: string[] = pkg.contributes.commands.map((c: { command: string }) => c.command);
const viewIds: string[] = Object.values<{ id: string }[]>(pkg.contributes.views).flat().map((v) => v.id);
const configKeys = Object.keys(pkg.contributes.configuration.properties);

test('every contributed command has a handler, and every handler is contributed', () => {
  const registered = [...read('src/adapters/vscode/commands.ts').matchAll(/\bcmd\('([A-Za-z]+)'/g)].map((m) => `betterSqlTools.${m[1]}`);
  assert.deepEqual([...registered].sort(), [...declaredCommands].sort());
});

test('menus, keybindings and welcome content only reference contributed commands', () => {
  const used = new Set<string>();
  for (const group of Object.values<{ command: string }[]>(pkg.contributes.menus)) group.forEach((m) => used.add(m.command));
  pkg.contributes.keybindings.forEach((k: { command: string }) => used.add(k.command));
  for (const w of pkg.contributes.viewsWelcome) for (const m of w.contents.matchAll(/command:([\w.]+)/g)) used.add(m[1]);
  assert.deepEqual([...used].filter((c) => !declaredCommands.includes(c)), []);
});

test('menu "view ==" clauses name declared views', () => {
  const mentioned = new Set<string>();
  for (const group of Object.values<{ when?: string }[]>(pkg.contributes.menus)) {
    for (const m of group) for (const x of (m.when ?? '').matchAll(/view == ([\w.]+)/g)) mentioned.add(x[1]);
  }
  assert.deepEqual([...mentioned].filter((v) => !viewIds.includes(v)), []);
});

test('every betterSqlTools.* identifier in the source is a command, view, setting or known id', () => {
  const known = new Set<string>([...declaredCommands, ...viewIds, 'betterSqlTools.connectionForm', 'betterSqlTools.history', 'betterSqlTools.bindings', 'betterSqlTools.hasDrivers']);
  const sections = new Set(configKeys.flatMap((k) => k.split('.').map((_, i, a) => a.slice(0, i + 1).join('.'))));
  const unknown: string[] = [];
  for (const f of sourceFiles('src')) {
    for (const m of read(f).matchAll(/'(betterSqlTools(?:\.[A-Za-z]+)*)'/g)) {
      if (!known.has(m[1]) && !sections.has(m[1]) && !m[1].endsWith('.focus')) unknown.push(`${f}: ${m[1]}`);
    }
  }
  assert.deepEqual(unknown, []);
});

test('every setting read in code is declared with a default', () => {
  const src = read('src/adapters/vscode/settings.ts');
  const keys = [...src.matchAll(/get(?:<[^>]*>)?\('([\w.]+)'/g)].map((m) => `betterSqlTools.${m[1]}`);
  assert.ok(keys.length >= 10);
  assert.deepEqual(keys.filter((k) => !configKeys.includes(k)), []);
  for (const k of configKeys) assert.ok('default' in pkg.contributes.configuration.properties[k], `${k} has a default`);
});

test('files the manifest and the webview shell point at exist', () => {
  const containers = Object.values<{ icon: string }[]>(pkg.contributes.viewsContainers).flat();
  for (const c of containers) assert.ok(fs.existsSync(path.join(root, c.icon)), c.icon);
  for (const f of ['common.css', 'results.css', 'results.js', 'connection-form.css', 'connection-form.js']) {
    assert.ok(fs.existsSync(path.join(root, 'media', f)), f);
  }
  assert.equal(pkg.main, './dist/extension.js');
});

test('engine and typings agree, and secrets-sensitive settings are restricted in untrusted workspaces', () => {
  assert.equal(pkg.engines.vscode.replace('^', ''), pkg.devDependencies['@types/vscode']);
  const restricted: string[] = pkg.capabilities.untrustedWorkspaces.restrictedConfigurations;
  for (const k of ['betterSqlTools.connections', 'betterSqlTools.lint.sqlfluffPath', 'betterSqlTools.lint.sqlfluffArgs']) {
    assert.ok(restricted.includes(k), k);
  }
});

test('context values produced by the tree match the menu regexes', () => {
  const trees = read('src/adapters/vscode/trees.ts');
  assert.match(trees, /`connection\.\$\{info\.state\}`/);
  assert.match(trees, /'connection\.nodriver'/);
  assert.match(trees, /`node\.\$\{n\.kind\}`/);
  const whens = Object.values<{ when?: string }[]>(pkg.contributes.menus).flat().map((m) => m.when ?? '').join('\n');
  for (const needle of ['connection.connected', 'connection\\.(disconnected|error)', 'node\\.(table|view)']) assert.ok(whens.includes(needle), needle);
});
