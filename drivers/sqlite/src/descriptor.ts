import type { DriverDescriptor } from '../../../src/api';

export const sqliteDescriptor: DriverDescriptor = {
  id: 'sqlite',
  displayName: 'SQLite',
  description: 'SQLite through sql.js (WebAssembly). Pure JavaScript, nothing native to install.',
  icon: 'media/sqlite.svg',
  homepage: 'https://sql.js.org',
  dialect: {
    sqlfluff: 'sqlite',
    identifierQuote: { open: '"', close: '"' },
    limit: 'limit',
    keywords: [
      'PRAGMA', 'VACUUM', 'ATTACH DATABASE', 'DETACH DATABASE', 'AUTOINCREMENT', 'WITHOUT ROWID', 'GLOB',
      'REINDEX', 'ANALYZE', 'INSERT OR REPLACE INTO', 'INSERT OR IGNORE INTO', 'ON CONFLICT', 'STRICT',
    ],
    functions: [
      'ifnull', 'typeof', 'group_concat', 'printf', 'strftime', 'julianday', 'datetime', 'date', 'time',
      'random', 'randomblob', 'hex', 'quote', 'instr', 'json_extract', 'json_array', 'json_object', 'total_changes',
    ],
  },
  capabilities: { ddl: true, catalog: true, cancel: false, schemas: false },
  connectionSchema: [
    {
      key: 'path',
      label: 'Database file',
      type: 'file',
      required: true,
      placeholder: '${workspaceFolder}/app.db   or   :memory:',
      description: 'Path to the database file. Use :memory: for a throwaway in-memory database.',
    },
    { key: 'readOnly', label: 'Open read-only', type: 'boolean', default: false },
    { key: 'createIfMissing', label: 'Create the file if it does not exist', type: 'boolean', default: true },
    { key: 'foreignKeys', label: 'Enforce foreign keys', type: 'boolean', default: true },
  ],
};
