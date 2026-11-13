import type { Catalog, CatalogColumn, Column } from './model';
import { findCatalogTable, inferColumnSources } from './sql/sources';
import type { TokenizerOptions } from './sql/tokenizer';

/** Leaves out the keys that are undefined, so a column that knows nothing extra stays `{ name }`. */
function defined<T extends object>(o: T): Partial<T> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** What the catalog says about a table column, in the shape a result column has. */
function fromCatalog(c: CatalogColumn): Partial<Column> {
  return defined({
    type: c.type,
    kind: c.kind,
    notNull: c.nullable === undefined ? undefined : !c.nullable,
    primaryKey: c.primaryKey || undefined,
    unique: c.unique || undefined,
    autoIncrement: c.autoIncrement || undefined,
    defaultValue: c.defaultValue,
    foreignKey: c.foreignKey,
  });
}

/**
 * Gives result columns the type, kind and constraints of the table columns they are read from.
 *
 * A column the driver already described keeps what the driver said; the catalog fills in the rest. Columns that cannot
 * be traced to a table column (expressions, aggregates, anything the SQL makes unclear) come back untouched.
 */
export function enrichColumns(columns: Column[], sql: string, catalog: Catalog | undefined, options: TokenizerOptions): Column[] {
  if (!catalog || !columns.length) return columns;
  const inferred = columns.some((c) => !c.source) ? inferColumnSources(sql, catalog, options, columns.length) : undefined;
  return columns.map((c, i) => {
    const source = c.source ?? inferred?.[i];
    const table = source && findCatalogTable(catalog, source.schema, source.table);
    const found = table && source && table.columns.find((x) => x.name.toLowerCase() === source.column.toLowerCase());
    if (!table || !found) return c;
    return { ...fromCatalog(found), ...defined(c), source: defined({ schema: table.schema, table: table.name, column: found.name }) } as Column;
  });
}
