import assert from 'node:assert/strict';
import { test } from 'node:test';
import { EditService, EditSession, type EditMode } from '../src/application/edit-service';
import type { Driver, DriverEdit, RowChange, RowChangeResult } from '../src/application/ports';
import { editTarget } from '../src/domain/editing';
import type { Catalog, Cell, Column, StatementResult } from '../src/domain/model';

const catalog: Catalog = {
  defaultSchema: 'main',
  tables: [
    {
      schema: 'main', name: 'books', kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true, nullable: false, autoIncrement: true },
        { name: 'title', type: 'VARCHAR(10)', kind: 'text', nullable: false },
        { name: 'price', type: 'DECIMAL(8,2)', kind: 'decimal' },
        { name: 'cover', type: 'BLOB', kind: 'binary' },
      ],
    },
  ],
};

const src = (column: string): Column['source'] => ({ schema: 'main', table: 'books', column });
const columns = (): Column[] => [
  { name: 'id', kind: 'integer', type: 'INTEGER', notNull: true, primaryKey: true, source: src('id') },
  { name: 'title', kind: 'text', type: 'VARCHAR(10)', notNull: true, source: src('title') },
  { name: 'price', kind: 'decimal', type: 'DECIMAL(8,2)', source: src('price') },
  { name: 'cover', kind: 'binary', type: 'BLOB', source: src('cover') },
];
const statement = (rows?: Cell[][]): StatementResult => ({
  index: 0, sql: 'select * from books', columns: columns(), truncated: false, durationMs: 1,
  rows: rows ?? [
    [1, 'Dune', 9.5, { bytes: 4 } as unknown as Cell],
    [2, 'Emma', null, null],
  ],
});

interface FakeOptions {
  transactions?: boolean;
  update?: (change: RowChange) => Promise<RowChangeResult>;
  commit?: () => Promise<void>;
  rollback?: () => Promise<void>;
}

function fake(options: FakeOptions = {}) {
  const calls: string[] = [];
  const updates: RowChange[] = [];
  const edit: DriverEdit = {
    async update(change) {
      calls.push('update');
      updates.push(change);
      return options.update ? options.update(change) : { affectedRows: 1 };
    },
  };
  if (options.transactions !== false) {
    edit.begin = async () => void calls.push('begin');
    edit.commit = async () => {
      calls.push('commit');
      await options.commit?.();
    };
    edit.rollback = async () => {
      calls.push('rollback');
      await options.rollback?.();
    };
  }
  return { driver: { edit } as unknown as Driver, calls, updates };
}

function open(f: ReturnType<typeof fake>, mode: EditMode, st = statement()) {
  return { st, session: new EditSession({ statement: st, target: editTarget(st.columns, catalog), driver: f.driver, mode }) };
}

test('autoCommit: an edit is one update, found by the key of the host copy, and the copy changes', async () => {
  const f = fake();
  const { st, session } = open(f, 'autoCommit');
  const out = await session.edit(1, 1, 'Emma!');
  assert.deepEqual(out, { ok: true, value: 'Emma!', changed: true });
  assert.deepEqual(f.calls, ['update'], 'no transaction in autoCommit');
  assert.deepEqual(f.updates[0], {
    table: { schema: 'main', name: 'books' },
    key: [{ column: 'id', value: 2 }],
    set: [{ column: 'title', value: 'Emma!' }],
  });
  assert.equal(st.rows[1][1], 'Emma!');
  assert.equal(session.status().pending.length, 0);
  assert.equal(session.status().transaction, false);
});

test('an edit that changes nothing does not reach the driver', async () => {
  const f = fake();
  const { session } = open(f, 'manual');
  assert.deepEqual(await session.edit(0, 1, 'Dune'), { ok: true, value: 'Dune', changed: false });
  assert.deepEqual(await session.edit(0, 0, '1'), { ok: true, value: 1, changed: false });
  assert.deepEqual(f.calls, []);
});

test('a value the column refuses never reaches the driver', async () => {
  const f = fake();
  const { st, session } = open(f, 'autoCommit');
  const cases: [number, number, string | null, RegExp][] = [
    [0, 0, 'abc', /whole number/],
    [0, 1, null, /cannot be NULL/],
    [0, 1, 'far too long a title', /At most 10/],
    [0, 2, '1.234', /decimal places/],
  ];
  for (const [row, col, text, message] of cases) {
    const out = await session.edit(row, col, text);
    assert.equal(out.ok, false);
    assert.match((out as { error: string }).error, message);
  }
  assert.deepEqual(f.calls, []);
  assert.deepEqual(st.rows[0].slice(0, 3), [1, 'Dune', 9.5]);
});

test('cells that cannot be edited, and cells that are not there', async () => {
  const f = fake();
  const { session } = open(f, 'autoCommit');
  const blob = await session.edit(0, 3, 'x');
  assert.equal(blob.ok, false);
  assert.match((blob as { error: string }).error, /Binary/);
  for (const [row, col] of [[5, 0], [0, 9], [-1, 0], [0, 1.5]]) {
    const out = await session.edit(row, col, 'x');
    assert.deepEqual(out, { ok: false, error: 'There is no such cell.' });
  }
  assert.deepEqual(f.calls, []);
});

test('the database has the last word: its read-back value is what the grid shows', async () => {
  const f = fake({ update: async () => ({ affectedRows: 1, values: { title: 'DUNE' } }) });
  const { st, session } = open(f, 'autoCommit');
  assert.deepEqual(await session.edit(0, 1, 'dune'), { ok: true, value: 'DUNE', changed: true });
  assert.equal(st.rows[0][1], 'DUNE');
});

test('after the key itself is edited, the next edit finds the row by the new key', async () => {
  const f = fake();
  const { session } = open(f, 'autoCommit');
  await session.edit(0, 0, '10');
  await session.edit(0, 1, 'Dune II');
  assert.deepEqual(f.updates[0].key, [{ column: 'id', value: 1 }]);
  assert.deepEqual(f.updates[1].key, [{ column: 'id', value: 10 }]);
});

test('a row whose key is empty cannot be found again', async () => {
  const f = fake();
  const { session } = open(f, 'autoCommit', statement([[null, 'Ghost', 1, null]]));
  const out = await session.edit(0, 1, 'Boo');
  assert.equal(out.ok, false);
  assert.match((out as { error: string }).error, /primary key/);
  assert.deepEqual(f.calls, []);
});

test('the driver changing other than one row, or failing, leaves the rows as they were', async () => {
  for (const update of [
    async () => ({ affectedRows: 0 }),
    async () => ({ affectedRows: 2 }),
    async (): Promise<RowChangeResult> => { throw new Error('disk is full'); },
  ]) {
    const f = fake({ update });
    const { st, session } = open(f, 'autoCommit');
    const out = await session.edit(0, 1, 'Changed');
    assert.equal(out.ok, false);
    assert.equal(st.rows[0][1], 'Dune');
    assert.equal(session.status().pending.length, 0);
  }
  const f = fake({ update: async () => ({ affectedRows: 2 }) });
  const out = await open(f, 'autoCommit').session.edit(0, 1, 'x');
  assert.match((out as { error: string }).error, /one row.*2/);
  const failing = fake({ update: async () => { throw new Error('disk is full'); } });
  assert.deepEqual(await open(failing, 'autoCommit').session.edit(0, 1, 'x'), { ok: false, error: 'disk is full' });
});

test('manual: the first edit opens the transaction, the edits stay pending, commit makes them final', async () => {
  const f = fake();
  const { st, session } = open(f, 'manual');
  await session.edit(0, 1, 'Dune II');
  await session.edit(1, 2, '12.5');
  assert.deepEqual(f.calls, ['begin', 'update', 'update'], 'one begin for all the edits');
  const status = session.status();
  assert.equal(status.transaction, true);
  assert.deepEqual(status.pending, [
    { row: 0, col: 1, before: 'Dune', after: 'Dune II' },
    { row: 1, col: 2, before: null, after: 12.5 },
  ]);

  assert.deepEqual(await session.commit(), { ok: true, count: 2, restored: [] });
  assert.deepEqual(f.calls.slice(-1), ['commit']);
  assert.equal(session.status().transaction, false);
  assert.equal(session.status().pending.length, 0);
  assert.deepEqual([st.rows[0][1], st.rows[1][2]], ['Dune II', 12.5], 'the rows keep what was committed');
});

test('manual: rollback puts every value back, in the database and in the rows', async () => {
  const f = fake();
  const { st, session } = open(f, 'manual');
  await session.edit(0, 1, 'One');
  await session.edit(0, 1, 'Two'); // the same cell again: still one pending edit, and "before" stays the original
  await session.edit(1, 1, 'Emmy');
  assert.deepEqual(session.status().pending.map((p) => [p.row, p.col, p.before, p.after]), [[0, 1, 'Dune', 'Two'], [1, 1, 'Emma', 'Emmy']]);

  const out = await session.rollback();
  assert.equal(out.ok, true);
  assert.equal((out as { count: number }).count, 2);
  assert.deepEqual((out as { restored: unknown[] }).restored, [
    { row: 1, col: 1, value: 'Emma' },
    { row: 0, col: 1, value: 'Dune' },
  ]);
  assert.deepEqual([st.rows[0][1], st.rows[1][1]], ['Dune', 'Emma']);
  assert.equal(session.status().transaction, false);
  assert.equal(f.calls.filter((c) => c === 'rollback').length, 1);
});

test('manual: an edit put back to where it began is no longer pending', async () => {
  const f = fake();
  const { session } = open(f, 'manual');
  await session.edit(0, 1, 'Other');
  assert.equal(session.status().pending.length, 1);
  await session.edit(0, 1, 'Dune');
  assert.equal(session.status().pending.length, 0);
});

test('manual: a first edit that fails does not leave an empty transaction open', async () => {
  const f = fake({ update: async () => { throw new Error('constraint failed'); } });
  const { session } = open(f, 'manual');
  assert.deepEqual(await session.edit(0, 1, 'x'), { ok: false, error: 'constraint failed' });
  assert.deepEqual(f.calls, ['begin', 'update', 'rollback']);
  assert.equal(session.status().transaction, false);
});

test('manual: a later edit that fails keeps the earlier ones pending', async () => {
  let n = 0;
  const f = fake({ update: async () => { if (++n === 2) throw new Error('constraint failed'); return { affectedRows: 1 }; } });
  const { st, session } = open(f, 'manual');
  await session.edit(0, 1, 'Fine');
  assert.equal((await session.edit(1, 1, 'Bad')).ok, false);
  assert.equal(session.status().transaction, true);
  assert.deepEqual(session.status().pending.map((p) => p.after), ['Fine']);
  assert.equal(st.rows[1][1], 'Emma');
  assert.deepEqual(f.calls.filter((c) => c === 'begin' || c === 'rollback'), ['begin']);
});

test('a commit or rollback the driver refuses is reported and keeps the edits pending', async () => {
  const f = fake({ commit: async () => { throw new Error('database is locked'); }, rollback: async () => { throw new Error('connection lost'); } });
  const { st, session } = open(f, 'manual');
  await session.edit(0, 1, 'Kept');
  assert.deepEqual(await session.commit(), { ok: false, error: 'database is locked' });
  assert.deepEqual(await session.rollback(), { ok: false, error: 'connection lost' });
  assert.equal(session.status().pending.length, 1);
  assert.equal(session.status().transaction, true);
  assert.equal(st.rows[0][1], 'Kept', 'the rows are only restored once the driver rolled back');
});

test('commit and rollback with nothing pending do nothing', async () => {
  const f = fake();
  const { session } = open(f, 'manual');
  assert.deepEqual(await session.commit(), { ok: true, count: 0, restored: [] });
  assert.deepEqual(await session.rollback(), { ok: true, count: 0, restored: [] });
  assert.deepEqual(f.calls, []);
});

test('edits run one at a time, in the order they came', async () => {
  const log: string[] = [];
  const f = fake({
    update: async (c) => {
      const v = String(c.set[0].value);
      log.push(`start ${v}`);
      await new Promise((r) => setTimeout(r, v === 'A' ? 30 : 1));
      log.push(`end ${v}`);
      return { affectedRows: 1 };
    },
  });
  const { st, session } = open(f, 'autoCommit');
  await Promise.all([session.edit(0, 1, 'A'), session.edit(0, 1, 'B')]);
  assert.deepEqual(log, ['start A', 'end A', 'start B', 'end B']);
  assert.equal(st.rows[0][1], 'B');
});

test('status: which cells can be edited, and in which mode', () => {
  const { session } = open(fake(), 'manual');
  const status = session.status();
  assert.equal(status.editable, true);
  assert.equal(status.mode, 'manual');
  assert.deepEqual(status.columns.map((c) => c.editable), [true, true, true, false]);
  assert.equal(status.reason, undefined);
});

// ---- EditService.open: the decision whether this result can be edited at all ----

function service(options: { driver?: Driver; catalog?: Catalog | undefined; open?: boolean } = {}) {
  const live = { driver: options.driver, descriptor: { displayName: 'Fake DB' } }; // one object per connection, as the manager keeps it
  const connections = { session: () => (options.open === false ? undefined : live) };
  const schema = { catalogSoon: async () => ('catalog' in options ? options.catalog : catalog) };
  return new EditService({ connections, schema } as never);
}

test('open: a closed connection, a driver without edit and a read-only result each say why', async () => {
  const closed = (await service({ open: false }).open('c1', statement(), 'autoCommit')).status();
  assert.equal(closed.editable, false);
  assert.match(closed.reason!, /connection is closed/);
  assert.deepEqual(closed.columns.map((c) => c.editable), [false, false, false, false]);

  const plain = (await service({ driver: {} as Driver }).open('c1', statement(), 'autoCommit')).status();
  assert.equal(plain.editable, false);
  assert.match(plain.reason!, /Fake DB cannot edit rows/);
  assert.deepEqual(plain.columns.map((c) => c.editable), [false, false, false, false]);

  const join = statement();
  join.columns[1] = { ...join.columns[1], source: { schema: 'main', table: 'authors', column: 'name' } };
  const joined = (await service({ driver: fake().driver }).open('c1', join, 'autoCommit')).status();
  assert.equal(joined.editable, false);
  assert.match(joined.reason!, /more than one table/);

  const noCatalog = (await service({ driver: fake().driver, catalog: undefined }).open('c1', statement(), 'autoCommit')).status();
  assert.equal(noCatalog.editable, false);
  assert.match(noCatalog.reason!, /not loaded/);
});

test('open: manual needs a driver that can keep edits pending, otherwise it falls back and says so', async () => {
  const withTxn = (await service({ driver: fake().driver }).open('c1', statement(), 'manual')).status();
  assert.equal(withTxn.mode, 'manual');
  assert.equal(withTxn.note, undefined);

  const without = (await service({ driver: fake({ transactions: false }).driver }).open('c1', statement(), 'manual')).status();
  assert.equal(without.editable, true);
  assert.equal(without.mode, 'autoCommit');
  assert.match(without.note!, /saved at once/);

  const auto = (await service({ driver: fake({ transactions: false }).driver }).open('c1', statement(), 'autoCommit')).status();
  assert.equal(auto.note, undefined);
});

test('open: an opened session edits through the driver it was given', async () => {
  const f = fake();
  const st = statement();
  const session = await service({ driver: f.driver }).open('c1', st, 'manual');
  assert.equal((await session.edit(0, 1, 'Via svc')).ok, true);
  assert.deepEqual(f.calls, ['begin', 'update']);
  assert.equal(st.rows[0][1], 'Via svc');
  await session.rollback();
  assert.equal(st.rows[0][1], 'Dune');
});

test('one connection has one transaction: the result holding edits blocks the others until it commits or rolls back', async () => {
  const f = fake();
  const svc = service({ driver: f.driver });
  const a = statement();
  const b = statement();
  const first = await svc.open('c1', a, 'manual');
  const second = await svc.open('c1', b, 'manual');

  assert.equal((await first.edit(0, 1, 'From A')).ok, true);
  const blocked = await second.edit(1, 1, 'From B');
  assert.equal(blocked.ok, false);
  assert.match((blocked as { error: string }).error, /Commit or roll them back first/);
  assert.equal(b.rows[1][1], 'Emma');
  assert.deepEqual(f.calls, ['begin', 'update'], 'the blocked edit never reached the driver, and no second begin');

  // an edit that changes nothing is not an edit: it needs no transaction
  assert.deepEqual(await second.edit(1, 1, 'Emma'), { ok: true, value: 'Emma', changed: false });

  await first.rollback();
  assert.equal((await second.edit(1, 1, 'From B')).ok, true, 'free again after the rollback');
  await second.commit();
  assert.equal((await first.edit(0, 1, 'A again')).ok, true, 'and again after the commit');
});

test('the block also holds for auto-commit edits while another result has a transaction open', async () => {
  const f = fake();
  const svc = service({ driver: f.driver });
  const holder = await svc.open('c1', statement(), 'manual');
  const other = await svc.open('c1', statement(), 'autoCommit');
  await holder.edit(0, 1, 'Pending');
  assert.equal((await other.edit(1, 1, 'Final')).ok, false, 'it would silently join the open transaction');
  assert.deepEqual(f.calls, ['begin', 'update']);
});

test('a failed first edit gives the transaction back, and a new connection starts without a holder', async () => {
  let fail = true;
  const f = fake({ update: async () => { if (fail) throw new Error('constraint failed'); return { affectedRows: 1 }; } });
  const svc = service({ driver: f.driver });
  const a = await svc.open('c1', statement(), 'manual');
  const b = await svc.open('c1', statement(), 'manual');
  assert.equal((await a.edit(0, 1, 'x')).ok, false);
  fail = false;
  assert.equal((await b.edit(0, 1, 'y')).ok, true, 'a did not keep the transaction');

  // another connection (another session object) is unaffected by b's open transaction
  const g = fake();
  const elsewhere = await service({ driver: g.driver }).open('c2', statement(), 'manual');
  assert.equal((await elsewhere.edit(0, 1, 'z')).ok, true);
});
