/**
 * Which table column each column of a result is read from, worked out from the SQL against the catalog.
 *
 * It is deliberately modest: it understands one plain `SELECT <list> FROM <tables> ...` (joins and aliases included)
 * and gives up on anything else, because a wrong answer here would put a wrong type or constraint on screen and let an
 * edit go to the wrong column. Drivers that know better (most server databases report the source of every result
 * column themselves) set `Column.source` and never reach this code.
 */
import type { Catalog, CatalogTable, ColumnSource } from '../model';
import { tokenize, unquoteIdentifier, type Token, type TokenizerOptions } from './tokenizer';

const isTrivia = (t: Token) => t.kind === 'whitespace' || t.kind === 'comment';
const isName = (t: Token | undefined): t is Token => !!t && (t.kind === 'word' || t.kind === 'quoted');
const word = (t: Token | undefined) => (t?.kind === 'word' ? t.text.toUpperCase() : '');
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** What ends the list of tables of a SELECT. */
const FROM_END = new Set(['WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'OFFSET', 'FETCH', 'WINDOW', 'FOR', 'RETURNING', 'QUALIFY']);
/** Statements made of more than one SELECT; which one a column comes from is not for us to guess. */
const COMPOUND = new Set(['UNION', 'INTERSECT', 'EXCEPT', 'MINUS']);
/** Words that follow a table name and are therefore not its alias. */
const NOT_ALIAS = new Set([
  'ON', 'USING', 'JOIN', 'INNER', 'LEFT', 'RIGHT', 'FULL', 'OUTER', 'CROSS', 'NATURAL', 'STRAIGHT_JOIN', 'LATERAL',
  ...FROM_END, ...COMPOUND,
]);

/** The table a name refers to. Without a schema the default schema wins, then the first match. */
export function findCatalogTable(catalog: Catalog, schema: string | undefined, name: string): CatalogTable | undefined {
  const named = catalog.tables.filter((t) => same(t.name, name) && (!schema || (t.schema !== undefined && same(t.schema, schema))));
  if (named.length <= 1 || schema) return named[0];
  return named.find((t) => t.schema !== undefined && catalog.defaultSchema !== undefined && same(t.schema, catalog.defaultSchema)) ?? named[0];
}

interface Ref {
  table: CatalogTable;
  alias?: string;
}

const sourceOf = (t: CatalogTable, column: string): ColumnSource => (t.schema !== undefined ? { schema: t.schema, table: t.name, column } : { table: t.name, column });

/** `a`, `a.b`, `a.b.c` starting at `i`: the parts and the index after them. */
function dotted(sig: Token[], i: number): { parts: string[]; next: number } | undefined {
  if (!isName(sig[i])) return undefined;
  const parts = [unquoteIdentifier(sig[i].text)];
  let next = i + 1;
  while (sig[next]?.text === '.' && isName(sig[next + 1])) {
    parts.push(unquoteIdentifier(sig[next + 1].text));
    next += 2;
  }
  return { parts, next };
}

function splitTopLevel(tokens: Token[], depth: number[], offset: number): Token[][] {
  const items: Token[][] = [[]];
  tokens.forEach((t, k) => {
    if (t.text === ',' && depth[offset + k] === 0) items.push([]);
    else items[items.length - 1].push(t);
  });
  return items;
}

/**
 * For each of `columnCount` result columns, the table column it is read from, or undefined when it is an expression,
 * is ambiguous or cannot be found. The whole result is undefined when the statement is not a plain single SELECT over
 * tables the catalog knows, or when the select list does not account for exactly `columnCount` columns.
 */
export function inferColumnSources(sql: string, catalog: Catalog, options: TokenizerOptions, columnCount: number): (ColumnSource | undefined)[] | undefined {
  const sig = tokenize(sql, options).filter((t) => !isTrivia(t));
  while (sig.at(-1)?.text === ';') sig.pop();
  if (word(sig[0]) !== 'SELECT') return undefined; // also rules out WITH and every other statement

  // parenthesis depth in front of each token
  const depth: number[] = [];
  let d = 0;
  for (const t of sig) {
    if (t.text === ')') d--;
    depth.push(d);
    if (t.text === '(') d++;
  }
  if (sig.some((t, i) => depth[i] === 0 && COMPOUND.has(word(t)))) return undefined;

  let listStart = 1;
  if (word(sig[1]) === 'DISTINCT' && word(sig[2]) === 'ON') return undefined;
  if (word(sig[1]) === 'DISTINCT' || word(sig[1]) === 'ALL') listStart = 2;
  const from = sig.findIndex((t, i) => i >= listStart && depth[i] === 0 && word(t) === 'FROM');
  if (from < 0) return undefined;

  // the tables
  const refs: Ref[] = [];
  let expectTable = true;
  for (let i = from + 1; i < sig.length; i++) {
    const t = sig[i];
    if (depth[i] > 0) continue;
    if (FROM_END.has(word(t))) break;
    if (word(t) === 'JOIN' || t.text === ',') {
      expectTable = true;
      continue;
    }
    if (!expectTable) continue;
    if (t.text === '(') return undefined; // a subquery: its columns are not the catalog's
    const name = dotted(sig, i);
    if (!name) return undefined;
    const table = findCatalogTable(catalog, name.parts.at(-2), name.parts.at(-1)!);
    if (!table) return undefined;
    let next = name.next;
    if (word(sig[next]) === 'AS') next++;
    let alias: string | undefined;
    if (isName(sig[next]) && depth[next] === 0 && !(sig[next].kind === 'word' && NOT_ALIAS.has(word(sig[next])))) {
      alias = unquoteIdentifier(sig[next].text);
      next++;
    }
    refs.push({ table, alias });
    expectTable = false;
    i = next - 1;
  }
  if (!refs.length) return undefined;

  const refFor = (qualifier: string) => refs.find((r) => (r.alias ? same(r.alias, qualifier) : same(r.table.name, qualifier))) ?? refs.find((r) => same(r.table.name, qualifier));
  const all = (r: Ref) => r.table.columns.map((c) => sourceOf(r.table, c.name));

  // the select list, one entry per output column
  const out: (ColumnSource | undefined)[] = [];
  for (const item of splitTopLevel(sig.slice(listStart, from), depth, listStart)) {
    if (!item.length) return undefined;
    if (item.length === 1 && item[0].text === '*') {
      refs.forEach((r) => out.push(...all(r)));
      continue;
    }
    if (item.length === 3 && item[1].text === '.' && item[2].text === '*' && isName(item[0])) {
      const ref = refFor(unquoteIdentifier(item[0].text));
      if (!ref) return undefined;
      out.push(...all(ref));
      continue;
    }
    const name = dotted(item, 0);
    const rest = name ? item.slice(name.next) : [];
    const plain = name && (rest.length === 0 || (rest.length === 1 && isName(rest[0]) && !NOT_ALIAS.has(word(rest[0]))) || (rest.length === 2 && word(rest[0]) === 'AS' && isName(rest[1])));
    if (!name || !plain) {
      out.push(undefined); // an expression, a function call, a literal...
      continue;
    }
    const column = name.parts.at(-1)!;
    const qualifier = name.parts.at(-2);
    const candidates = qualifier ? [refFor(qualifier)].filter((r): r is Ref => !!r) : refs;
    const found = candidates.flatMap((r) => r.table.columns.filter((c) => same(c.name, column)).map((c) => sourceOf(r.table, c.name)));
    out.push(found.length === 1 ? found[0] : undefined); // zero: not a column (NULL, TRUE...); several: ambiguous
  }
  return out.length === columnCount ? out : undefined;
}
