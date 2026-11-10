/** Case-insensitive name filter: plain text matches anywhere in the name; `*` and `?` make it a whole-name wildcard. */
export function matchesFilter(label: string, pattern: string): boolean {
  const p = pattern.trim().toLowerCase();
  if (!p) return true;
  const name = label.toLowerCase();
  if (!/[*?]/.test(p)) return name.includes(p);
  const re = p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${re}$`).test(name);
}
