import type { ColumnKind } from '../../../src/api';

/**
 * What a declared SQLite type means for the values in it.
 *
 * SQLite has no real column types, only storage classes and an "affinity" derived from the declared name by substring
 * rules (https://www.sqlite.org/datatype3.html#determination_of_column_affinity). This follows those rules and also
 * knows the names people use for things SQLite stores as numbers or text: BOOLEAN, DATE, DATETIME, JSON.
 * A column declared without a type can hold anything, so it has no kind.
 */
export function sqliteKind(type: string | undefined): ColumnKind | undefined {
  if (!type?.trim()) return undefined;
  const t = type.toUpperCase();
  if (t.includes('BOOL')) return 'boolean';
  if (t.includes('JSON')) return 'json';
  if (t.includes('DATE') || t.includes('TIME')) return 'datetime';
  if (t.includes('INT')) return 'integer';
  if (/CHAR|CLOB|TEXT/.test(t)) return 'text';
  if (t.includes('BLOB')) return 'binary';
  if (/REAL|FLOA|DOUB|DEC|NUM/.test(t)) return 'decimal';
  return 'other';
}
