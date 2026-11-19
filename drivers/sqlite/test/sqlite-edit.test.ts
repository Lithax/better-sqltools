import assert from 'node:assert/strict';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Driver, RowChange } from '../../../src/api';
import { SqliteDriverFactory } from '../src';
import { testEnv, tmpDir } from '../../../test/helpers';

const factory = new SqliteDriverFactory();
const ctx = { maxRows: 1000 };

async function open(options: Record<string, unknown>): Promise<Driver> {
  const d = factory.create({ options: { foreignKeys: true, createIfMissing: true, readOnly: false, ...options }, secrets: {} }, testEnv());
  await d.open();
  return d;
}

/** A file database with a few rows; the driver is returned open. */
async function books(): Promise<{ d: Driver; file: string }> {
  const file = path.join(tmpDir(), 'books.db');
  const d = await open({ path: file });
  await d.execute('create table authors (id integer primary key, name text not null)', ctx);
  await d.execute(
    'create table books (id integer primary key, title text not null unique, qty integer, price numeric, author_id integer references authors(id), grp text)',
    ctx,
  );
  await d.execute("insert into authors values (1, 'Herbert'), (2, 'Austen')", ctx);
  await d.execute(
    "insert into books values (1, 'Dune', 3, 9.5, 1, 'a'), (2, 'Emma', 5, 7, 2, 'a'), (3, 'Persuasion', 1, 6, 2, 'b')",
    ctx,
  );
  return { d, file };
}

/** What a fresh connection to the file sees: what was really saved. */
async function onDisk(file: string, sql: string): Promise<unknown[][]> {
  const d = await open({ path: file });
  try {
    return (await d.execute(sql, ctx)).rows;
  } finally {
    await d.close();
  }
}

const change = (set: RowChange['set'], key: RowChange['key'] = [{ column: 'id', value: 1 }], table = 'books'): RowChange => ({
  table: { name: table },
  key,
  set,
});

test('update changes exactly one row, reads it back, and saves the file', async () => {
  const { d, file } = await books();
  const out = await d.edit!.update(change([{ column: 'title', value: 'Dune Messiah' }]));
  assert.equal(out.affectedRows, 1);
  assert.deepEqual(out.values, { title: 'Dune Messiah' });
  assert.deepEqual((await d.execute('select id, title from books order by id', ctx)).rows, [[1, 'Dune Messiah'], [2, 'Emma'], [3, 'Persuasion']]);
  assert.deepEqual(await onDisk(file, 'select title from books where id = 1'), [['Dune Messiah']], 'auto-commit: saved at once');
  await d.close();
});

test('the read-back is what the database holds: affinity converts what was typed', async () => {
  const { d } = await books();
  const out = await d.edit!.update(change([{ column: 'qty', value: '12' }, { column: 'title', value: 42 }]));
  assert.deepEqual(out.values, { qty: 12, title: '42' }, 'INTEGER affinity turns "12" into 12; TEXT affinity turns 42 into "42"');
  await d.close();
});

test('booleans are stored as 1 and 0, NULL as NULL', async () => {
  const { d } = await books();
  assert.deepEqual((await d.edit!.update(change([{ column: 'qty', value: true }]))).values, { qty: 1 });
  assert.deepEqual((await d.edit!.update(change([{ column: 'qty', value: null }]))).values, { qty: null });
  await d.close();
});

test('the key itself can be edited, and the read-back finds the row by its new key', async () => {
  const { d } = await books();
  const out = await d.edit!.update(change([{ column: 'id', value: '10' }, { column: 'qty', value: 7 }]));
  assert.deepEqual(out.values, { id: 10, qty: 7 });
  assert.deepEqual((await d.execute('select id from books order by id', ctx)).rows, [[2], [3], [10]]);
  await d.close();
});

test('a composite key finds one row, and a schema-qualified table works', async () => {
  const d = await open({ path: ':memory:' });
  await d.execute('create table stock (warehouse text, sku text, qty integer, primary key (warehouse, sku))', ctx);
  await d.execute("insert into stock values ('w1','a',1), ('w1','b',2), ('w2','a',3)", ctx);
  const out = await d.edit!.update({
    table: { schema: 'main', name: 'stock' },
    key: [{ column: 'warehouse', value: 'w1' }, { column: 'sku', value: 'b' }],
    set: [{ column: 'qty', value: 20 }],
  });
  assert.deepEqual(out.values, { qty: 20 });
  assert.deepEqual((await d.execute('select qty from stock order by warehouse, sku', ctx)).rows, [[1], [20], [3]]);
  await d.close();
});

test('identifiers are quoted, so odd names and quotes cannot break out of the statement', async () => {
  const d = await open({ path: ':memory:' });
  await d.execute('create table "we""ird t" ("i d" integer primary key, "na""me" text)', ctx);
  await d.execute("insert into \"we\"\"ird t\" values (1, 'x')", ctx);
  const out = await d.edit!.update({
    table: { name: 'we"ird t' },
    key: [{ column: 'i d', value: 1 }],
    set: [{ column: 'na"me', value: "O'Brien'); drop table \"we\"\"ird t\"; --" }],
  });
  assert.deepEqual(out.values, { 'na"me': "O'Brien'); drop table \"we\"\"ird t\"; --" });
  assert.equal((await d.execute('select count(*) from "we""ird t"', ctx)).rows[0][0], 1, 'the table is still there');
  await d.close();
});

test('no matching row, or more than one, is refused and changes nothing', async () => {
  const { d, file } = await books();
  await assert.rejects(d.edit!.update(change([{ column: 'qty', value: 99 }], [{ column: 'id', value: 404 }])), /No row with this key/);
  // grp is not unique: two rows match, so the driver must not touch either
  await assert.rejects(d.edit!.update(change([{ column: 'qty', value: 99 }], [{ column: 'grp', value: 'a' }])), /2 rows instead of one/);
  assert.deepEqual((await d.execute('select qty from books order by id', ctx)).rows, [[3], [5], [1]]);
  assert.deepEqual(await onDisk(file, 'select qty from books order by id'), [[3], [5], [1]]);
  await d.close();
});

test('a failed constraint is reported with the database\'s words and leaves the connection usable', async () => {
  const { d, file } = await books();
  await assert.rejects(d.edit!.update(change([{ column: 'title', value: 'Emma' }])), /UNIQUE constraint failed/);
  await assert.rejects(d.edit!.update(change([{ column: 'title', value: null }])), /NOT NULL constraint failed/);
  await assert.rejects(d.edit!.update(change([{ column: 'author_id', value: 99 }])), /FOREIGN KEY constraint failed/);
  await assert.rejects(d.edit!.update(change([{ column: 'nope', value: 1 }])), /no such column/);
  assert.deepEqual((await d.execute('select title, author_id from books where id = 1', ctx)).rows, [['Dune', 1]]);
  // no savepoint or transaction was left behind: a normal edit still works and is saved
  await d.edit!.update(change([{ column: 'qty', value: 4 }]));
  assert.deepEqual(await onDisk(file, 'select qty from books where id = 1'), [[4]]);
  await d.close();
});

test('binary values and read-only connections are refused', async () => {
  const { d } = await books();
  await assert.rejects(d.edit!.update(change([{ column: 'title', value: { bytes: 2 } as never }])), /Binary/);
  await d.close();

  const file = path.join(tmpDir(), 'ro.db');
  const w = await open({ path: file });
  await w.execute('create table t (id integer primary key, v text)', ctx);
  await w.execute("insert into t values (1, 'a')", ctx);
  await w.close();
  const ro = await open({ path: file, readOnly: true });
  await assert.rejects(ro.edit!.update(change([{ column: 'v', value: 'b' }], [{ column: 'id', value: 1 }], 't')), /read-only/);
  assert.deepEqual((await ro.execute('select v from t', ctx)).rows, [['a']]);
  await ro.close();
});

test('manual: edits join a transaction, reach the file only on commit, and commit can be repeated', async () => {
  const { d, file } = await books();
  await d.edit!.begin!();
  await d.edit!.update(change([{ column: 'title', value: 'Dune II' }]));
  await d.edit!.update(change([{ column: 'qty', value: 30 }, { column: 'price', value: 12.5 }], [{ column: 'id', value: 2 }]));
  assert.deepEqual((await d.execute('select title from books where id = 1', ctx)).rows, [['Dune II']], 'this connection sees its own edits');
  assert.deepEqual(await onDisk(file, 'select title, qty from books where id in (1, 2) order by id'), [['Dune', 3], ['Emma', 5]], 'nothing saved yet');

  await d.edit!.commit!();
  assert.deepEqual(await onDisk(file, 'select title, qty from books where id in (1, 2) order by id'), [['Dune II', 3], ['Emma', 30]]);
  await d.edit!.commit!(); // nothing left to commit
  await d.close();
});

test('manual: rollback undoes every edit and the file never changes', async () => {
  const { d, file } = await books();
  await d.edit!.begin!();
  await d.edit!.update(change([{ column: 'title', value: 'Changed' }]));
  await d.edit!.update(change([{ column: 'qty', value: 0 }], [{ column: 'id', value: 3 }]));
  await d.edit!.rollback!();
  assert.deepEqual((await d.execute('select id, title, qty from books order by id', ctx)).rows, [[1, 'Dune', 3], [2, 'Emma', 5], [3, 'Persuasion', 1]]);
  assert.deepEqual(await onDisk(file, 'select title from books where id = 1'), [['Dune']]);
  await d.edit!.rollback!(); // nothing left to roll back
  // and an auto-commit edit afterwards still saves: the transaction really ended
  await d.edit!.update(change([{ column: 'qty', value: 8 }]));
  assert.deepEqual(await onDisk(file, 'select qty from books where id = 1'), [[8]]);
  await d.close();
});

test('manual: a failed edit inside a transaction keeps the earlier ones, and a second begin is refused', async () => {
  const { d, file } = await books();
  await d.edit!.begin!();
  await assert.rejects(d.edit!.begin!(), /already open/);
  await d.edit!.update(change([{ column: 'qty', value: 11 }]));
  await assert.rejects(d.edit!.update(change([{ column: 'title', value: 'Emma' }])), /UNIQUE constraint failed/);
  assert.deepEqual((await d.execute('select qty from books where id = 1', ctx)).rows, [[11]], 'the earlier edit is still pending');
  await d.edit!.commit!();
  assert.deepEqual(await onDisk(file, 'select qty from books where id = 1'), [[11]]);
  await d.close();
});

test('an unfinished transaction is discarded when the connection closes', async () => {
  const { d, file } = await books();
  await d.edit!.begin!();
  await d.edit!.update(change([{ column: 'qty', value: 77 }]));
  await d.close();
  assert.deepEqual(await onDisk(file, 'select qty from books where id = 1'), [[3]]);
});
