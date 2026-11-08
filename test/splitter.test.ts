import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitStatements, statementAt } from '../src/domain/sql/splitter';

const texts = (sql: string, o = {}) => splitStatements(sql, o).map((s) => s.text);

test('splits on semicolons and trims', () => {
  assert.deepEqual(texts('select 1;  select 2 ;\n\nselect 3'), ['select 1', 'select 2', 'select 3']);
});

test('ignores semicolons in strings, quoted identifiers and comments', () => {
  assert.deepEqual(
    texts(`select 'a;b', "c;d" from t; -- not; a split\nselect /* x; y */ 2;`),
    [`select 'a;b', "c;d" from t`, `select /* x; y */ 2`],
  );
});

test("handles doubled quotes inside strings", () => {
  assert.deepEqual(texts(`select 'it''s; fine'; select 2`), [`select 'it''s; fine'`, 'select 2']);
});

test('skips comment-only and empty statements', () => {
  assert.deepEqual(texts('-- hi\n;;  ; /* nothing */ ; select 1'), ['select 1']);
});

test('dollar quoting is dialect-gated', () => {
  const sql = `do $$ begin perform 1; perform 2; end $$; select 3`;
  assert.deepEqual(texts(sql, { dollarQuoting: true }), ['do $$ begin perform 1; perform 2; end $$', 'select 3']);
  assert.equal(texts(sql, {}).length > 2, true);
});

test('MySQL-style backslash escapes and hash comments', () => {
  assert.deepEqual(texts(`select 'a\\'b;c'; # x; y\nselect 2`, { backslashEscapes: true, hashComments: true }), [
    `select 'a\\'b;c'`,
    'select 2',
  ]);
});

test('keeps CREATE TRIGGER bodies together (SQLite)', () => {
  const sql = `create trigger t after insert on a begin update b set n = n + 1; insert into log values (case when 1 then 2 end); end; select 1;`;
  const out = texts(sql);
  assert.equal(out.length, 2);
  assert.match(out[0], /^create trigger[\s\S]*end$/);
  assert.equal(out[1], 'select 1');
});

test('END IF / END LOOP inside routines do not close the body early', () => {
  const sql = `create procedure p() begin if x then select 1; end if; select 2; end; select 3`;
  assert.deepEqual(texts(sql).length, 2);
});

test('BEGIN as a transaction statement is not a block', () => {
  assert.deepEqual(texts('begin; insert into t values (1); commit;'), ['begin', 'insert into t values (1)', 'commit']);
});

test('statementAt picks containing, else previous, else next', () => {
  const sql = 'select 1;\n\nselect 2;';
  const st = splitStatements(sql);
  assert.equal(statementAt(st, 3)?.text, 'select 1');
  assert.equal(statementAt(st, 10)?.text, 'select 1'); // blank line after first
  assert.equal(statementAt(st, 15)?.text, 'select 2');
  assert.equal(statementAt([], 0), undefined);
});

test('offsets point at the original text', () => {
  const sql = '  select 1 ;\nselect 2';
  const [a, b] = splitStatements(sql);
  assert.equal(sql.slice(a.start, a.end), 'select 1');
  assert.equal(sql.slice(a.start, a.fullEnd), 'select 1 ;');
  assert.equal(sql.slice(b.start, b.end), 'select 2');
  assert.equal(b.terminated, false);
});
