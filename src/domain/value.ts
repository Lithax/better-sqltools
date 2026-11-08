import type { Cell } from './model';

const BLOB_PREVIEW_BYTES = 64;

function hex(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

/** Turns whatever a driver returned into something JSON-safe and displayable. */
export function toCell(v: unknown): Cell {
  if (v === null || v === undefined) return null;
  switch (typeof v) {
    case 'string':
    case 'boolean':
      return v;
    case 'number':
      return Number.isFinite(v) ? v : String(v);
    case 'bigint':
      return v.toString();
    case 'object': {
      if (v instanceof Date) return Number.isNaN(v.getTime()) ? 'Invalid Date' : v.toISOString();
      if (v instanceof Uint8Array) {
        return { $blob: hex(v.subarray(0, BLOB_PREVIEW_BYTES)), bytes: v.byteLength };
      }
      try {
        return JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x)) ?? String(v);
      } catch {
        return String(v);
      }
    }
    default:
      return String(v);
  }
}
