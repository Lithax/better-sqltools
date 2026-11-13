import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Driver } from '../src/application/ports';
import type { Catalog, Column } from '../src/domain/model';
import { fakeDescriptor, harness } from './fakes';

const catalog: Catalog = {
  tables: [
    {
      name: 'books', kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true, nullable: false, autoIncrement: true },
        { name: 'title', type: 'TEXT', kind: 'text', nullable: false },
      ],
    },
  ],
};

interface Behaviour {
  catalogDelayMs?: number;
  catalogError?: string;
  columns?: Column[];
  catalogCalls: number;
}

/** A driver whose catalog can be slow or broken, and whose result columns are whatever the test says. */
function setup(b: Behaviour) {
  const h = harness();
  h.registry.register({
    descriptor: fakeDescriptor,
    create() {
      const driver: Driver = {
        async open() {},
        async close() {},
        async execute(sql) {
          if (/^select/i.test(sql)) return { columns: b.columns ?? [{ name: 'id' }, { name: 'title' }], rows: [[1, 'Dune']], truncated: false };
          return { columns: [], rows: [], affectedRows: 1 };
        },
        async children() { return []; },
        async catalog() {
          b.catalogCalls++;
          if (b.catalogDelayMs) await new Promise((r) => setTimeout(r, b.catalogDelayMs));
          if (b.catalogError) throw new Error(b.catalogError);
          return catalog;
        },
      };
      return driver;
    },
  });
  return h;
}
const connect = async (h: ReturnType<typeof setup>) => {
  await h.profiles.save(h.profile);
  await h.secrets.set('c1', 'password', 'x');
  await h.connections.connect('c1');
};

test('results: columns read from a table carry what the catalog says about them', async () => {
  const b: Behaviour = { catalogCalls: 0 };
  const h = setup(b);
  await connect(h);
  const [r] = (await h.queries.run('c1', 'select * from books')).statements;
  assert.deepEqual(r.columns[0], { name: 'id', type: 'INTEGER', kind: 'integer', notNull: true, primaryKey: true, autoIncrement: true, source: { table: 'books', column: 'id' } });
  assert.deepEqual(r.columns[1], { name: 'title', type: 'TEXT', kind: 'text', notNull: true, source: { table: 'books', column: 'title' } });
});

test('results: a slow catalog does not hold the result up, and the next run has it', async () => {
  const b: Behaviour = { catalogDelayMs: 700, catalogCalls: 0 };
  const h = setup(b);
  await connect(h);
  const t0 = Date.now();
  const [first] = (await h.queries.run('c1', 'select * from books')).statements;
  assert.ok(Date.now() - t0 < 600, `the result came back after ${Date.now() - t0} ms, not after the catalog`);
  assert.deepEqual(first.columns, [{ name: 'id' }, { name: 'title' }], 'plain columns: nothing was known yet');
  assert.deepEqual(first.rows, [[1, 'Dune']], 'the rows are all there');

  await new Promise((r) => setTimeout(r, 800)); // the catalog finishes loading in the background
  const [second] = (await h.queries.run('c1', 'select * from books')).statements;
  assert.equal(second.columns[0].primaryKey, true);
  assert.equal(b.catalogCalls, 1, 'one load served both runs');
});

test('results: a catalog that cannot be loaded costs the result nothing', async () => {
  const b: Behaviour = { catalogError: 'permission denied for schema', catalogCalls: 0 };
  const h = setup(b);
  await connect(h);
  const run = await h.queries.run('c1', 'select * from books');
  assert.equal(run.statements[0].error, undefined);
  assert.deepEqual(run.statements[0].columns, [{ name: 'id' }, { name: 'title' }]);
});

test('results: the catalog is only consulted when a statement returns columns, and once per run', async () => {
  const b: Behaviour = { catalogCalls: 0 };
  const h = setup(b);
  await connect(h);
  await h.schema.catalog('c1'); // the load that starts when a connection opens
  h.schema.invalidate('c1');
  const loads = b.catalogCalls;
  await h.queries.run('c1', 'update books set title = 1; delete from books');
  assert.equal(b.catalogCalls, loads, 'statements without columns never need it');
  await h.queries.run('c1', 'select * from books; select id from books; select title from books');
  assert.equal(b.catalogCalls, loads + 1);
});

test('results: what the driver reports about a column wins, and its source is believed', async () => {
  const b: Behaviour = {
    catalogCalls: 0,
    columns: [{ name: 'id', type: 'BIGSERIAL', kind: 'integer' }, { name: 'label', source: { table: 'books', column: 'title' } }],
  };
  const h = setup(b);
  await connect(h);
  const [r] = (await h.queries.run('c1', 'select id, title as label from (select * from books) b')).statements;
  assert.equal(r.columns[0].type, 'BIGSERIAL', 'the first column could not be traced, so it stays as the driver gave it');
  assert.equal(r.columns[0].primaryKey, undefined);
  assert.deepEqual(r.columns[1], { name: 'label', type: 'TEXT', kind: 'text', notNull: true, source: { table: 'books', column: 'title' } });
});

test('results: expressions and joins the inference cannot follow stay plain', async () => {
  const b: Behaviour = { catalogCalls: 0, columns: [{ name: 'n' }] };
  const h = setup(b);
  await connect(h);
  const [r] = (await h.queries.run('c1', 'select count(*) as n from books')).statements;
  assert.deepEqual(r.columns, [{ name: 'n' }]);
});
