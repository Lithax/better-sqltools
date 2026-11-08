import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Catalog } from '../src/domain/model';
import { complete } from '../src/domain/sql/completion';

const catalog: Catalog = {
  schemas: ['main', 'audit'],
  tables: [
    { name: 'users', kind: 'table', schema: 'main', columns: [{ name: 'id', type: 'INTEGER' }, { name: 'email', type: 'TEXT' }] },
    { name: 'orders', kind: 'table', schema: 'main', columns: [{ name: 'id' }, { name: 'user_id' }, { name: 'total' }] },
    { name: 'order items', kind: 'view', schema: 'audit', columns: [{ name: 'sku' }] },
  ],
};
const dialect = { identifierQuote: { open: '"', close: '"' }, limit: 'limit' as const };

/** `|` marks the cursor. */
function at(sql: string) {
  const offset = sql.indexOf('|');
  const text = sql.replace('|', '');
  const r = complete({ text, offset, catalog, dialect });
  return { labels: r.candidates.map((c) => c.label), r, kinds: new Set(r.candidates.map((c) => c.kind)), text };
}

test('table names after FROM and JOIN', () => {
  assert.deepEqual(at('select * from |').labels.slice(0, 3), ['users', 'orders', 'order items']);
  assert.ok(at('select * from users u join |').labels.includes('orders'));
});

test('columns after alias dot', () => {
  const { labels } = at('select u.| from users u');
  assert.deepEqual(labels, ['id', 'email']);
});

test('columns after table name dot, with schema qualification', () => {
  assert.deepEqual(at('select users.| from users').labels, ['id', 'email']);
  assert.deepEqual(at('select main.orders.| from main.orders').labels, ['id', 'user_id', 'total']);
});

test('schema dot lists its tables', () => {
  assert.deepEqual(at('select * from audit.|').labels, ['order items']);
});

test('SELECT list offers columns of the tables in FROM, even when written later', () => {
  const { labels } = at('select | from orders o join users u on u.id = o.user_id');
  assert.ok(['id', 'user_id', 'total', 'email'].every((c) => labels.includes(c)));
  assert.ok(labels.includes('o') && labels.includes('u'), 'aliases offered');
});

test('WHERE after a comma-separated FROM list', () => {
  const { labels } = at('select * from users, orders where |');
  assert.ok(labels.includes('email') && labels.includes('total'));
});

test('INSERT INTO t ( offers t columns', () => {
  assert.deepEqual(at('insert into users (|').labels, ['id', 'email']);
});

test('names that need quoting are quoted with the dialect quote', () => {
  const c = complete({ text: 'select * from ', offset: 14, catalog, dialect }).candidates.find((x) => x.label === 'order items');
  assert.equal(c?.insertText, '"order items"');
});

test('nothing inside strings or comments', () => {
  assert.deepEqual(at(`select 'abc|def' from users`).labels, []);
  assert.deepEqual(at('select 1 -- comm|ent').labels, []);
  assert.deepEqual(at('select /* x| */ 1').labels, []);
});

test('a new statement after a semicolon is not polluted by the previous one', () => {
  const { labels } = at('select * from users;\n|');
  assert.ok(labels.includes('SELECT'));
  assert.ok(!labels.includes('email'));
});

test('keyword case follows what the user typed', () => {
  assert.equal(at('sel|').r.candidates.find((c) => c.label === 'SELECT')?.insertText, 'select');
  assert.equal(at('SEL|').r.candidates.find((c) => c.label === 'SELECT')?.insertText, 'SELECT');
});

test('replaceStart covers the partially typed word', () => {
  const { r, text } = at('select * from us|');
  assert.equal(text.slice(r.replaceStart), 'us');
});

test('works without a catalog (keywords only)', () => {
  const r = complete({ text: 'sel', offset: 3 });
  assert.ok(r.candidates.some((c) => c.label === 'SELECT'));
});
