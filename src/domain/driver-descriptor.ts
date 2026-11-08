/**
 * Static, serialisable metadata a driver publishes about itself. The UI renders
 * connection forms purely from `connectionSchema`, so a driver never ships UI code.
 */

export type FieldType = 'string' | 'password' | 'number' | 'boolean' | 'select' | 'file';

export interface ConnectionField {
  key: string;
  label: string;
  type: FieldType;
  description?: string;
  /**
   * For non-password fields: must have a value. For `password` fields: the user is
   * prompted at connect time when no secret is stored (pressing Enter sends an empty one).
   */
  required?: boolean;
  default?: string | number | boolean;
  placeholder?: string;
  /** Choices for `select`. */
  options?: { value: string; label: string }[];
  min?: number;
  max?: number;
}

export interface DialectInfo {
  /** sqlfluff dialect id ("ansi", "postgres", "mysql", "sqlite", "tsql", ...). */
  sqlfluff?: string;
  identifierQuote: { open: string; close: string };
  /** `$$ body $$` and `$tag$ body $tag$` literals (PostgreSQL family). */
  dollarQuoting?: boolean;
  /** `\'` escapes inside string literals (MySQL family). */
  backslashEscapes?: boolean;
  /** `#` starts a line comment (MySQL family). */
  hashComments?: boolean;
  /** How to cap a result set when generating `SELECT` statements. */
  limit: 'limit' | 'top' | 'fetch-first';
  /** Extra keywords / functions offered by completion, on top of ANSI. */
  keywords?: string[];
  functions?: string[];
}

export interface DriverCapabilities {
  /** Implements `Driver.ddl`. */
  ddl?: boolean;
  /** Honours the AbortSignal while a statement is running. */
  cancel?: boolean;
  /** Implements the bulk `Driver.catalog` (much faster completion than walking the tree). */
  catalog?: boolean;
  /** Has more than one schema/database to browse. */
  schemas?: boolean;
}

export interface DriverDescriptor {
  /** Stable id, e.g. "sqlite", "postgres", "acme.snowflake". */
  id: string;
  displayName: string;
  description?: string;
  version?: string;
  /** A codicon name without the `$()` wrapper. */
  icon?: string;
  homepage?: string;
  dialect: DialectInfo;
  capabilities: DriverCapabilities;
  connectionSchema: ConnectionField[];
}
