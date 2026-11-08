import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { ConnectionManager } from '../src/application/connection-manager';
import { DriverRegistry } from '../src/application/driver-registry';
import { QueryService } from '../src/application/query-service';
import { SchemaService } from '../src/application/schema-service';
import { EchoDriverFactory } from '../examples/driver-template/driver';
import { MemoryHistory, MemoryProfiles, MemorySecrets, settings } from './fakes';
import { silentLogger, testEnv } from './helpers';

const root = path.join(__dirname, '..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');

test('the driver guide quotes the template files verbatim', () => {
  const guide = read('docs/WRITING_A_DRIVER.md');
  assert.ok(guide.includes(read('examples/driver-template/driver.ts').trimEnd()), 'driver.ts is in the guide');
  assert.ok(guide.includes(read('examples/driver-template/extension.ts').trimEnd()), 'extension.ts is in the guide');
  assert.ok(!guide.includes('@@'), 'no unfilled placeholders');
});

test('the template driver works end to end through the registry and the core', async () => {
  const registry = new DriverRegistry();
  registry.register(new EchoDriverFactory());
  const profiles = new MemoryProfiles();
  const secrets = new MemorySecrets();
  await profiles.save({ id: 'e', name: 'Echo', driver: 'example.echo', options: {} });

  const connections = new ConnectionManager({
    registry, profiles, secrets, settings, logger: silentLogger, env: testEnv(), resolveVariables: (s) => s,
    prompter: { prompt: async ({ field }) => (field.key === 'token' ? 'tok' : undefined) },
  });
  const schema = new SchemaService(connections, silentLogger);
  const queries = new QueryService({ connections, schema, history: new MemoryHistory(), settings, logger: silentLogger });

  const r = await queries.run('e', 'select 1; select 2');
  assert.deepEqual(r.statements.map((s) => s.rows), [[['hello', 'select 1']], [['hello', 'select 2']]]);
  assert.deepEqual((await schema.catalog('e')).tables.map((t) => t.name), ['echoes']);
  const [table] = await schema.children('e');
  assert.deepEqual((await schema.children('e', table)).map((c) => c.label), ['greeting', 'statement']);

  await connections.disconnect('e');
  await assert.rejects(() => new EchoDriverFactory().create({ options: {}, secrets: {} }).open(), /token is required/);
});
