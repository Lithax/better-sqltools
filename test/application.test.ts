import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Driver } from '../src/application/ports';
import { walkCatalog } from '../src/application/schema-service';
import { CancelledError, DriverNotFoundError, ValidationError } from '../src/domain/errors';
import type { SchemaNode } from '../src/domain/model';
import { fakeDescriptor, fakeFactory, harness } from './fakes';

test('registry: validates, rejects duplicates, unregisters, announces changes', () => {
  const h = harness();
  let changes = 0;
  h.registry.onDidChange(() => changes++);
  const d = h.registry.register(fakeFactory(h.state));
  assert.throws(() => h.registry.register(fakeFactory(h.state)), /already registered/);
  assert.throws(() => h.registry.register({ descriptor: { ...fakeDescriptor, id: '!!' }, create: () => { throw new Error(); } }), ValidationError);
  assert.equal(h.registry.list().length, 1);
  d.dispose();
  assert.equal(h.registry.get('fake'), undefined);
  assert.throws(() => h.registry.require('fake'), DriverNotFoundError);
  assert.equal(changes, 2);
});

test('connect: validates options, resolves variables, passes secrets separately', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 's3cret');

  const s = await h.connections.connect('c1');
  assert.equal(s.descriptor.id, 'fake');
  assert.deepEqual(h.state.config?.options, { host: '/home/test/db', port: 5432 }); // default applied, no password in options
  assert.deepEqual(h.state.config?.secrets, { password: 's3cret' });
  assert.equal(h.connections.info('c1')?.state, 'connected');
  assert.equal(h.prompts.length, 0, 'stored secret means no prompt');
});

test('connect: prompts when a required secret is missing, and cancelling is not an error state', async () => {
  const h = harness({ prompt: undefined });
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await assert.rejects(() => h.connections.connect('c1'), CancelledError);
  assert.deepEqual(h.prompts, ['password']);
  assert.equal(h.connections.info('c1')?.state, 'disconnected');

  const h2 = harness({ prompt: 'from-prompt' });
  h2.registry.register(fakeFactory(h2.state));
  await h2.profiles.save(h2.profile);
  await h2.connections.connect('c1');
  assert.equal(h2.state.config?.secrets.password, 'from-prompt');
});

test('connect: a password written inline in settings is honoured as a fallback', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save({ ...h.profile, options: { host: 'x', password: 'inline' } });
  await h.connections.connect('c1');
  assert.equal(h.state.config?.secrets.password, 'inline');
  assert.equal('password' in (h.state.config?.options ?? {}), false);
});

test('connect: concurrent calls share one connection attempt', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  h.state.openDelayMs = 30;
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');
  const [a, b] = await Promise.all([h.connections.connect('c1'), h.connections.connect('c1')]);
  assert.equal(a, b);
  assert.equal(h.state.opened, 1);
});

test('connect: failures are recorded, timeouts are enforced, driver is closed', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');

  h.state.failOpen = 'ECONNREFUSED';
  await assert.rejects(() => h.connections.connect('c1'), /ECONNREFUSED/);
  assert.equal(h.connections.info('c1')?.state, 'error');
  assert.match(h.connections.info('c1')?.error ?? '', /ECONNREFUSED/);
  assert.equal(h.state.closed, 1);

  h.state.failOpen = undefined;
  h.state.openDelayMs = 2000; // settings timeout is 500ms
  await assert.rejects(() => h.connections.connect('c1'), /Timed out/);
});

test('connect: missing driver and bad options give actionable errors', async () => {
  const h = harness();
  await h.profiles.save(h.profile);
  await assert.rejects(() => h.connections.connect('c1'), DriverNotFoundError);
  assert.equal(h.connections.info('c1')?.descriptor, undefined);

  h.registry.register(fakeFactory(h.state));
  await h.profiles.save({ ...h.profile, options: {} });
  await assert.rejects(() => h.connections.connect('c1'), /"Host" is required/);
});

test('test(): works for an unsaved draft using typed secrets, and always closes', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.connections.test({ profile: { ...h.profile, id: 'draft' }, secrets: { password: 'typed' } });
  assert.equal(h.state.config?.secrets.password, 'typed');
  assert.equal(h.state.opened, 1);
  assert.equal(h.state.closed, 1);
  assert.equal(h.connections.list().length, 0, 'nothing was saved');
});

test('disconnect / profile removal / driver change drop sessions', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');
  await h.connections.connect('c1');
  await h.profiles.save({ ...h.profile, options: { host: 'other' } }); // edited → reconnect needed
  await new Promise((r) => setImmediate(r));
  assert.equal(h.connections.session('c1'), undefined);
  assert.equal(h.state.closed, 1);

  await h.connections.connect('c1');
  await h.profiles.remove('c1');
  await new Promise((r) => setImmediate(r));
  assert.equal(h.connections.session('c1'), undefined);
});

test('query: splits, normalises cells, stops on first error, records history', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');

  const r = await h.queries.run('c1', 'select 1; update t set a = 1; boom; select 3');
  assert.equal(r.statements.length, 3, 'stopped after the failing statement');
  assert.deepEqual(r.statements[0].rows, [[1, '100000000000000000000'], [2, null]], 'bigint became a string');
  assert.equal(r.statements[1].affectedRows, 1);
  assert.deepEqual(r.statements[2].error, { message: 'boom!', code: 'XX001' });
  assert.equal(r.statements[2].columns.length, 0);
  assert.deepEqual(h.state.executed, ['select 1', 'update t set a = 1', 'boom']);
  JSON.stringify(r); // webview transport must not throw

  assert.equal(h.history.entries.length, 1);
  assert.equal(h.history.entries[0].ok, false);
  assert.equal(h.history.entries[0].connectionName, 'Conn One');
});

test('query: continueOnError, cancellation, and schema invalidation on DDL', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');

  const r = await h.queries.run('c1', 'boom; select 2', { continueOnError: true });
  assert.equal(r.statements.length, 2);

  const ac = new AbortController();
  ac.abort();
  const c = await h.queries.run('c1', 'select 1; select 2', { signal: ac.signal });
  assert.equal(c.cancelled, true);
  assert.equal(c.statements.length, 0);

  let invalidated = 0;
  h.schema.onDidInvalidate(() => invalidated++);
  await h.queries.run('c1', 'select 1');
  assert.equal(invalidated, 0);
  await h.queries.run('c1', 'create table x (a int)');
  assert.equal(invalidated, 1);
});

test('query: huge scripts keep rows and errors but trim the quiet results', async () => {
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');
  const script = Array.from({ length: 500 }, (_, i) => `insert into t values (${i});`).join('\n') + '\nselect 1;';
  const r = await h.queries.run('c1', script);
  assert.equal(r.statements.length, 21); // 20 quiet + the SELECT
  assert.equal(r.omitted, 480);
  assert.ok(r.statements.some((s) => s.columns.length > 0));
});

test('walkCatalog derives a catalog from children() alone', async () => {
  const n = (id: string, kind: SchemaNode['kind'], label: string, expandable = true, description?: string): SchemaNode => ({ id, kind, label, expandable, description });
  const tree: Record<string, SchemaNode[]> = {
    '': [n('s:public', 'schema', 'public'), n('s:audit', 'schema', 'audit')],
    's:public': [n('f:t', 'folder', 'Tables'), n('f:v', 'folder', 'Views')],
    'f:t': [n('t:users', 'table', 'users')],
    'f:v': [n('v:recent', 'view', 'recent')],
    't:users': [n('c:id', 'column', 'id', false, 'int'), n('c:email', 'column', 'email', false, 'text')],
    'v:recent': [n('c:x', 'column', 'x', false)],
    's:audit': [],
  };
  const driver = { children: async (p?: SchemaNode) => tree[p?.id ?? ''] ?? [] } as unknown as Driver;
  const cat = await walkCatalog(driver);
  assert.deepEqual(cat.schemas, ['public', 'audit']);
  assert.deepEqual(cat.tables.map((t) => `${t.schema}.${t.name}:${t.kind}:${t.columns.map((c) => c.name)}`), [
    'public.users:table:id,email',
    'public.recent:view:x',
  ]);
});

test('schema service: caches catalog, warms on connect, clears on disconnect', async () => {
  const h = harness();
  let calls = 0;
  h.registry.register({
    ...fakeFactory(h.state),
    create(cfg, env) {
      const d = fakeFactory(h.state).create(cfg, env) as Driver;
      d.catalog = async () => { calls++; return { tables: [{ name: 't', kind: 'table', columns: [] }] }; };
      return d;
    },
  });
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');
  await h.connections.connect('c1');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(calls, 1, 'warmed once after connect');
  assert.ok(h.schema.cachedCatalog('c1'));
  await h.schema.catalog('c1');
  assert.equal(calls, 1, 'cache hit');
  h.schema.invalidate('c1');
  await h.schema.catalog('c1');
  assert.equal(calls, 2);
  await h.connections.disconnect('c1');
  assert.equal(h.schema.cachedCatalog('c1'), undefined);
});

test('lint dialect follows the connection, else the setting', async () => {
  const { LintService } = await import('../src/application/lint-service');
  const { settings } = await import('./fakes');
  const h = harness();
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save(h.profile);
  const lint = new LintService({ lint: async () => [], fix: async (r) => r.dialect, format: async (r) => r.dialect }, h.connections, settings);
  assert.equal(lint.dialectFor('c1'), 'postgres');
  assert.equal(lint.dialectFor('missing'), 'ansi');
  assert.equal(lint.dialectFor(), 'ansi');
  assert.equal(await lint.fix({ text: '', connectionId: 'c1' }), 'postgres');
});

test('connect: variables in an inline password are expanded; an unset one prompts instead of becoming an empty password', async () => {
  const h = harness({ prompt: 'typed' });
  h.registry.register(fakeFactory(h.state));
  await h.profiles.save({ ...h.profile, options: { host: 'x', password: 'pw-${home}' } });
  await h.connections.connect('c1');
  assert.equal(h.state.config?.secrets.password, 'pw-/home/test');
  assert.deepEqual(h.prompts, []);

  await h.connections.disconnect('c1');
  await h.profiles.save({ ...h.profile, options: { host: 'x', password: '${unset}' } });
  await h.connections.connect('c1');
  assert.deepEqual(h.prompts, ['password']);
  assert.equal(h.state.config?.secrets.password, 'typed');
});
