import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SqliteDriverFactory, sqliteDescriptor } from '../src/drivers/sqlite';
import { splitStatements } from '../src/domain/sql/splitter';
import { tokenizerOptions } from '../src/domain/sql/tokenizer';
import { testEnv, tmpDir } from './helpers';

test('the demo workspace: every statement in queries.sql runs against the seeded database', async () => {
  const src = path.join(__dirname, '..', 'examples', 'demo');
  const copy = path.join(tmpDir(), 'demo.db'); // the script writes, so never touch the original
  fs.copyFileSync(path.join(src, 'demo.db'), copy);

  const d = new SqliteDriverFactory().create({ options: { path: copy }, secrets: {} }, testEnv());
  await d.open();
  const statements = splitStatements(fs.readFileSync(path.join(src, 'queries.sql'), 'utf8'), tokenizerOptions(sqliteDescriptor.dialect));
  assert.equal(statements.length, 8);

  const out = [];
  for (const s of statements) out.push(await d.execute(s.text, { maxRows: 1000 }));
  assert.equal(out[0].rows.length, 20);
  assert.ok(out[1].rows.length > 0 && out[1].rows.every((r) => Number(r[2]) < 1960));
  assert.equal(out[2].columns.map((c) => c.name).join(), 'author,books,avg_rating,total_pages');
  assert.equal(out[3].rows[0][0], 300);
  assert.ok(out[7].rows.length > 0, 'the deliberately ugly statement still runs');
  assert.equal(out[5].affectedRows, 1);
  assert.deepEqual(out[6].rows.map((r) => r[2]), ['book added: The Dispossessed (annotated)'], 'the trigger fired');
  await d.close();

  const settings = JSON.parse(fs.readFileSync(path.join(src, '.vscode', 'settings.json'), 'utf8'));
  assert.equal(settings['betterSqlTools.connections'][0].driver, 'sqlite');
});
