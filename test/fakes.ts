import { ConnectionManager } from '../src/application/connection-manager';
import { DriverRegistry } from '../src/application/driver-registry';
import { Emitter } from '../src/application/events';
import type {
  Driver, DriverFactory, HistoryRepository, ProfileRepository, SecretPrompter, SecretStore, SettingsReader,
} from '../src/application/ports';
import { QueryService } from '../src/application/query-service';
import { SchemaService } from '../src/application/schema-service';
import type { DriverDescriptor } from '../src/domain/driver-descriptor';
import type { ConnectionProfile, HistoryEntry } from '../src/domain/model';
import { silentLogger, testEnv } from './helpers';

export class MemoryProfiles implements ProfileRepository {
  items: ConnectionProfile[] = [];
  private em = new Emitter<void>();
  onDidChange = this.em.event;
  list() { return [...this.items]; }
  async save(p: ConnectionProfile) {
    this.items = [...this.items.filter((x) => x.id !== p.id), p];
    this.em.fire();
  }
  async remove(id: string) {
    this.items = this.items.filter((x) => x.id !== id);
    this.em.fire();
  }
}

export class MemorySecrets implements SecretStore {
  data = new Map<string, string>();
  async get(id: string, key: string) { return this.data.get(`${id}/${key}`); }
  async set(id: string, key: string, v: string) { this.data.set(`${id}/${key}`, v); }
  async deleteAll(id: string) { for (const k of [...this.data.keys()]) if (k.startsWith(`${id}/`)) this.data.delete(k); }
}

export class MemoryHistory implements HistoryRepository {
  entries: HistoryEntry[] = [];
  async add(e: HistoryEntry) { this.entries.unshift(e); }
  list() { return this.entries; }
  async clear() { this.entries = []; }
}

export const settings: SettingsReader = {
  maxRows: () => 100,
  connectTimeoutMs: () => 500,
  historyLimit: () => 50,
  defaultDialect: () => 'ansi',
};

export const fakeDescriptor: DriverDescriptor = {
  id: 'fake',
  displayName: 'Fake DB',
  dialect: { identifierQuote: { open: '"', close: '"' }, limit: 'limit', sqlfluff: 'postgres' },
  capabilities: {},
  connectionSchema: [
    { key: 'host', label: 'Host', type: 'string', required: true },
    { key: 'port', label: 'Port', type: 'number', default: 5432 },
    { key: 'password', label: 'Password', type: 'password', required: true },
  ],
};

export interface FakeDriverState {
  opened: number;
  closed: number;
  executed: string[];
  config?: { options: Record<string, unknown>; secrets: Record<string, string> };
  openDelayMs: number;
  failOpen?: string;
}

export function fakeFactory(state: FakeDriverState, tree?: Driver['children']): DriverFactory {
  return {
    descriptor: fakeDescriptor,
    create(config) {
      state.config = config;
      const driver: Driver = {
        async open() {
          if (state.openDelayMs) await new Promise((r) => setTimeout(r, state.openDelayMs));
          if (state.failOpen) throw new Error(state.failOpen);
          state.opened++;
        },
        async close() { state.closed++; },
        async execute(sql) {
          state.executed.push(sql);
          if (/boom/i.test(sql)) throw Object.assign(new Error('boom!'), { code: 'XX001' });
          if (/^select/i.test(sql)) {
            return { columns: [{ name: 'n' }, { name: 'big' }], rows: [[1, 10n ** 20n], [2, null]], truncated: false };
          }
          return { columns: [], rows: [], affectedRows: 1 };
        },
        children: tree ?? (async () => []),
      };
      return driver;
    },
  };
}

export function harness(opts: { prompt?: string | undefined } = {}) {
  const registry = new DriverRegistry();
  const profiles = new MemoryProfiles();
  const secrets = new MemorySecrets();
  const history = new MemoryHistory();
  const state: FakeDriverState = { opened: 0, closed: 0, executed: [], openDelayMs: 0 };
  const prompts: string[] = [];
  const prompter: SecretPrompter = {
    async prompt({ field }) { prompts.push(field.key); return 'prompt' in opts ? opts.prompt : 'typed-at-prompt'; },
  };
  const connections = new ConnectionManager({
    registry, profiles, secrets, prompter, settings, logger: silentLogger, env: testEnv(),
    resolveVariables: (s) => s.replace('${home}', '/home/test').replace('${unset}', ''),
  });
  const schema = new SchemaService(connections, silentLogger);
  const queries = new QueryService({ connections, schema, history, settings, logger: silentLogger });
  const profile: ConnectionProfile = { id: 'c1', name: 'Conn One', driver: 'fake', options: { host: '${home}/db' } };
  return { registry, profiles, secrets, history, state, prompts, connections, schema, queries, profile };
}
