import assert from 'node:assert/strict';
import { test } from 'node:test';
import { enrichColumns } from '../src/domain/columns';
import type { Catalog, Column } from '../src/domain/model';
import { inferColumnSources } from '../src/domain/sql/sources';
import { tokenizerOptions } from '../src/domain/sql/tokenizer';

const catalog: Catalog = {
  tables: [
    {
      name: 'books', kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true, nullable: false, autoIncrement: true },
        { name: 'title', type: 'TEXT', kind: 'text', nullable: false },
        { name: 'author_id', type: 'INTEGER', kind: 'integer', nullable: true, foreignKey: { table: 'authors', column: 'id' } },
        { name: 'isbn', type: 'TEXT', kind: 'text', nullable: true, unique: true, defaultValue: "'n/a'" },
        { name: 'price', type: 'REAL', kind: 'decimal' },
      ],
    },
    {
      name: 'authors', kind: 'table',
      columns: [
        { name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true, nullable: false },
        { name: 'name', type: 'TEXT', kind: 'text', nullable: false },
      ],
    },
    { name: 'recent', kind: 'view', columns: [{ name: 'title', type: 'TEXT', kind: 'text' }] },
  ],
};
const schemas: Catalog = {
  defaultSchema: 'public',
  tables: [
    { schema: 'audit', name: 'log', kind: 'table', columns: [{ name: 'message', type: 'text', kind: 'text' }] },
    { schema: 'public', name: 'log', kind: 'table', columns: [{ name: 'message', type: 'varchar(80)', kind: 'text' }] },
  ],
};

const opts = tokenizerOptions();
const infer = (sql: string, count: number, c: Catalog = catalog) => inferColumnSources(sql, c, opts, count);
const books = (column: string) => ({ table: 'books', column });
const authors = (column: string) => ({ table: 'authors', column });

test('sources: select * and a plain column list', () => {
  assert.deepEqual(infer('select * from books', 5), ['id', 'title', 'author_id', 'isbn', 'price'].map(books));
  assert.deepEqual(infer('select id, title from books where id > 1 order by title limit 5;', 2), [books('id'), books('title')]);
  assert.deepEqual(infer('select distinct title from books', 1), [books('title')]);
  assert.deepEqual(infer('SELECT TITLE FROM BOOKS', 1), [books('title')], 'case does not matter, and the catalog\u2019s spelling wins');
  assert.deepEqual(infer('select /* c */ id -- x\n from books;', 1), [books('id')], 'comments and the semicolon are ignored');
});

test('sources: aliases, qualified columns and renamed output columns', () => {
  assert.deepEqual(infer('select b.id, b.title as t, author_id aid from books b', 3), [books('id'), books('title'), books('author_id')]);
  assert.deepEqual(infer('select b.* from books as b', 5), ['id', 'title', 'author_id', 'isbn', 'price'].map(books));
  assert.deepEqual(infer('select "id", "title" from "books"', 2), [books('id'), books('title')], 'quoted identifiers');
});

test('sources: joins, comma joins, and columns that are or are not ambiguous', () => {
  assert.deepEqual(
    infer('select b.title, a.name from books b join authors a on a.id = b.author_id', 2),
    [books('title'), authors('name')],
  );
  assert.deepEqual(
    infer('select a.name from books b left outer join authors a on a.id = b.author_id where b.id in (select id from books)', 1),
    [authors('name')],
    'a subquery in WHERE does not confuse the table list',
  );
  assert.deepEqual(infer('select name, title from books, authors', 2), [authors('name'), books('title')], 'unqualified but unambiguous');
  assert.deepEqual(infer('select id from books join authors on 1 = 1', 1), [undefined], 'both tables have an id: no guess');
  assert.deepEqual(
    infer('select a.*, b.title from authors a join books b on b.author_id = a.id', 3),
    [authors('id'), authors('name'), books('title')],
  );
  assert.deepEqual(infer('select * from books, authors', 7), [...['id', 'title', 'author_id', 'isbn', 'price'].map(books), authors('id'), authors('name')]);
});

test('sources: expressions have no source, and never shift the columns after them', () => {
  assert.deepEqual(
    infer("select id, count(*) as n, price * 2, 'x', null, title from books", 6),
    [books('id'), undefined, undefined, undefined, undefined, books('title')],
  );
  assert.deepEqual(infer('select lower(title) from books', 1), [undefined]);
  assert.deepEqual(infer('select cast(id as text) from books', 1), [undefined]);
  assert.deepEqual(infer('select nothere from books', 1), [undefined], 'not a column of any table');
});

test('sources: views are tables for this purpose', () => {
  assert.deepEqual(infer('select * from recent', 1), [{ table: 'recent', column: 'title' }]);
});

test('sources: schemas decide between tables of the same name', () => {
  assert.deepEqual(infer('select message from audit.log', 1, schemas), [{ schema: 'audit', table: 'log', column: 'message' }]);
  assert.deepEqual(infer('select message from log', 1, schemas), [{ schema: 'public', table: 'log', column: 'message' }], 'the default schema wins');
  assert.deepEqual(infer('select l.message from public.log l', 1, schemas), [{ schema: 'public', table: 'log', column: 'message' }]);
});

test('sources: gives up rather than guess', () => {
  assert.equal(infer('select * from books', 3), undefined, 'the list does not account for the columns the result has');
  assert.equal(infer('select * from nowhere', 1), undefined, 'a table the catalog does not know');
  assert.equal(infer('select 1', 1), undefined, 'no tables');
  assert.equal(infer('select * from (select id from books) s', 1), undefined, 'a subquery in FROM');
  assert.equal(infer('with x as (select 1) select * from books', 5), undefined, 'a CTE');
  assert.equal(infer('select id from books union select id from authors', 1), undefined, 'a compound select');
  assert.equal(infer('select distinct on (id) id from books', 1), undefined);
  assert.equal(infer('insert into books (title) values (\'x\') returning id', 1), undefined, 'not a SELECT');
  assert.equal(infer('', 0), undefined);
});

const bookColumns: Column[] = [{ name: 'id' }, { name: 'title' }, { name: 'author_id' }, { name: 'isbn' }, { name: 'price' }];

test('enrichColumns: table columns bring their type, kind and constraints, and only what is known', () => {
  const out = enrichColumns(bookColumns, 'select * from books', catalog, opts);
  assert.deepEqual(out[0], { name: 'id', type: 'INTEGER', kind: 'integer', notNull: true, primaryKey: true, autoIncrement: true, source: books('id') });
  assert.deepEqual(out[1], { name: 'title', type: 'TEXT', kind: 'text', notNull: true, source: books('title') });
  assert.deepEqual(out[2], { name: 'author_id', type: 'INTEGER', kind: 'integer', notNull: false, foreignKey: { table: 'authors', column: 'id' }, source: books('author_id') });
  assert.deepEqual(out[3], { name: 'isbn', type: 'TEXT', kind: 'text', notNull: false, unique: true, defaultValue: "'n/a'", source: books('isbn') });
  assert.deepEqual(out[4], { name: 'price', type: 'REAL', kind: 'decimal', source: books('price') }, 'an unknown nullability stays unknown');
});

test('enrichColumns: expressions are left exactly as they were', () => {
  const columns: Column[] = [{ name: 'id' }, { name: 'n' }];
  const out = enrichColumns(columns, 'select id, count(*) n from books', catalog, opts);
  assert.equal(out[0].primaryKey, true);
  assert.equal(out[1], columns[1], 'the same object: nothing was added');
  assert.deepEqual(out[1], { name: 'n' });
});

test('enrichColumns: what the driver said about a column wins; a source the driver gave is used without parsing', () => {
  const out = enrichColumns(
    [{ name: 'id', type: 'BIGINT', kind: 'decimal' }, { name: 'x', source: authors('name') }],
    'select * from (select id, name as x from authors) sub', // too complicated for the inference
    catalog,
    opts,
  );
  assert.equal(out[0].type, 'BIGINT');
  assert.equal(out[0].kind, 'decimal');
  assert.equal(out[0].source, undefined, 'no source: the inference could not trace it');
  assert.deepEqual(out[1], { name: 'x', type: 'TEXT', kind: 'text', notNull: true, source: authors('name') });
});

test('enrichColumns: a source the catalog does not know is ignored; no catalog means nothing to add', () => {
  const lost: Column[] = [{ name: 'x', source: { table: 'gone', column: 'x' } }, { name: 'y', source: { table: 'books', column: 'gone' } }];
  assert.deepEqual(enrichColumns(lost, 'select 1, 2', catalog, opts), lost);
  assert.equal(enrichColumns(bookColumns, 'select * from books', undefined, opts), bookColumns);
  assert.deepEqual(enrichColumns([], 'select 1', catalog, opts), []);
});
