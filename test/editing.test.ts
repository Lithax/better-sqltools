import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editTarget, parseEditValue } from '../src/domain/editing';
import type { Catalog, Column } from '../src/domain/model';

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
    {
      schema: 'main', name: 'stock', kind: 'table',
      columns: [
        { name: 'warehouse', type: 'TEXT', kind: 'text', primaryKey: true, nullable: false },
        { name: 'sku', type: 'TEXT', kind: 'text', primaryKey: true, nullable: false },
        { name: 'qty', type: 'INTEGER', kind: 'integer' },
      ],
    },
    { schema: 'main', name: 'log', kind: 'table', columns: [{ name: 'at', type: 'TEXT', kind: 'text' }] },
    { schema: 'main', name: 'cheap', kind: 'view', columns: [{ name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true }] },
  ],
};

const src = (table: string, column: string): Column['source'] => ({ schema: 'main', table, column });
const col = (name: string, table?: string, column = name, extra: Partial<Column> = {}): Column => ({ name, ...(table ? { source: src(table, column) } : {}), ...extra });

test('editTarget: a plain table read with its key is editable, column by column', () => {
  const t = editTarget([col('id', 'books'), col('title', 'books'), col('price', 'books'), col('cover', 'books', 'cover', { kind: 'binary' })], catalog);
  assert.equal(t.reason, undefined);
  assert.deepEqual(t.table, { schema: 'main', name: 'books' });
  assert.deepEqual(t.keyColumns, [0]);
  assert.deepEqual(t.columns.map((c) => c.editable), [true, true, true, false]);
  assert.match(t.columns[3].reason!, /Binary/);
});

test('editTarget: the key may sit anywhere, and a composite key lists every column in key order', () => {
  const t = editTarget([col('qty', 'stock'), col('sku', 'stock'), col('warehouse', 'stock')], catalog);
  assert.deepEqual(t.keyColumns, [2, 1], 'warehouse then sku, wherever they are in the result');
  assert.deepEqual(t.columns.map((c) => c.editable), [true, true, true]);
});

test('editTarget: aliases and case do not matter, the source does', () => {
  const t = editTarget([col('Book number', 'BOOKS', 'ID'), col('t', 'books', 'title')], catalog);
  assert.deepEqual(t.keyColumns, [0]);
});

test('editTarget: why a result is read-only', () => {
  const cases: [string, Column[], Catalog | undefined, RegExp][] = [
    ['no catalog yet', [col('id', 'books')], undefined, /not loaded/],
    ['nothing returned', [], catalog, /no columns/],
    ['only computed columns', [col('n')], catalog, /straight from a table/],
    ['a join', [col('id', 'books'), col('qty', 'stock')], catalog, /more than one table/],
    ['a view', [col('id', 'cheap')], catalog, /view/],
    ['no primary key', [col('at', 'log')], catalog, /no primary key/],
    ['the key is not selected', [col('title', 'books'), col('price', 'books')], catalog, /Select the primary key \(id\)/],
    ['half of a composite key', [col('sku', 'stock'), col('qty', 'stock')], catalog, /\(warehouse\)/],
    ['a table the catalog does not know', [col('x', 'ghost')], catalog, /not in the database/],
  ];
  for (const [what, columns, cat, reason] of cases) {
    const t = editTarget(columns, cat);
    assert.equal(t.table, undefined, what);
    assert.match(t.reason!, reason, what);
    assert.deepEqual(t.keyColumns, [], what);
    assert.ok(t.columns.length === columns.length && t.columns.every((c) => !c.editable && c.reason), what);
  }
});

test('editTarget: a computed or repeated column is read-only, the others stay editable', () => {
  const t = editTarget([col('id', 'books'), col('twice'), col('title', 'books'), col('again', 'books', 'title')], catalog);
  assert.deepEqual(t.columns.map((c) => c.editable), [true, false, true, false]);
  assert.match(t.columns[1].reason!, /Computed/);
  assert.match(t.columns[3].reason!, /more than once/);
});

test('parseEditValue: NULL only where the column allows it', () => {
  assert.deepEqual(parseEditValue({ name: 'price', kind: 'decimal' }, null), { ok: true, value: null });
  assert.deepEqual(parseEditValue({ name: 'title', kind: 'text', notNull: true }, null), { ok: false, error: 'title cannot be NULL.' });
  // an empty box is not NULL: text can be empty, a number cannot
  assert.deepEqual(parseEditValue({ name: 'title', kind: 'text' }, ''), { ok: true, value: '' });
  assert.match((parseEditValue({ name: 'n', kind: 'integer' }, '  ') as { error: string }).error, /whole number, or set NULL/);
});

test('parseEditValue: integers', () => {
  const c: Column = { name: 'n', kind: 'integer' };
  assert.deepEqual(parseEditValue(c, ' 42 '), { ok: true, value: 42 });
  assert.deepEqual(parseEditValue(c, '+7'), { ok: true, value: 7 });
  assert.deepEqual(parseEditValue(c, '-0012'), { ok: true, value: -12 });
  assert.deepEqual(parseEditValue(c, '9007199254740993'), { ok: true, value: '9007199254740993' }, 'too big for a double: kept exact');
  for (const bad of ['1.5', 'abc', '1e3', '0x10', '1 2']) assert.equal(parseEditValue(c, bad).ok, false, bad);
});

test('parseEditValue: decimals respect the declared precision and scale', () => {
  const c: Column = { name: 'price', kind: 'decimal', type: 'DECIMAL(8,2)' };
  assert.deepEqual(parseEditValue(c, '12.5'), { ok: true, value: 12.5 });
  assert.deepEqual(parseEditValue(c, '.5'), { ok: true, value: 0.5 });
  assert.deepEqual(parseEditValue(c, '9.990'), { ok: true, value: 9.99 }, 'a trailing zero is not a third decimal place');
  assert.deepEqual(parseEditValue(c, '999999.99'), { ok: true, value: 999999.99 });
  assert.deepEqual(parseEditValue(c, '1.234'), { ok: false, error: 'At most 2 decimal places.' });
  assert.deepEqual(parseEditValue(c, '1234567.1'), { ok: false, error: 'At most 6 digits before the decimal point.' });
  assert.equal(parseEditValue(c, 'twelve').ok, false);
  assert.deepEqual(parseEditValue({ name: 'p', kind: 'decimal', type: 'NUMERIC(5)' }, '1.5'), { ok: false, error: 'Enter a whole number: this column has no decimals.' });
  assert.deepEqual(parseEditValue({ name: 'f', kind: 'decimal', type: 'REAL' }, '1e-3'), { ok: true, value: 0.001 }, 'no declared precision: anything numeric');
  assert.deepEqual(parseEditValue({ name: 'f', kind: 'decimal' }, '123456789012345678.5'), { ok: true, value: '123456789012345678.5' }, 'long values stay exact as text');
});

test('parseEditValue: booleans take the usual spellings', () => {
  const c: Column = { name: 'in_stock', kind: 'boolean' };
  for (const yes of ['true', 'TRUE', 't', 'Yes', 'y', '1']) assert.deepEqual(parseEditValue(c, yes), { ok: true, value: true }, yes);
  for (const no of ['false', 'F', 'no', 'N', '0']) assert.deepEqual(parseEditValue(c, no), { ok: true, value: false }, no);
  assert.equal(parseEditValue(c, 'maybe').ok, false);
  assert.equal(parseEditValue(c, '2').ok, false);
});

test('parseEditValue: dates and times', () => {
  const c: Column = { name: 'at', kind: 'datetime' };
  for (const good of ['2026-11-17', '2026-11-17 09:30', '2026-11-17T09:30:15', '2026-11-17 09:30:15.250', '2026-11-17T09:30:15Z', '2026-11-17T09:30:15+01:00', '2024-02-29', '09:30', '23:59:59']) {
    assert.equal(parseEditValue(c, good).ok, true, good);
  }
  for (const bad of ['2026-13-01', '2026-02-30', '2025-02-29', '2026-11-17 24:00', '2026-11-17 09:60', '17/11/2026', 'tomorrow', '25:00']) {
    assert.equal(parseEditValue(c, bad).ok, false, bad);
  }
  assert.deepEqual(parseEditValue(c, ' 2026-11-17 '), { ok: true, value: '2026-11-17' }, 'surrounding spaces are dropped');
});

test('parseEditValue: json, text length and binary', () => {
  assert.deepEqual(parseEditValue({ name: 'doc', kind: 'json' }, '{"a": [1, 2]}'), { ok: true, value: '{"a": [1, 2]}' });
  assert.deepEqual(parseEditValue({ name: 'doc', kind: 'json' }, '{a: 1}'), { ok: false, error: 'Enter valid JSON.' });

  const title: Column = { name: 'title', kind: 'text', type: 'VARCHAR(10)' };
  assert.deepEqual(parseEditValue(title, ' keep my spaces '), { ok: false, error: 'At most 10 characters.' });
  assert.deepEqual(parseEditValue(title, '  Dune  '), { ok: true, value: '  Dune  ' }, 'text is stored as typed, spaces included');
  assert.equal(parseEditValue(title, 'ééééééééé!').ok, true, 'ten characters, whatever their bytes');
  assert.equal(parseEditValue({ name: 'note', kind: 'text', type: 'TEXT' }, 'x'.repeat(5000)).ok, true, 'only CHAR types have a length');
  assert.equal(parseEditValue({ name: 'x' }, 'anything at all').ok, true, 'a column the driver said nothing about takes text');

  assert.deepEqual(parseEditValue({ name: 'cover', kind: 'binary' }, 'ff'), { ok: false, error: 'Binary values cannot be edited here.' });
});
