import type { Catalog, Cell, Column } from './model';
import { findCatalogTable } from './sql/sources';

/** Whether the rows of a result can be edited, and which columns. Everything comes from what the driver reported. */
export interface EditTarget {
  /** The table the rows are read from. Missing when nothing can be edited; then `reason` says why. */
  table?: { schema?: string; name: string };
  /** Result column indexes of the table's primary key, in the order of the key. A row is found again by these values. */
  keyColumns: number[];
  /** One entry per result column. */
  columns: { editable: boolean; reason?: string }[];
  reason?: string;
}

const same = (a: string | undefined, b: string | undefined) => (a ?? '').toLowerCase() === (b ?? '').toLowerCase();

/**
 * A result can be edited when its columns are read from ONE table (not a view) that has a primary key, and every
 * column of that key is in the result: only then is each row told apart from every other, so an edit changes exactly
 * the row the person is looking at. A column the query computes, or shows a second time, is read-only on its own.
 */
export function editTarget(columns: Column[], catalog: Catalog | undefined): EditTarget {
  const none = (reason: string): EditTarget => ({ keyColumns: [], columns: columns.map(() => ({ editable: false, reason })), reason });
  if (!columns.length) return none('The statement returned no columns.');
  if (!catalog) return none('The structure of the database is not loaded yet.');

  const sourced = columns.filter((c) => c.source);
  if (!sourced.length) return none('No column is read straight from a table column.');
  const first = sourced[0].source!;
  if (sourced.some((c) => !same(c.source!.table, first.table) || !same(c.source!.schema, first.schema))) {
    return none('The rows come from more than one table.');
  }
  const table = findCatalogTable(catalog, first.schema, first.table);
  if (!table) return none(`${first.table} is not in the database's structure.`);
  if (table.kind !== 'table') return none(`${table.name} is a view, and a view cannot be edited.`);

  const key = table.columns.filter((c) => c.primaryKey);
  if (!key.length) return none(`${table.name} has no primary key, so one row cannot be told apart from another.`);

  const firstOf = new Map<string, number>(); // table column (lower case) -> the first result column that shows it
  columns.forEach((c, i) => {
    const name = c.source?.column.toLowerCase();
    if (name !== undefined && !firstOf.has(name)) firstOf.set(name, i);
  });
  const missing = key.filter((c) => !firstOf.has(c.name.toLowerCase()));
  if (missing.length) return none(`Select the primary key (${missing.map((c) => c.name).join(', ')}) as well to edit ${table.name}.`);

  return {
    table: table.schema === undefined ? { name: table.name } : { schema: table.schema, name: table.name },
    keyColumns: key.map((c) => firstOf.get(c.name.toLowerCase())!),
    columns: columns.map((c, i) => {
      if (!c.source) return { editable: false, reason: 'Computed by the query; it is not a table column.' };
      if (firstOf.get(c.source.column.toLowerCase()) !== i) return { editable: false, reason: 'Shown more than once; the first one can be edited.' };
      if (c.kind === 'binary') return { editable: false, reason: 'Binary values cannot be edited here.' };
      return { editable: true };
    }),
  };
}

export type EditValue = { ok: true; value: Cell } | { ok: false; error: string };

const INTEGER = /^[+-]?\d+$/;
const DECIMAL = /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?(?:Z|[+-]\d{2}(?::?\d{2})?)?)?$/i;
const TIME = /^(\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?$/;
const TRUE = new Set(['true', 't', 'yes', 'y', '1']);
const FALSE = new Set(['false', 'f', 'no', 'n', '0']);

/** `DECIMAL(8,2)` -> precision 8, scale 2. */
function precisionOf(type: string | undefined): { precision: number; scale: number } | undefined {
  const m = type && /\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)/.exec(type);
  return m ? { precision: Number(m[1]), scale: Number(m[2] ?? 0) } : undefined;
}

/** `VARCHAR(30)` -> 30; only for character types. */
function maxLengthOf(type: string | undefined): number | undefined {
  const m = type && /char/i.test(type) && /\(\s*(\d+)\s*\)/.exec(type);
  return m ? Number(m[1]) : undefined;
}

function validDate(y: number, mo: number, d: number): boolean {
  const date = new Date(Date.UTC(y, mo - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === mo - 1 && date.getUTCDate() === d;
}

/**
 * What a person typed into a cell of `column`, as the value to store. `null` means they chose NULL. The column's kind and
 * constraints decide: they are the driver's, so a `TINYINT(1)` takes true/false and a `NOT NULL` column refuses NULL.
 */
export function parseEditValue(column: Column, input: string | null): EditValue {
  const name = column.name;
  if (input === null) {
    return column.notNull ? { ok: false, error: `${name} cannot be NULL.` } : { ok: true, value: null };
  }
  const text = input.trim();
  const fail = (error: string): EditValue => ({ ok: false, error });

  switch (column.kind) {
    case 'binary':
      return fail('Binary values cannot be edited here.');

    case 'integer': {
      if (!INTEGER.test(text)) return fail(text ? 'Enter a whole number.' : 'Enter a whole number, or set NULL.');
      const n = Number(text);
      return { ok: true, value: Number.isSafeInteger(n) ? n : text.replace(/^\+/, '') }; // too big for a double: stays exact as text
    }

    case 'decimal': {
      if (!DECIMAL.test(text)) return fail(text ? 'Enter a number.' : 'Enter a number, or set NULL.');
      const p = precisionOf(column.type);
      if (p && !/e/i.test(text)) {
        const [whole, fraction = ''] = text.replace(/^[+-]/, '').split('.');
        const digits = whole.replace(/^0+(?=\d)/, '');
        if (fraction.replace(/0+$/, '').length > p.scale) return fail(p.scale === 0 ? 'Enter a whole number: this column has no decimals.' : `At most ${p.scale} decimal places.`);
        if (digits.length > p.precision - p.scale && digits !== '0' && digits !== '') return fail(`At most ${p.precision - p.scale} digits before the decimal point.`);
      }
      const n = Number(text);
      return { ok: true, value: Number.isFinite(n) && text.replace(/\D/g, '').replace(/^0+/, '').length <= 15 ? n : text.replace(/^\+/, '') };
    }

    case 'boolean': {
      const t = text.toLowerCase();
      if (TRUE.has(t)) return { ok: true, value: true };
      if (FALSE.has(t)) return { ok: true, value: false };
      return fail(text ? 'Enter true or false.' : 'Enter true or false, or set NULL.');
    }

    case 'datetime': {
      const m = DATE_TIME.exec(text);
      const t = TIME.exec(text);
      const ok = m
        ? validDate(Number(m[1]), Number(m[2]), Number(m[3])) && (m[4] === undefined || (Number(m[4]) < 24 && Number(m[5]) < 60 && Number(m[6] ?? 0) < 60))
        : !!t && Number(t[1]) < 24 && Number(t[2]) < 60 && Number(t[3] ?? 0) < 60;
      return ok ? { ok: true, value: text } : fail(text ? 'Enter a date or time such as 2026-11-17 or 2026-11-17 09:30:00.' : 'Enter a date or time, or set NULL.');
    }

    case 'json': {
      try {
        JSON.parse(text);
      } catch {
        return fail(text ? 'Enter valid JSON.' : 'Enter valid JSON, or set NULL.');
      }
      return { ok: true, value: text };
    }

    default: {
      const max = maxLengthOf(column.type);
      if (max !== undefined && [...input].length > max) return fail(`At most ${max} characters.`);
      return { ok: true, value: input };
    }
  }
}
