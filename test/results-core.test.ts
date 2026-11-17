import assert from 'node:assert/strict';
import { test } from 'node:test';

// the page's logic is a plain script that also works under node
// eslint-disable-next-line @typescript-eslint/no-require-imports
const core = require('../media/results-core.js');

const blob = (hex: string, bytes: number) => ({ $blob: hex, bytes });

test('describe: how each kind of value is shown', () => {
  assert.deepEqual(core.describe(null), { text: 'NULL', cls: 'null', title: 'NULL' });
  assert.deepEqual(core.describe(42), { text: '42', cls: 'num', title: '42' });
  assert.deepEqual(core.describe(true), { text: 'true', cls: 'bool', title: 'true' });
  assert.deepEqual(core.describe('Dune'), { text: 'Dune', cls: 'str', title: 'Dune' });

  const long = core.describe('x'.repeat(3000));
  assert.equal(long.text.length, core.MAX_TEXT + 1, 'cut for the cell, with an ellipsis');
  assert.ok(long.text.endsWith('\u2026'));
  assert.equal(long.title.length, 2001, 'a longer cut for the tooltip');

  assert.deepEqual(core.describe(blob('cafe', 2)), { text: '0xcafe', cls: 'blob', title: '2 bytes\n0xcafe' });
  const big = core.describe(blob('ab'.repeat(40), 5000)); // only part of the bytes were loaded
  assert.match(big.text, /^0x(ab){16}\u2026 \(5,000 B\)$/);
});

test('cellText: what copy and filters see', () => {
  assert.equal(core.cellText(null), '');
  assert.equal(core.cellText(0), '0');
  assert.equal(core.cellText(false), 'false');
  assert.equal(core.cellText(blob('cafe', 2)), '0xcafe');
  assert.equal(core.cellText(blob('cafe', 99)), '0xcafe\u2026', 'cut blobs say so');
});

test('columnKind: the driver decides; otherwise the values do, and only when they agree', () => {
  const rows = (...vals: unknown[]) => vals.map((v) => [v]);
  assert.equal(core.columnKind({ name: 'x', kind: 'datetime' }, rows(1, 2), 0), 'datetime', 'the driver\u2019s word is final, even against the values');

  assert.equal(core.columnKind({ name: 'x' }, rows(1, 2, null, 3), 0), 'integer');
  assert.equal(core.columnKind({ name: 'x' }, rows(1.5, 2.25), 0), 'decimal');
  assert.equal(core.columnKind({ name: 'x' }, rows(1, 2.5, 3), 0), 'decimal', 'whole and fractional numbers together are decimals');
  assert.equal(core.columnKind({ name: 'x' }, rows(true, false), 0), 'boolean');
  assert.equal(core.columnKind({ name: 'x' }, rows('a', 'b'), 0), 'text');
  assert.equal(core.columnKind({ name: 'x' }, rows(blob('00', 1)), 0), 'binary');
  assert.equal(core.columnKind({ name: 'x' }, rows(null, null), 0), 'other', 'nothing to go on');
  assert.equal(core.columnKind({ name: 'x' }, [], 0), 'other');
  assert.equal(core.columnKind({ name: 'x' }, rows(1, 'one', 2), 0), 'other', 'a column that holds anything has no kind');

  const long = Array.from({ length: 300 }, (_, i) => [i < 250 ? 1 : 'late']);
  assert.equal(core.columnKind({ name: 'x' }, long, 0), 'integer', 'only the first rows are looked at');
  assert.equal(core.columnKind({ name: 'b' }, [[1, 'x']], 1), 'text', 'the index picks the column');
});

test('columnFacts and columnTitle: what the header says about a column', () => {
  assert.deepEqual(core.columnFacts({ name: 'x' }), { pills: [], lines: [] });
  const f = core.columnFacts({
    name: 'author_id', primaryKey: true, foreignKey: { table: 'authors', column: 'id' }, unique: true, notNull: true, autoIncrement: true, defaultValue: '0',
  });
  assert.deepEqual(f.pills.map((p: any) => p.text), ['PK', 'FK', 'UQ']);
  assert.equal(f.pills[1].title, 'Foreign key to authors.id');
  assert.deepEqual(f.lines, ['primary key', 'references authors.id', 'unique', 'not null', 'filled in by the database when left out', 'default 0']);
  assert.deepEqual(core.columnFacts({ name: 'x', notNull: false }).lines, ['nullable']);
  assert.deepEqual(core.columnFacts({ name: 'x', primaryKey: true, notNull: false }).lines, ['primary key'], 'a key is not described as nullable');
  assert.deepEqual(core.columnFacts({ name: 'x', foreignKey: { table: 't' } }).lines, ['references t']);

  assert.equal(core.columnTitle({ name: 'id', type: 'INTEGER', primaryKey: true }), 'id (INTEGER)\nprimary key\nClick to sort');
  assert.equal(core.columnTitle({ name: 'n' }), 'n\nClick to sort');
});

test('sortOrder: numbers as numbers, text naturally, NULLs last either way, ties in their original order', () => {
  const rows = [[10, 'a10'], [2, 'a2'], [null, null], [2, 'a1'], [33, 'a3'], [null, 'z']];
  const all = rows.map((_, i) => i);
  assert.deepEqual(core.sortOrder(rows, all, 0, 1), [1, 3, 0, 4, 2, 5], 'ascending: 2, 2, 10, 33, then the NULLs');
  assert.deepEqual(core.sortOrder(rows, all, 0, -1), [4, 0, 1, 3, 2, 5], 'descending: still NULLs last, ties still in their original order');
  assert.deepEqual(core.sortOrder(rows, all, 1, 1).map((i: number) => rows[i][1]), ['a1', 'a2', 'a3', 'a10', 'z', null], 'a2 before a10');
  assert.deepEqual(core.sortOrder(rows, [4, 0, 1], 0, 1), [1, 0, 4], 'only the rows asked for');
  assert.deepEqual(all, [0, 1, 2, 3, 4, 5], 'the order passed in is not touched');
  assert.ok(core.compareCells('apple', 'Banana') < 0, 'case does not decide');
});

test('fitWidths fitAll: every column gets the same share, whatever is in it', () => {
  const o = { mode: 'fitAll', headerPx: [300, 20, 90], valuePx: [900, 5, 5], available: 1000 };
  const w = core.fitWidths(o);
  assert.equal(w.reduce((a: number, b: number) => a + b, 0), 1000, 'the columns fill the panel exactly');
  assert.deepEqual(w, [334, 333, 333], 'the spare pixel goes to the first column');
  assert.deepEqual(core.fitWidths({ ...o, available: 90 }), [56, 56, 56], 'too many columns for the panel: the minimum wins and the grid scrolls');
  assert.deepEqual(core.fitWidths({ ...o, headerPx: [], valuePx: [] }), []);
});

test('fitWidths fitName: wide enough for the header, within the limits', () => {
  assert.deepEqual(core.fitWidths({ mode: 'fitName', headerPx: [10, 120.2, 900], valuePx: [999, 999, 999], available: 500 }), [56, 121, 420], 'values are ignored; min and max apply');
  assert.deepEqual(core.fitWidths({ mode: 'fitName', headerPx: [10, 900], min: 30, max: 500 }), [30, 500]);
});

test('fitWidths fitNameAndValue: the wider of the two, but one huge value cannot explode a column', () => {
  const o = { mode: 'fitNameAndValue', headerPx: [80, 200, 60, 70], valuePx: [140, 90, 8000, undefined], available: 500 };
  assert.deepEqual(core.fitWidths(o), [140, 200, 420, 70], 'the widest of name and value; the 8000 px value is capped; a missing value leaves the name');
  assert.deepEqual(core.fitWidths({ ...o, max: 300 }), [140, 200, 300, 70], 'the cap is adjustable');
  assert.deepEqual(core.fitWidths({ mode: 'nonsense', headerPx: [80], valuePx: [140] }), [140], 'an unknown mode means the default one');
  assert.deepEqual(core.fitWidths({ mode: 'fitNameAndValue', headerPx: [5], valuePx: [5] }), [56], 'never below the minimum');
  assert.deepEqual(core.FIT_MODES, ['fitAll', 'fitName', 'fitNameAndValue']);
});

test('filterKey: NULL stays NULL, everything else is its text', () => {
  assert.equal(core.filterKey(null), null);
  assert.equal(core.filterKey(undefined), null);
  assert.equal(core.filterKey(0), '0', 'zero is a value, not nothing');
  assert.equal(core.filterKey(''), '', 'so is the empty string, and it is not NULL');
  assert.equal(core.filterKey(false), 'false');
  assert.equal(core.filterKey(blob('0aff', 2)), '0x0aff');
});

test('distinctValues: counts, natural order, NULL last; only the rows asked for', () => {
  const rows = [[10, 'b'], [-5, 'a'], [2, 'b'], [null, 'a'], [2, null], [-12, 'B'], [0.5, '']];
  const all = rows.map((_, i) => i);
  const nums = core.distinctValues(rows, all, 0);
  assert.deepEqual(nums.map((e: any) => e.key), ['-12', '-5', '0.5', '2', '10', null], 'numbers by value, so -12 comes before -5 and 2 before 10');
  assert.deepEqual(nums.map((e: any) => e.count), [1, 1, 1, 2, 1, 1]);
  const text = core.distinctValues(rows, all, 1);
  assert.deepEqual(text.map((e: any) => [e.key, e.count]), [['', 1], ['a', 2], ['b', 2], ['B', 1], [null, 1]], 'the empty string is its own value and sorts first; NULL is last; b and B stay two values');
  assert.deepEqual(core.distinctValues(rows, [0, 2, 4], 0).map((e: any) => [e.key, e.count]), [['2', 2], ['10', 1]], 'only the rows in `order`');
  assert.deepEqual(core.distinctValues(rows, [], 0), []);
  assert.equal(core.distinctValues(rows, all, 0)[0].value, -12, 'the first value seen is kept, for display');
});

test('searchValues: contains, case-insensitive; NULL is found by typing "null"', () => {
  const list = core.distinctValues([['Apple'], ['apricot'], ['banana'], [null]], [0, 1, 2, 3], 0);
  assert.deepEqual(core.searchValues(list, 'AP').map((e: any) => e.key), ['Apple', 'apricot']);
  assert.deepEqual(core.searchValues(list, 'an').map((e: any) => e.key), ['banana']);
  assert.deepEqual(core.searchValues(list, 'null').map((e: any) => e.key), [null]);
  assert.equal(core.searchValues(list, ''), list, 'nothing typed: everything');
  assert.equal(core.searchValues(list, '   '), list, 'only spaces: everything');
  assert.deepEqual(core.searchValues(list, 'zzz'), []);
});

test('applyFilters: columns combine with AND; a filter hides what it names; one column can be left out', () => {
  const rows = [['a', 1], ['b', 1], ['a', 2], [null, 2], ['c', null]];
  const all = rows.map((_, i) => i);
  const none = new Map();
  assert.equal(core.applyFilters(rows, all, none), all, 'no filters: the same order, untouched');
  assert.equal(core.applyFilters(rows, all, new Map([[0, new Set()]])), all, 'a filter that hides nothing is no filter');

  const hideB = new Map([[0, new Set(['b'])]]);
  assert.deepEqual(core.applyFilters(rows, all, hideB), [0, 2, 3, 4]);
  assert.deepEqual(core.applyFilters(rows, all, new Map([[0, new Set([null])]])), [0, 1, 2, 4], 'NULL can be hidden');
  assert.deepEqual(core.applyFilters(rows, all, new Map([[1, new Set([null, '2'])]])), [0, 1], 'and so can several values at once');

  const both = new Map([[0, new Set(['b'])], [1, new Set(['1'])]]);
  assert.deepEqual(core.applyFilters(rows, all, both), [2, 3, 4], 'a row must pass every column');
  assert.deepEqual(core.applyFilters(rows, all, both, 0), [2, 3, 4], 'skipping column 0 leaves only column 1, which hides the value "1"');
  assert.deepEqual(core.applyFilters(rows, all, both, 1), [0, 2, 3, 4], 'skipping column 1 leaves only column 0 hiding "b"');
  assert.deepEqual(core.applyFilters(rows, [4, 2, 0], hideB), [4, 2, 0], 'the order it is given is the order it keeps');
  assert.deepEqual(all, [0, 1, 2, 3, 4], 'and the order passed in is not touched');
});
