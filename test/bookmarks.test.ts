import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BookmarkService } from '../src/application/bookmark-service';
import { suggestBookmarkName, UNTITLED_BOOKMARK } from '../src/domain/bookmark';
import { oneLine } from '../src/domain/text';
import { MemoryBookmarks } from './fakes';

test('oneLine: collapses whitespace and cuts to the limit with an ellipsis', () => {
  assert.equal(oneLine('select  *\n  from\tbooks', 100), 'select * from books');
  assert.equal(oneLine('  padded  ', 100), 'padded');
  assert.equal(oneLine('abcdefghij', 10), 'abcdefghij', 'exactly the limit is not cut');
  assert.equal(oneLine('abcdefghijk', 10), 'abcdefghi…', 'the ellipsis counts towards the limit');
  assert.equal(oneLine('', 10), '');
  assert.equal(oneLine('abc', 0), '…', 'a limit of zero cannot show anything');
});

test('suggestBookmarkName: the first line that is not a comment, on one line', () => {
  assert.equal(suggestBookmarkName('select * from books'), 'select * from books');
  assert.equal(suggestBookmarkName('-- the big one\nselect 1'), 'select 1');
  assert.equal(suggestBookmarkName('/* header\n   spanning lines */\n\n  select 2  \nfrom t'), 'select 2');
  assert.equal(suggestBookmarkName('select 3 -- trailing comment'), 'select 3');
  assert.equal(suggestBookmarkName('select ' + 'x'.repeat(100), 20), 'select xxxxxxxxxxxx…');
  assert.equal(suggestBookmarkName('-- only a comment'), UNTITLED_BOOKMARK);
  assert.equal(suggestBookmarkName('   \n  '), UNTITLED_BOOKMARK);
});

function service() {
  const repo = new MemoryBookmarks();
  let clock = 1000;
  return { repo, svc: new BookmarkService(repo, () => clock++) };
}

test('BookmarkService.add: trims the SQL, names it from the SQL unless told otherwise, remembers the connection', async () => {
  const { svc, repo } = service();
  const a = await svc.add({ sql: '\n  select * from books;  \n', connectionId: 'lib' });
  assert.equal(a.sql, 'select * from books;');
  assert.equal(a.name, 'select * from books;');
  assert.equal(a.connectionId, 'lib');
  assert.equal(a.createdAt, 1000);

  const b = await svc.add({ sql: 'select 2', name: '  Two  ' });
  assert.equal(b.name, 'Two');
  assert.equal('connectionId' in b, false, 'no connection key rather than undefined, so it stores cleanly');
  const blank = await svc.add({ sql: 'select 3', name: '   ' });
  assert.equal(blank.name, 'select 3', 'a blank name falls back to the suggestion');
  assert.notEqual(a.id, b.id);
  assert.equal(repo.items.length, 3);

  await assert.rejects(svc.add({ sql: '  \n ' }), /nothing to bookmark/);
  assert.equal(repo.items.length, 3, 'a rejected bookmark is not stored');
});

test('BookmarkService.list: by name ignoring case, then oldest first', async () => {
  const { svc } = service();
  await svc.add({ sql: 'select 1', name: 'beta' });
  await svc.add({ sql: 'select 2', name: 'Alpha' });
  await svc.add({ sql: 'select 3', name: 'alpha' });
  await svc.add({ sql: 'select 4', name: 'Beta' });
  assert.deepEqual(svc.list().map((b) => b.sql), ['select 2', 'select 3', 'select 1', 'select 4']);
});

test('BookmarkService: rename, remove and clear, with the rules a bookmark must obey', async () => {
  const { svc, repo } = service();
  const a = await svc.add({ sql: 'select 1', name: 'one' });
  const b = await svc.add({ sql: 'select 2', name: 'two' });

  await svc.rename(a.id, '  uno ');
  assert.equal(svc.get(a.id)!.name, 'uno');
  assert.equal(svc.get(a.id)!.sql, 'select 1', 'renaming keeps everything else');
  await assert.rejects(svc.rename(a.id, '  '), /needs a name/);
  await assert.rejects(svc.rename('nope', 'x'), /no longer exists/);
  assert.equal(svc.get(a.id)!.name, 'uno', 'a rejected rename changes nothing');

  await svc.remove('nope');
  assert.equal(repo.items.length, 2, 'removing what is not there is not an error');
  await svc.remove(a.id);
  assert.deepEqual(svc.list().map((x) => x.id), [b.id]);
  await svc.clear();
  assert.deepEqual(svc.list(), []);
});

test('BookmarkService: tells listeners about every change', async () => {
  const { svc } = service();
  let n = 0;
  svc.onDidChange(() => n++);
  const a = await svc.add({ sql: 'select 1' });
  await svc.rename(a.id, 'one');
  await svc.remove(a.id);
  await svc.remove(a.id); // already gone: no save, no event
  assert.equal(n, 3);
});
