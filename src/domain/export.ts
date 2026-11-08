import type { Cell, Column } from './model';

export function cellToText(c: Cell): string {
  if (c === null) return '';
  if (typeof c === 'object') return '0x' + c.$blob + (c.$blob.length / 2 < c.bytes ? '…' : '');
  return String(c);
}

export function toCsv(columns: Column[], rows: Cell[][]): string {
  const esc = (s: string) => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
  const lines = [columns.map((c) => esc(c.name)).join(',')];
  for (const r of rows) lines.push(r.map((c) => esc(cellToText(c))).join(','));
  return lines.join('\r\n') + '\r\n';
}

export function toTsv(columns: Column[], rows: Cell[][]): string {
  const clean = (s: string) => s.replace(/[\t\r\n]+/g, ' ');
  const lines = [columns.map((c) => clean(c.name)).join('\t')];
  for (const r of rows) lines.push(r.map((c) => clean(cellToText(c))).join('\t'));
  return lines.join('\n');
}

/** An array of objects. Duplicate column names get a numeric suffix instead of overwriting. */
export function toJson(columns: Column[], rows: Cell[][]): string {
  const seen = new Map<string, number>();
  const keys = columns.map((c) => {
    const n = (seen.get(c.name) ?? 0) + 1;
    seen.set(c.name, n);
    return n === 1 ? c.name : `${c.name}_${n}`;
  });
  const objs = rows.map((r) => {
    const o: Record<string, unknown> = {};
    r.forEach((c, i) => {
      o[keys[i]] = c !== null && typeof c === 'object' ? cellToText(c) : c;
    });
    return o;
  });
  return JSON.stringify(objs, null, 2);
}
