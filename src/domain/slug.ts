/** A short, stable, non-cryptographic hash (FNV-1a) for keeping ids apart, e.g. of two projects. */
export function shortHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0').slice(0, 6);
}

/** "My DB (dev)" becomes "my-db-dev". Input with no usable characters gives `fallback`. */
export const slugify = (s: string, fallback = 'item'): string =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || fallback;
