import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseToml } from '../src/adapters/toml/toml';
import { Emitter } from '../src/application/events';
import { GroupService } from '../src/application/group-service';
import type { GroupRepository, ProfileRepository, ProjectConfigFile, ProjectConfigSource, StoredGroup } from '../src/application/ports';
import { ProjectConfigService } from '../src/application/project-config-service';
import { ProjectAwareProfiles } from '../src/application/project-profiles';
import { ProjectManagedError } from '../src/domain/errors';
import type { ConnectionGroup, ConnectionProfile } from '../src/domain/model';
import { interpretConfig, mergeConfigs, toGroupId } from '../src/domain/project-config';
import { shortHash, slugify } from '../src/domain/slug';
import { silentLogger } from './helpers';

const ctx = { file: 'file:///ws/.better-sqltools.toml', scopeKey: 'abc123' };
const parsed = (toml: string) => {
  const r = parseToml(toml);
  assert.equal(r.error, undefined, r.error?.message);
  return r.value;
};

// ---- the TOML adapter ---------------------------------------------------------------------------------

test('toml: parses TOML 1.0, and reports a syntax error with its line instead of throwing', () => {
  assert.deepEqual(JSON.parse(JSON.stringify(parsed('a = 1\n[t]\nb = "x"\n'))), { a: 1, t: { b: 'x' } }); // smol-toml tables have no prototype
  const bad = parseToml('a = 1\nb = \n');
  assert.equal(bad.value, undefined);
  assert.ok(bad.error?.message);
  assert.equal(bad.error?.line, 2);
});

// ---- interpreting one file ----------------------------------------------------------------------------

test('interpret: connections, groups and settings', () => {
  const cfg = interpretConfig(
    parsed(`
[project]
name = "Arom backend"
group = "arom-backend"

[settings]
"results.maxRows" = 50
[settings.lint]
defaultDialect = "postgres"

[groups.arom-backend]
icon = "server"
color = "charts.blue"

[[connections]]
name = "Dev"
driver = "sqlite"
[connections.options]
path = "\${workspaceFolder}/dev.db"
readonly = true
bad = [1, 2]

[[connections]]
name = "Elsewhere"
driver = "sqlite"
group = "Personal Stuff"
`),
    ctx,
  );
  assert.deepEqual(cfg.settings, { 'results.maxRows': 50, 'lint.defaultDialect': 'postgres' });
  assert.deepEqual(cfg.groups.map((g) => [g.id, g.name, g.icon, g.color]), [['arom-backend', 'Arom backend', 'server', 'charts.blue']]);
  assert.deepEqual(
    cfg.connections.map((c) => [c.id, c.name, c.group, c.scope, c.options]),
    [
      ['dev@abc123', 'Dev', 'arom-backend', 'project', { path: '${workspaceFolder}/dev.db', readonly: true }],
      ['elsewhere@abc123', 'Elsewhere', 'personal-stuff', 'project', {}],
    ],
  );
  assert.equal(cfg.connections[0].file, ctx.file);
  assert.deepEqual(cfg.issues.map((i) => [i.severity, i.needle]), [['warning', 'bad']], 'the array option is dropped, with a warning');
});

test('interpret: [connections.id] and [[groups]] work too, and ids stay unique', () => {
  const cfg = interpretConfig(
    parsed(`
[connections.first]
name = "Same"
driver = "sqlite"
[connections.second]
name = "Same"
driver = "sqlite"
[[groups]]
id = "Ops"
name = "Operations"
`),
    ctx,
  );
  assert.deepEqual(cfg.connections.map((c) => c.id), ['first@abc123', 'second@abc123']);
  assert.deepEqual(cfg.groups.map((g) => [g.id, g.name]), [['ops', 'Operations']]);
});

test('interpret: says what it cannot use', () => {
  const cfg = interpretConfig(
    parsed(`
mystery = 1
[settings]
"results.maxRowz" = 5
"results.maxRows" = 5
[groups."bad id!"]
name = "x"
[[connections]]
name = "No driver"
[[connections]]
driver = "sqlite"
[[connections]]
name = "Odd"
driver = "sqlite"
colour = "red"
`),
    { ...ctx, knownSettings: new Set(['results.maxRows']) },
  );
  assert.deepEqual(cfg.settings, { 'results.maxRows': 5 });
  assert.deepEqual(cfg.connections.map((c) => c.name), ['Odd']);
  const messages = cfg.issues.map((i) => `${i.severity}: ${i.message}`);
  assert.equal(messages.length, 6, messages.join("\n"));
  for (const re of [/Unknown section "mystery"/, /Unknown setting "results.maxRowz"/, /not valid/, /"driver" is required/, /needs a "name"/, /unknown key "colour"/]) {
    assert.ok(messages.some((m) => re.test(m)), `${re} in\n${messages.join('\n')}`);
  }
  assert.equal(interpretConfig([1], ctx).issues[0].severity, 'error');
});

test('slugs and short hashes are stable', () => {
  assert.equal(slugify('My DB (dev)'), 'my-db-dev');
  assert.equal(slugify('???', 'x'), 'x');
  assert.equal(toGroupId('Arom-Backend'), 'arom-backend');
  assert.equal(toGroupId('Two words'), 'two-words');
  assert.equal(shortHash('file:///a'), shortHash('file:///a'));
  assert.notEqual(shortHash('file:///a'), shortHash('file:///b'));
  assert.equal(shortHash('x').length, 6);
});

// ---- merging --------------------------------------------------------------------------------------------

test('merge: the later file wins within a folder, the first folder wins across folders', () => {
  const a = interpretConfig(parsed('[settings]\n"results.maxRows" = 1\n"history.maxEntries" = 5\n[groups.g]\nname = "From a"\nicon = "server"\n'), { ...ctx, file: 'a' });
  const b = interpretConfig(parsed('[settings]\n"results.maxRows" = 2\n[groups.g]\nname = "From b"\n'), { ...ctx, file: 'b' });
  const last = mergeConfigs([a, b], 'last');
  assert.deepEqual(last.settings, { 'results.maxRows': 2, 'history.maxEntries': 5 });
  assert.deepEqual(last.groups.map((g) => [g.name, g.icon]), [['From b', 'server']], 'fields are merged, not replaced');
  assert.equal(mergeConfigs([a, b], 'first').settings['results.maxRows'], 1);
});

test('merge: the same connection in two files is reported, and the later one wins', () => {
  const one = interpretConfig(parsed('[[connections]]\nname = "Dev"\ndriver = "sqlite"\n'), { ...ctx, file: 'one' });
  const two = interpretConfig(parsed('[[connections]]\nname = "Dev"\ndriver = "other"\n'), { ...ctx, file: 'two' });
  const merged = mergeConfigs([one, two], 'last');
  assert.deepEqual(merged.connections.map((c) => [c.name, c.driver]), [['Dev', 'other']]);
  assert.equal(merged.issues.length, 1);
  assert.match(merged.issues[0].message, /more than one file/);
});

// ---- the service ---------------------------------------------------------------------------------------

class FakeSource implements ProjectConfigSource {
  files: ProjectConfigFile[] = [];
  private em = new Emitter<void>();
  onDidChange = this.em.event;
  async read() { return this.files; }
  touch() { this.em.fire(); }
}
const file = (label: string, text: string, scopeKey = 'aaaaaa'): ProjectConfigFile => ({ id: `file:///ws/${label}`, scopeKey, label, text });
const tick = (ms = 80) => new Promise((r) => setTimeout(r, ms));
const logs: string[] = [];
const loggerOf = { ...silentLogger, warn: (m: string) => void logs.push(`warn ${m}`), error: (m: string) => void logs.push(`error ${m}`) };

test('service: merges a folder\'s files, places issues on their line, and reloads when files change', async () => {
  const source = new FakeSource();
  source.files = [
    file('.better-sqltools.toml', '[settings]\n"results.maxRows" = 1\n[[connections]]\nname = "Root"\ndriver = "sqlite"\n'),
    file('.better-sqltools/dev.toml', '[settings]\n"results.maxRows" = 2\n"nope" = 1\n[[connections]]\nname = "Dev"\ndriver = "sqlite"\n'),
    file('.better-sqltools/broken.toml', 'a = 1\nb = \n'),
  ];
  const service = new ProjectConfigService(source, parseToml, () => new Set(['results.maxRows']), loggerOf, 10);
  await service.reload();
  const cfg = service.current();
  assert.equal(cfg.settings['results.maxRows'], 2, 'the directory beats the root file');
  assert.deepEqual(cfg.connections.map((c) => c.name), ['Root', 'Dev']);
  const unknown = cfg.issues.find((i) => /Unknown setting/.test(i.message))!;
  assert.equal(unknown.line, 3, 'found by the key in the file');
  assert.equal(cfg.issues.find((i) => i.severity === 'error')?.line, 2, 'TOML syntax errors carry their line');
  assert.ok(logs.some((l) => /^error .*broken\.toml:2/.test(l)));

  let fired = 0;
  service.onDidChange(() => fired++);
  source.files = source.files.slice(0, 1);
  source.touch();
  source.touch(); // several file events in a row are coalesced
  await tick();
  assert.equal(fired, 1);
  assert.deepEqual(service.current().connections.map((c) => c.name), ['Root']);
  service.dispose();
});

test('service: with several workspace folders the first one wins settings, and all contribute connections', async () => {
  const source = new FakeSource();
  source.files = [
    file('.better-sqltools.toml', '[settings]\n"results.maxRows" = 1\n[[connections]]\nname = "A"\ndriver = "sqlite"\n', 'one'),
    file('.better-sqltools.toml', '[settings]\n"results.maxRows" = 2\n[[connections]]\nname = "A"\ndriver = "sqlite"\n', 'two'),
  ];
  const service = new ProjectConfigService(source, parseToml, () => undefined, loggerOf, 10);
  await service.reload();
  assert.equal(service.current().settings['results.maxRows'], 1);
  assert.deepEqual(service.current().connections.map((c) => c.id), ['a@one', 'a@two'], 'same name, different projects, different ids');
  service.dispose();
});

// ---- profiles and groups --------------------------------------------------------------------------------

class MemoryProfiles implements ProfileRepository {
  items: ConnectionProfile[] = [];
  private em = new Emitter<void>();
  onDidChange = this.em.event;
  list() { return [...this.items]; }
  async save(p: ConnectionProfile) {
    const at = this.items.findIndex((x) => x.id === p.id);
    if (at >= 0) this.items[at] = p;
    else this.items.push(p);
    this.em.fire();
  }
  async remove(id: string) { this.items = this.items.filter((p) => p.id !== id); this.em.fire(); }
}
class MemoryGroups implements GroupRepository {
  items: StoredGroup[] = [];
  private em = new Emitter<void>();
  onDidChange = this.em.event;
  list() { return [...this.items]; }
  async save(g: ConnectionGroup, scope: 'user' | 'workspace') {
    this.items = [...this.items.filter((x) => x.id !== g.id), { ...g, scope }];
    this.em.fire();
  }
  async remove(id: string) { this.items = this.items.filter((g) => g.id !== id); this.em.fire(); }
}

async function world() {
  const source = new FakeSource();
  source.files = [file('.better-sqltools.toml', '[groups.arom]\nname = "Arom"\n[[connections]]\nname = "Dev"\ndriver = "sqlite"\ngroup = "arom"\n')];
  const project = new ProjectConfigService(source, parseToml, () => undefined, loggerOf, 10);
  await project.reload();
  const stored = new MemoryProfiles();
  const profiles = new ProjectAwareProfiles(stored, project);
  const store = new MemoryGroups();
  const groups = new GroupService({ groups: store, project, profiles });
  return { project, stored, profiles, store, groups };
}
const profile = (id: string, over: Partial<ConnectionProfile> = {}): ConnectionProfile => ({ id, name: id, driver: 'sqlite', options: {}, scope: 'user', ...over });

test('profiles: project connections are listed next to the stored ones and cannot be changed from here', async () => {
  const { stored, profiles } = await world();
  await profiles.save(profile('mine'));
  assert.deepEqual(profiles.list().map((p) => p.id), ['mine', 'dev@aaaaaa']);
  await assert.rejects(profiles.save({ ...profiles.list()[1], name: 'Renamed' }), (e: unknown) => e instanceof ProjectManagedError && /\.better-sqltools\.toml/.test(e.message));
  await assert.rejects(profiles.remove('dev@aaaaaa'), ProjectManagedError);
  await assert.rejects(profiles.save(profile('x', { scope: 'project' })), ProjectManagedError);
  assert.deepEqual(stored.items.map((p) => p.id), ['mine']);
});

test('groups: stored, project and implicit groups are listed together, by name', async () => {
  const { stored, store, groups } = await world();
  store.items = [{ id: 'personal', name: 'Personal', scope: 'user', icon: 'person' }];
  stored.items = [profile('x', { group: 'adhoc' })];
  assert.deepEqual(groups.list().map((g) => [g.id, g.scope]), [['adhoc', 'implicit'], ['arom', 'project'], ['personal', 'user']]);
  assert.equal(groups.get('arom')?.file, 'file:///ws/.better-sqltools.toml');
});

test('groups: ensure finds a group by id or name, and creates it otherwise', async () => {
  const { store, groups } = await world();
  assert.equal(await groups.ensure('Arom'), 'arom');
  assert.equal(await groups.ensure('arom'), 'arom');
  const id = await groups.ensure('Team Rocket');
  assert.equal(id, 'team-rocket');
  assert.deepEqual(store.items.map((g) => [g.id, g.name, g.scope]), [['team-rocket', 'Team Rocket', 'user']]);
  assert.equal(await groups.ensure('team rocket'), 'team-rocket', 'no duplicates');
});

test('groups: rename, remove and assign', async () => {
  const { stored, store, groups, profiles } = await world();
  store.items = [{ id: 'personal', name: 'Personal', scope: 'workspace' }];
  stored.items = [profile('a', { group: 'personal' }), profile('b', { group: 'personal' }), profile('c')];

  await groups.rename('personal', 'Private');
  assert.deepEqual(store.items.map((g) => [g.id, g.name, g.scope]), [['personal', 'Private', 'workspace']]);
  await assert.rejects(groups.rename('arom', 'Nope'), ProjectManagedError);

  await groups.assign('c', 'personal');
  assert.equal(profiles.list().find((p) => p.id === 'c')?.group, 'personal');
  await assert.rejects(groups.assign('dev@aaaaaa', 'personal'), ProjectManagedError);

  await groups.remove('personal');
  assert.deepEqual(store.items, []);
  assert.deepEqual(stored.items.map((p) => p.group), [undefined, undefined, undefined], 'the connections stay, ungrouped');
  await assert.rejects(groups.remove('arom'), ProjectManagedError);
});
