import type { DialectInfo } from '../driver-descriptor';

export type TokenKind = 'whitespace' | 'comment' | 'string' | 'quoted' | 'word' | 'number' | 'symbol';

export interface Token {
  kind: TokenKind;
  text: string;
  start: number;
  end: number;
}

export interface TokenizerOptions {
  identifierQuote?: { open: string; close: string };
  dollarQuoting?: boolean;
  backslashEscapes?: boolean;
  hashComments?: boolean;
}

export function tokenizerOptions(d?: DialectInfo): TokenizerOptions {
  return {
    identifierQuote: d?.identifierQuote,
    dollarQuoting: d?.dollarQuoting,
    backslashEscapes: d?.backslashEscapes,
    hashComments: d?.hashComments,
  };
}

const isSpace = (c: string) => c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === '\f' || c === '\v';
const isDigit = (c: string) => c >= '0' && c <= '9';
const isWordStart = (c: string) => /[A-Za-z_\u0080-\uffff]/.test(c);

/** Returns the index just past the closing quote (or the end of input if unterminated). */
function scanQuoted(sql: string, from: number, close: string, backslash: boolean): number {
  let i = from + 1;
  while (i < sql.length) {
    const c = sql[i];
    if (backslash && c === '\\') {
      i += 2;
      continue;
    }
    if (c === close) {
      if (sql[i + 1] === close) {
        i += 2; // doubled quote is an escaped quote
        continue;
      }
      return i + 1;
    }
    i++;
  }
  return sql.length;
}

export function tokenize(sql: string, o: TokenizerOptions = {}): Token[] {
  const out: Token[] = [];
  const n = sql.length;
  const idOpen = o.identifierQuote?.open;
  const idClose = o.identifierQuote?.close;
  let i = 0;

  const push = (kind: TokenKind, start: number, end: number) =>
    out.push({ kind, text: sql.slice(start, end), start, end });

  while (i < n) {
    const c = sql[i];
    const start = i;

    if (isSpace(c)) {
      while (i < n && isSpace(sql[i])) i++;
      push('whitespace', start, i);
    } else if ((c === '-' && sql[i + 1] === '-') || (o.hashComments && c === '#')) {
      while (i < n && sql[i] !== '\n') i++;
      push('comment', start, i);
    } else if (c === '/' && sql[i + 1] === '*') {
      i += 2;
      while (i < n && !(sql[i] === '*' && sql[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      push('comment', start, i);
    } else if (c === "'") {
      i = scanQuoted(sql, i, "'", !!o.backslashEscapes);
      push('string', start, i);
    } else if (c === '$' && o.dollarQuoting && /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.test(sql.slice(i, i + 80))) {
      const tag = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 80))![0];
      const close = sql.indexOf(tag, i + tag.length);
      i = close < 0 ? n : close + tag.length;
      push('string', start, i);
    } else if (c === '"' || (idOpen && c === idOpen)) {
      const close = c === '"' && idOpen !== '"' ? '"' : (idClose ?? '"');
      i = scanQuoted(sql, i, close, false);
      push('quoted', start, i);
    } else if (isDigit(c) || (c === '.' && isDigit(sql[i + 1] ?? ''))) {
      i++;
      while (i < n && /[0-9A-Za-z_.]/.test(sql[i])) i++;
      push('number', start, i);
    } else if (isWordStart(c)) {
      i++;
      const re = o.dollarQuoting ? /[A-Za-z0-9_\u0080-\uffff]/ : /[A-Za-z0-9_$\u0080-\uffff]/;
      while (i < n && re.test(sql[i])) i++;
      push('word', start, i);
    } else {
      i++;
      push('symbol', start, i);
    }
  }
  return out;
}
