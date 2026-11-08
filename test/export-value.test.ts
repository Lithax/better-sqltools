import assert from 'node:assert/strict';
import { test } from 'node:test';
import { toCsv, toJson, toTsv } from '../src/domain/export';
import { toCell } from '../src/domain/value';
import { normalizeOptions, validateDescriptor } from '../src/domain/validation';
import { sqliteDescriptor } from '../src/drivers/sqlite';

test('toCell makes anything JSON-safe', () => {
  assert.equal(toCell(null), null);
  assert.equal(toCell(undefined), null);
  assert.equal(toCell(10n ** 20n), '100000000000000000000');
  assert.equal(toCell(new Date(0)), '1970-01-01T00:00:00.000Z');
  assert.equal(toCell(NaN), 'NaN');
  assert.deepEqual(toCell(new Uint8Array([1, 255])), { $blob: '01ff', bytes: 2 });
  assert.equal(toCell({ a: 1n }), '{"a":"1"}');
  const big = toCell(new Uint8Array(1000)) as { $blob: string; bytes: number };
  assert.equal(big.$blob.length, 128);
  assert.equal(big.bytes, 1000);
  JSON.stringify([toCell(1n), toCell(new Uint8Array(3))]); // must not throw
});

test('CSV quoting follows RFC 4180', () => {
  const csv = toCsv([{ name: 'a' }, { name: 'b,c' }], [['x"y', null], ['line\nbreak', 3]]);
  assert.equal(csv, 'a,"b,c"\r\n"x""y",\r\n"line\nbreak",3\r\n');
});

test('TSV flattens whitespace; JSON de-duplicates column names', () => {
  assert.equal(toTsv([{ name: 'a' }], [['x\ty\nz']]), 'a\nx y z');
  assert.deepEqual(JSON.parse(toJson([{ name: 'id' }, { name: 'id' }], [[1, 2]])), [{ id: 1, id_2: 2 }]);
});

test('descriptor validation', () => {
  assert.deepEqual(validateDescriptor(sqliteDescriptor), []);
  const bad = { ...sqliteDescriptor, id: '1 bad', connectionSchema: [{ key: 'a', label: 'A', type: 'string' as const }, { key: 'a', label: 'A', type: 'select' as const }] };
  const problems = validateDescriptor(bad);
  assert.ok(problems.some((p) => p.includes('must match')));
  assert.ok(problems.some((p) => p.includes('Duplicate')));
  assert.ok(problems.some((p) => p.includes('select without options')));
});

test('option normalisation applies defaults, coerces and reports', () => {
  const ok = normalizeOptions(sqliteDescriptor, { path: 'x.db', readOnly: 'true' });
  assert.deepEqual(ok.problems, []);
  assert.equal(ok.options.readOnly, true);
  assert.equal(ok.options.foreignKeys, true); // default
  assert.deepEqual(normalizeOptions(sqliteDescriptor, {}).problems, ['"Database file" is required.']);
  const num = normalizeOptions(
    { ...sqliteDescriptor, connectionSchema: [{ key: 'port', label: 'Port', type: 'number', min: 1, max: 65535 }] },
    { port: '99999' },
  );
  assert.deepEqual(num.problems, ['"Port" must be at most 65535.']);
});
