/** Collapses all whitespace to single spaces and cuts the text to `max` characters, ending with an ellipsis when it was cut. */
export function oneLine(text: string, max: number): string {
  const t = text.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, Math.max(0, max - 1))}…` : t;
}
