import { tokenize, type Token, type TokenizerOptions } from './tokenizer';

export interface SqlStatement {
  /** Executable text: trimmed, without the terminating semicolon. */
  text: string;
  /** Offset of the first significant character. */
  start: number;
  /** Offset just past the last significant character (the `;` excluded). */
  end: number;
  /** Offset just past the `;` (equals `end` when the statement is unterminated). */
  fullEnd: number;
  terminated: boolean;
}

// `CREATE ... TRIGGER|PROCEDURE|FUNCTION|EVENT` bodies contain `;` inside BEGIN..END.
const BLOCK_KINDS = new Set(['TRIGGER', 'PROCEDURE', 'FUNCTION', 'EVENT']);
const PLAIN_KINDS = new Set([
  'TABLE', 'VIEW', 'INDEX', 'DATABASE', 'SCHEMA', 'SEQUENCE', 'TYPE', 'DOMAIN',
  'EXTENSION', 'ROLE', 'USER', 'MATERIALIZED', 'VIRTUAL',
]);
// `END IF`, `END LOOP`... close constructs we never counted as blocks.
const END_MODIFIERS = new Set(['IF', 'LOOP', 'WHILE', 'REPEAT', 'FOR']);

const isTrivia = (t: Token) => t.kind === 'whitespace' || t.kind === 'comment';

function nextWord(tokens: Token[], from: number): string | undefined {
  for (let i = from + 1; i < tokens.length; i++) {
    if (isTrivia(tokens[i])) continue;
    return tokens[i].kind === 'word' ? tokens[i].text.toUpperCase() : undefined;
  }
  return undefined;
}

/** Splits a script into statements, aware of strings, comments, quoted identifiers and routine bodies. */
export function splitStatements(sql: string, opts: TokenizerOptions = {}): SqlStatement[] {
  const tokens = tokenize(sql, opts);
  const out: SqlStatement[] = [];
  let first = -1;
  let last = -1;
  let words: string[] = [];
  let block = false;
  let depth = 0;
  let skipCase = false;

  const flush = (semi?: Token) => {
    if (first >= 0) {
      const start = tokens[first].start;
      const end = tokens[last].end;
      out.push({ text: sql.slice(start, end), start, end, fullEnd: semi ? semi.end : end, terminated: !!semi });
    }
    first = last = -1;
    words = [];
    block = false;
    depth = 0;
    skipCase = false;
  };

  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (isTrivia(t)) continue;

    if (t.kind === 'symbol' && t.text === ';') {
      if (block && depth > 0) {
        last = i; // a `;` inside a routine body belongs to the statement
        continue;
      }
      flush(t);
      continue;
    }

    if (first < 0) first = i;
    last = i;
    if (t.kind !== 'word') continue;

    const w = t.text.toUpperCase();
    if (!block && words.length < 12) {
      words.push(w);
      if (words[0] === 'CREATE') {
        const kind = words.slice(1).find((x) => BLOCK_KINDS.has(x) || PLAIN_KINDS.has(x));
        block = kind !== undefined && BLOCK_KINDS.has(kind);
      }
    }
    if (!block) continue;

    if (skipCase && w === 'CASE') {
      skipCase = false;
    } else {
      skipCase = false;
      if (w === 'BEGIN' || w === 'CASE') {
        depth++;
      } else if (w === 'END') {
        const next = nextWord(tokens, i);
        if (!(next && END_MODIFIERS.has(next))) {
          depth = Math.max(0, depth - 1);
          if (next === 'CASE') skipCase = true;
        }
      }
    }
  }
  flush();
  return out;
}

/**
 * The statement a cursor "belongs to": the one containing it, otherwise the closest
 * one before it, otherwise the first one after it.
 */
export function statementAt(statements: SqlStatement[], offset: number): SqlStatement | undefined {
  let before: SqlStatement | undefined;
  for (const s of statements) {
    if (offset >= s.start && offset <= s.fullEnd) return s;
    if (s.fullEnd < offset) before = s;
    else return before ?? s;
  }
  return before;
}
