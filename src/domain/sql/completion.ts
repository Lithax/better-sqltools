import type { DialectInfo } from '../driver-descriptor';
import type { Catalog, CatalogTable } from '../model';
import { SQL_FUNCTIONS, SQL_KEYWORDS } from './keywords';
import { splitStatements } from './splitter';
import { tokenize, tokenizerOptions, unquoteIdentifier, type Token } from './tokenizer';

export type CandidateKind = 'keyword' | 'function' | 'schema' | 'table' | 'view' | 'column';

export interface CompletionCandidate {
  label: string;
  insertText: string;
  kind: CandidateKind;
  detail?: string;
  /** Lower sorts first. */
  group: number;
}

export interface CompletionRequest {
  text: string;
  offset: number;
  catalog?: Catalog;
  dialect?: DialectInfo;
}

export interface CompletionResult {
  candidates: CompletionCandidate[];
  /** Offset where the word being completed starts. */
  replaceStart: number;
}

interface TableRef {
  schema?: string;
  name: string;
  alias?: string;
}

const TABLE_CLAUSES = new Set(['FROM', 'JOIN', 'INTO', 'UPDATE', 'TABLE']);
const COLUMN_CLAUSES = new Set([
  'SELECT', 'WHERE', 'ON', 'BY', 'HAVING', 'SET', 'AND', 'OR', 'USING', 'WHEN', 'THEN', 'ELSE', 'DISTINCT',
]);
const NOT_AN_ALIAS = new Set([
  ...TABLE_CLAUSES, ...COLUMN_CLAUSES, 'LEFT', 'RIGHT', 'INNER', 'OUTER', 'FULL', 'CROSS', 'NATURAL',
  'GROUP', 'ORDER', 'LIMIT', 'OFFSET', 'UNION', 'INTERSECT', 'EXCEPT', 'VALUES', 'RETURNING', 'WINDOW',
  'FETCH', 'FOR', 'AS',
]);
const FROM_LIST_ENDERS = new Set([
  'WHERE', 'GROUP', 'ORDER', 'HAVING', 'LIMIT', 'UNION', 'INTERSECT', 'EXCEPT', 'RETURNING', 'WINDOW', 'SET',
]);

const isTrivia = (t: Token) => t.kind === 'whitespace' || t.kind === 'comment';
const isName = (t: Token | undefined): t is Token => !!t && (t.kind === 'word' || t.kind === 'quoted');

function parseTableRefs(sig: Token[]): TableRef[] {
  const refs: TableRef[] = [];
  let expect = false;
  let inFromList = false;
  for (let i = 0; i < sig.length; i++) {
    const t = sig[i];
    const up = t.kind === 'word' ? t.text.toUpperCase() : '';

    if (up && TABLE_CLAUSES.has(up)) {
      expect = true;
      inFromList = up === 'FROM';
      continue;
    }
    if (up && FROM_LIST_ENDERS.has(up)) inFromList = false;
    if (t.kind === 'symbol' && t.text === ',' && inFromList) {
      expect = true;
      continue;
    }
    if (!expect) continue;
    expect = false;
    if (!isName(t)) continue; // subquery or garbage

    const parts = [unquoteIdentifier(t.text)];
    while (sig[i + 1]?.text === '.' && isName(sig[i + 2])) {
      parts.push(unquoteIdentifier(sig[i + 2].text));
      i += 2;
    }
    let alias: string | undefined;
    if (sig[i + 1]?.kind === 'word' && sig[i + 1].text.toUpperCase() === 'AS' && isName(sig[i + 2])) {
      alias = unquoteIdentifier(sig[i + 2].text);
      i += 2;
    } else if (isName(sig[i + 1]) && !(sig[i + 1].kind === 'word' && NOT_AN_ALIAS.has(sig[i + 1].text.toUpperCase()))) {
      alias = unquoteIdentifier(sig[i + 1].text);
      i += 1;
    }
    refs.push({ schema: parts.length > 1 ? parts[parts.length - 2] : undefined, name: parts[parts.length - 1], alias });
  }
  return refs;
}

const eq = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && a.toLowerCase() === b.toLowerCase();

function findTables(catalog: Catalog | undefined, name: string, schema?: string): CatalogTable[] {
  return (catalog?.tables ?? []).filter((t) => eq(t.name, name) && (schema === undefined || eq(t.schema, schema)));
}

function needsQuoting(name: string): boolean {
  return !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
}

/** Schema-aware completion for the statement around `offset`. Pure and synchronous. */
export function complete(req: CompletionRequest): CompletionResult {
  const { text, offset, catalog } = req;
  const opts = tokenizerOptions(req.dialect);
  const quote = (name: string) =>
    needsQuoting(name) && req.dialect
      ? req.dialect.identifierQuote.open + name + req.dialect.identifierQuote.close
      : name;

  // The "region" is the statement being typed; text after the cursor only counts if the cursor is inside a statement.
  const stmts = splitStatements(text, opts);
  const inside = stmts.find((s) => offset >= s.start && (offset < s.fullEnd || (offset === s.fullEnd && !s.terminated)));
  const regionStart = inside
    ? inside.start
    : Math.max(0, ...stmts.filter((s) => s.terminated && s.fullEnd <= offset).map((s) => s.fullEnd));
  const regionEnd = inside ? inside.end : offset;
  const region = text.slice(regionStart, Math.max(regionEnd, offset));
  const rel = offset - regionStart;

  const tokens = tokenize(region, opts);
  const empty: CompletionResult = { candidates: [], replaceStart: offset };

  // No completions inside strings or comments.
  for (const t of tokens) {
    if (t.kind === 'string' && rel > t.start && rel < t.end) return empty;
    if (t.kind === 'comment' && rel > t.start && (t.text.startsWith('/*') ? rel < t.end : rel <= t.end)) return empty;
  }

  // The word under the cursor.
  let wordStart = rel;
  while (wordStart > 0 && /[A-Za-z0-9_$\u0080-\uffff]/.test(region[wordStart - 1])) wordStart--;
  const prefix = region.slice(wordStart, rel);
  const replaceStart = regionStart + wordStart;

  const before = tokens.filter((t) => !isTrivia(t) && t.end <= wordStart);
  const sig = tokens.filter((t) => !isTrivia(t));
  const refs = parseTableRefs(sig);

  const out: CompletionCandidate[] = [];
  const add = (c: CompletionCandidate) => out.push(c);
  const tableItems = (tables: CatalogTable[], group: number) => {
    for (const t of tables) add({ label: t.name, insertText: quote(t.name), kind: t.kind, detail: t.schema, group });
  };
  const columnItems = (tables: CatalogTable[], group: number) => {
    for (const t of tables) {
      for (const c of t.columns) {
        add({ label: c.name, insertText: quote(c.name), kind: 'column', detail: [c.type, t.name].filter(Boolean).join(' · '), group });
      }
    }
  };
  const keywordItems = (group: number) => {
    const lower = prefix !== '' && prefix === prefix.toLowerCase();
    const fix = (s: string) => (lower ? s.toLowerCase() : s);
    for (const k of [...SQL_KEYWORDS, ...(req.dialect?.keywords ?? [])]) add({ label: k, insertText: fix(k), kind: 'keyword', group });
  };
  const functionItems = (group: number) => {
    const lower = prefix !== '' && prefix === prefix.toLowerCase();
    for (const f of [...SQL_FUNCTIONS, ...(req.dialect?.functions ?? [])]) {
      add({ label: f.toUpperCase(), insertText: lower ? f.toLowerCase() : f.toUpperCase(), kind: 'function', group });
    }
  };

  // 1) Qualified: `alias.` / `table.` / `schema.` / `schema.table.`
  if (before.length && before[before.length - 1].text === '.') {
    const parts: string[] = [];
    let i = before.length - 2;
    while (i >= 0 && isName(before[i])) {
      parts.unshift(unquoteIdentifier(before[i].text));
      if (i - 1 >= 0 && before[i - 1].text === '.') i -= 2;
      else break;
    }
    const last = parts[parts.length - 1];
    const schemaPart = parts.length > 1 ? parts[parts.length - 2] : undefined;
    if (last !== undefined) {
      const ref = parts.length === 1 ? refs.find((r) => eq(r.alias, last)) ?? refs.find((r) => eq(r.name, last)) : undefined;
      const tables = ref ? findTables(catalog, ref.name, ref.schema) : findTables(catalog, last, schemaPart);
      if (tables.length) {
        columnItems(tables, 0);
      } else if (parts.length === 1) {
        tableItems((catalog?.tables ?? []).filter((t) => eq(t.schema, last)), 0);
      }
    }
    return { candidates: dedupe(out), replaceStart };
  }

  // 2) Clause-driven.
  let clause: string | undefined;
  for (let i = before.length - 1; i >= 0; i--) {
    const t = before[i];
    if (t.kind !== 'word') continue;
    const up = t.text.toUpperCase();
    if (TABLE_CLAUSES.has(up) || COLUMN_CLAUSES.has(up)) {
      clause = up;
      break;
    }
  }
  const prev = before[before.length - 1];

  if (clause === 'INTO' && prev && (prev.text === '(' || prev.text === ',')) {
    // INSERT INTO t (|  → columns of t
    const into = refs[0];
    if (into) columnItems(findTables(catalog, into.name, into.schema), 0);
  } else if (clause && TABLE_CLAUSES.has(clause) && prev && ((prev.kind === 'word' && TABLE_CLAUSES.has(prev.text.toUpperCase())) || prev.text === ',')) {
    // Expecting a table name.
    tableItems(catalog?.tables ?? [], 0);
    for (const s of catalog?.schemas ?? []) add({ label: s, insertText: quote(s), kind: 'schema', group: 1 });
    if (prefix) keywordItems(3);
  } else if (clause && TABLE_CLAUSES.has(clause)) {
    // After a table reference: an alias or the next clause.
    keywordItems(1);
  } else if (clause && COLUMN_CLAUSES.has(clause)) {
    const scope = refs.flatMap((r) => findTables(catalog, r.name, r.schema));
    columnItems(scope.length ? scope : [], 0);
    for (const r of refs) if (r.alias) add({ label: r.alias, insertText: quote(r.alias), kind: 'table', detail: r.name, group: 1 });
    functionItems(2);
    keywordItems(3);
  } else {
    keywordItems(1);
    tableItems(catalog?.tables ?? [], 2);
  }

  return { candidates: dedupe(out), replaceStart };
}

function dedupe(items: CompletionCandidate[]): CompletionCandidate[] {
  const seen = new Set<string>();
  return items.filter((c) => {
    const k = `${c.kind}:${c.label}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}
