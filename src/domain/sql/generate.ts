import type { DialectInfo } from '../driver-descriptor';

/** `SELECT` of the first `n` rows, in the dialect's idiom. */
export function selectSample(qualifiedName: string, dialect: DialectInfo, n = 100): string {
  switch (dialect.limit) {
    case 'top':
      return `SELECT TOP ${n} *\nFROM ${qualifiedName};`;
    case 'fetch-first':
      return `SELECT *\nFROM ${qualifiedName}\nFETCH FIRST ${n} ROWS ONLY;`;
    default:
      return `SELECT *\nFROM ${qualifiedName}\nLIMIT ${n};`;
  }
}
