import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import type { Driver } from '../../../src/api';
import { SqliteDriverFactory } from '../src';
import { sqliteKind } from '../src/types';
import { testEnv, tmpDir } from '../../../test/helpers';

const factory = new SqliteDriverFactory();
const ctx = { maxRows: 1000 };

async function open(options: Record<string, unknown>): Promise<Driver> {
  const d = factory.create({ options: { foreignKeys: true, createIfMissing: true, readOnly: false, ...options }, secrets: {} }, testEnv());
  await d.open();
  return d;
}

test('creates a file, persists writes, and reads them back after reopening', async () => {
  const file = path.join(tmpDir(), 'a.db');
  let d = await open({ path: file });
  assert.ok(!fs.existsSync(file), 'opening does not create the file; the first write does');
  await d.execute('select 1', ctx);
  assert.ok(!fs.existsSync(file), 'reads do not create it either');
  await d.execute('create table t (id integer primary key, name text not null)', ctx);
  assert.ok(fs.existsSync(file));
  const ins = await d.execute("insert into t (name) values ('a'), ('b')", ctx);
  assert.equal(ins.affectedRows, 2);
  await d.close();

  d = await open({ path: file });
  const r = await d.execute('select id, name from t order by id', ctx);
  assert.deepEqual(r.columns.map((c) => c.name), ['id', 'name']);
  assert.deepEqual(r.rows, [[1, 'a'], [2, 'b']]);
  await d.close();
});

test('affectedRows is not stale after DDL', async () => {
  const d = await open({ path: ':memory:' });
  await d.execute('create table t (x)', ctx);
  await d.execute('insert into t values (1), (2), (3)', ctx);
  const ddl = await d.execute('create table u (y)', ctx);
  assert.equal(ddl.affectedRows, 0);
  const del = await d.execute('delete from t where x > 1', ctx);
  assert.equal(del.affectedRows, 2);
  await d.close();
});

test('maxRows truncates and says so', async () => {
  const d = await open({ path: ':memory:' });
  await d.execute('create table n (i)', ctx);
  await d.execute('insert into n select value from generate_series(1, 50)', ctx).catch(async () => {
    for (let i = 0; i < 50; i++) await d.execute(`insert into n values (${i})`, ctx);
  });
  const r = await d.execute('select * from n', { maxRows: 10 });
  assert.equal(r.rows.length, 10);
  assert.equal(r.truncated, true);
  const all = await d.execute('select * from n', { maxRows: 50 });
  assert.equal(all.truncated, false);
  await d.close();
});

test('syntax errors reject with the SQLite message', async () => {
  const d = await open({ path: ':memory:' });
  await assert.rejects(() => d.execute('selec 1', ctx), /syntax error/i);
  await d.close();
});

test('read-only mode blocks writes and never touches the file', async () => {
  const file = path.join(tmpDir(), 'ro.db');
  let d = await open({ path: file });
  await d.execute('create table t (x)', ctx);
  await d.close();
  const before = fs.readFileSync(file);

  d = await open({ path: file, readOnly: true });
  await assert.rejects(() => d.execute('insert into t values (1)', ctx), /readonly/i);
  await d.close();
  assert.deepEqual(fs.readFileSync(file), before);
});

test('a file that appears after open is not overwritten', async () => {
  const file = path.join(tmpDir(), 'late.db');
  const d = await open({ path: file });
  fs.writeFileSync(file, 'someone else got here first');
  await assert.rejects(() => d.execute('create table t (x)', ctx), /modified on disk/);
  assert.equal(fs.readFileSync(file, 'utf8'), 'someone else got here first');
  await d.close().catch(() => undefined);
});

test('missing file: error when createIfMissing is off', async () => {
  const file = path.join(tmpDir(), 'nope.db');
  await assert.rejects(() => open({ path: file, createIfMissing: false }), /not found/i);
});

test('refuses non-SQLite files', async () => {
  const file = path.join(tmpDir(), 'text.db');
  fs.writeFileSync(file, 'this is definitely not a database '.repeat(50));
  await assert.rejects(() => open({ path: file }), /not a SQLite database/);
});

test('does not clobber a file that changed on disk', async () => {
  const file = path.join(tmpDir(), 'race.db');
  const d = await open({ path: file });
  await d.execute('create table t (x)', ctx);
  // someone else rewrites the file
  const bumped = new Date(Date.now() + 60_000);
  fs.utimesSync(file, bumped, bumped);
  await assert.rejects(() => d.execute('insert into t values (1)', ctx), /modified on disk/);
  await d.close().catch(() => undefined);
});

test('transactions: nothing is flushed mid-transaction, COMMIT persists, ROLLBACK discards', async () => {
  const file = path.join(tmpDir(), 'tx.db');
  const d = await open({ path: file });
  await d.execute('create table t (x)', ctx);

  await d.execute('begin', ctx);
  await d.execute('insert into t values (1)', ctx);
  const mid = await d.execute('select count(*) from t', ctx);
  assert.equal(mid.rows[0][0], 1, 'transaction survived the write path');
  await d.execute('commit', ctx);

  await d.execute('begin', ctx);
  await d.execute('insert into t values (2)', ctx);
  await d.execute('rollback', ctx);
  await d.close();

  const d2 = await open({ path: file });
  assert.deepEqual((await d2.execute('select x from t', ctx)).rows, [[1]]);
  await d2.close();
});

test('foreign keys are enforced and stay enforced after a flush', async () => {
  const d = await open({ path: path.join(tmpDir(), 'fk.db') });
  await d.execute('create table p (id integer primary key)', ctx);
  await d.execute('create table c (pid integer references p(id))', ctx);
  await assert.rejects(() => d.execute('insert into c values (99)', ctx), /FOREIGN KEY/i);
  await d.execute('insert into p values (1)', ctx); // triggers a flush (export resets pragmas)
  await assert.rejects(() => d.execute('insert into c values (99)', ctx), /FOREIGN KEY/i);
  await d.close();
});

test('introspection: tree, catalog and ddl', async () => {
  const d = await open({ path: ':memory:' });
  await d.execute('create table users (id integer primary key, email text not null)', ctx);
  await d.execute('create index idx_email on users (email)', ctx);
  await d.execute('create view v as select email from users', ctx);
  await d.execute('create trigger trg after insert on users begin select 1; end', ctx);

  const root = await d.children();
  assert.deepEqual(root.map((n) => `${n.label}:${n.count}`), ['Tables:1', 'Views:1', 'Indexes:1', 'Triggers:1']);

  const tables = await d.children(root[0]);
  assert.equal(tables[0].qualifiedName, '"users"');
  const cols = await d.children(tables[0]);
  assert.deepEqual(cols.map((c) => [c.label, c.description, c.primaryKey]), [
    ['id', 'INTEGER · PK', true],
    ['email', 'TEXT · NOT NULL', false],
  ]);

  const cat = await d.catalog!();
  assert.deepEqual(cat.tables.map((t) => [t.name, t.kind, t.columns.length]), [['users', 'table', 2], ['v', 'view', 1]]);

  const ddl = await d.ddl!(tables[0]);
  assert.match(ddl, /CREATE TABLE users[\s\S]*;\n\nCREATE INDEX idx_email[\s\S]*;\n\nCREATE TRIGGER trg/);
  await d.close();
});

test('weird identifiers are quoted safely', async () => {
  const d = await open({ path: ':memory:' });
  await d.execute('create table "we""ird name" (x)', ctx);
  const [tables] = await d.children();
  const nodes = await d.children(tables);
  assert.equal(nodes[0].qualifiedName, '"we""ird name"');
  assert.equal((await d.execute(`select * from ${nodes[0].qualifiedName}`, ctx)).columns[0].name, 'x');
  await d.close();
});

test('catalog: types, kinds and constraints come from the database, not from a guess', async () => {
  const d = await open({ path: ':memory:' });
  for (const sql of [
    'create table authors (id integer primary key, name text not null unique, born date)',
    `create table books (
       id integer primary key, title varchar(80) not null, author_id integer references authors(id),
       isbn text unique default 'n/a', price decimal(8,2), in_print boolean default 1, meta json, cover blob, anything,
       a integer, b integer, unique (a, b))`,
    'create table kv (k integer primary key, v text) without rowid',
    'create table pairs (x integer, y integer, primary key (x, y))',
    'create index books_title on books (title)',
    'create unique index books_price_u on books (price) where price > 0',
    'create view v as select title from books',
  ]) await d.execute(sql, ctx);

  const catalog = await d.catalog!();
  const col = (table: string, name: string) => catalog.tables.find((t) => t.name === table)!.columns.find((c) => c.name === name)!;

  assert.deepEqual(col('books', 'id'), { name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true, nullable: false, autoIncrement: true }, 'a lone INTEGER PRIMARY KEY is the rowid: filled in, never NULL');
  assert.deepEqual(col('books', 'title'), { name: 'title', type: 'varchar(80)', kind: 'text', primaryKey: false, nullable: false });
  assert.deepEqual(col('books', 'author_id').foreignKey, { table: 'authors', column: 'id' });
  assert.equal(col('books', 'author_id').nullable, true);
  assert.equal(col('books', 'isbn').unique, true);
  assert.equal(col('books', 'isbn').defaultValue, "'n/a'", 'defaults come back as SQLite prints them');
  assert.equal(col('books', 'in_print').kind, 'boolean');
  assert.equal(col('books', 'in_print').defaultValue, '1');
  assert.equal(col('books', 'price').kind, 'decimal');
  assert.equal(col('books', 'price').unique, undefined, 'a partial unique index does not make the column unique');
  assert.equal(col('books', 'meta').kind, 'json');
  assert.equal(col('books', 'cover').kind, 'binary');
  assert.equal(col('books', 'anything').type, undefined);
  assert.equal(col('books', 'anything').kind, undefined, 'no declared type, no kind');
  assert.equal(col('books', 'a').unique, undefined, 'one column of a composite unique constraint is not unique alone');
  assert.equal(col('authors', 'name').unique, true);
  assert.equal(col('authors', 'born').kind, 'datetime');
  assert.equal(col('books', 'title').unique, undefined);

  assert.equal(col('kv', 'k').primaryKey, true);
  assert.equal(col('kv', 'k').autoIncrement, undefined, 'in a WITHOUT ROWID table INTEGER PRIMARY KEY is an ordinary column');
  assert.equal(col('pairs', 'x').autoIncrement, undefined, 'nor is half of a composite key');
  assert.equal(col('pairs', 'x').primaryKey, true);
  assert.equal(col('v', 'title').kind, 'text', 'views carry the kinds of what they select');
  assert.equal(col('v', 'title').autoIncrement, undefined);
  await d.close();
});

test('sqliteKind: follows SQLite\u2019s affinity rules and knows the usual names', () => {
  const kinds: Record<string, string | undefined> = {
    INTEGER: 'integer', BIGINT: 'integer', 'UNSIGNED BIG INT': 'integer', TINYINT: 'integer',
    'VARCHAR(30)': 'text', NVARCHAR: 'text', 'VARYING CHARACTER(255)': 'text', CLOB: 'text', TEXT: 'text',
    REAL: 'decimal', DOUBLE: 'decimal', 'DOUBLE PRECISION': 'decimal', FLOAT: 'decimal', 'DECIMAL(10,5)': 'decimal', NUMERIC: 'decimal',
    BLOB: 'binary', BOOLEAN: 'boolean', DATE: 'datetime', DATETIME: 'datetime', TIMESTAMP: 'datetime', JSON: 'json', jsonb: 'json',
    'my own type': 'other', '': undefined, '   ': undefined,
  };
  for (const [type, kind] of Object.entries(kinds)) assert.equal(sqliteKind(type), kind, type);
  assert.equal(sqliteKind(undefined), undefined);
});

test('blobs and big numbers come back as raw values for the core to normalise', async () => {
  const d = await open({ path: ':memory:' });
  const r = await d.execute("select x'0aff' as b, 42 as n, null as z, 1.5 as f", ctx);
  assert.ok(r.rows[0][0] instanceof Uint8Array);
  assert.deepEqual(r.rows[0].slice(1), [42, null, 1.5]);
  await d.close();
});
