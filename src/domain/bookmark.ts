import { oneLine } from './text';

export const UNTITLED_BOOKMARK = 'Untitled query';

/**
 * A name for a bookmark taken from its SQL: the first line that is not a comment, on one line.
 * Only a suggestion; the user can type another one.
 */
export function suggestBookmarkName(sql: string, max = 60): string {
  const withoutComments = sql.replace(/\/\*[\s\S]*?\*\//g, '').replace(/--[^\n]*/g, '');
  const first = withoutComments.split(/\r?\n/).find((l) => l.trim());
  return first ? oneLine(first, max) : UNTITLED_BOOKMARK;
}
