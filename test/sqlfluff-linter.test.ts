import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { SqlfluffLinter, parseSqlfluffLint, runProcess } from '../src/adapters/sqlfluff/sqlfluff-linter';
import { LinterUnavailableError } from '../src/domain/errors';
import { tmpDir } from './helpers';

const installed = spawnSync('sqlfluff', ['--version']).status === 0;
const real = new SqlfluffLinter(() => ({ command: 'sqlfluff', args: [], timeoutMs: 30_000 }));

test('parseSqlfluffLint maps violations (shape recorded from sqlfluff 4.x)', () => {
  const sample = JSON.stringify([
    {
      filepath: 'stdin',
      violations: [
        { start_line_no: 1, start_line_pos: 10, end_line_no: 1, end_line_pos: 11, code: 'LT01', description: 'Spacing.', name: 'layout.spacing', warning: false, fixes: [{ type: 'create_after' }] },
        { start_line_no: 2, start_line_pos: 1, code: 'PRS', description: 'Found unparsable section', name: '', warning: false },
        { start_line_no: 3, start_line_pos: 4, code: 'AL01', description: 'Alias.', name: 'aliasing.table', warning: true, fixes: [] },
      ],
      statistics: {},
      timings: {},
    },
  ]);
  const [a, b, c] = parseSqlfluffLint(sample);
  assert.deepEqual(a, { line: 1, column: 10, endLine: 1, endColumn: 11, code: 'LT01', message: 'Spacing.', rule: 'layout.spacing', severity: 'warning', fixable: true });
  assert.equal(b.severity, 'error');
  assert.equal(b.rule, undefined);
  assert.equal(b.fixable, false);
  assert.equal(b.endLine, undefined);
  assert.equal(c.severity, 'info');
});

test('parseSqlfluffLint tolerates old field names, empty output and leading noise', () => {
  assert.equal(parseSqlfluffLint('[{"filepath":"stdin","violations":[{"line_no":4,"line_pos":2,"code":"L010","description":"x"}]}]')[0].line, 4);
  assert.deepEqual(parseSqlfluffLint('[]'), []);
  assert.equal(parseSqlfluffLint('some warning\n[{"filepath":"stdin","violations":[]}]').length, 0);
  assert.throws(() => parseSqlfluffLint('definitely not json'), /Could not read sqlfluff output/);
});

test('a missing executable becomes LinterUnavailableError with install advice', async () => {
  const l = new SqlfluffLinter(() => ({ command: 'definitely-not-sqlfluff-xyz', args: [], timeoutMs: 5000 }));
  await assert.rejects(() => l.lint({ text: 'select 1', dialect: 'ansi' }), (e: Error) => {
    assert.ok(e instanceof LinterUnavailableError);
    assert.match(e.message, /pip install sqlfluff/);
    return true;
  });
});

test('runProcess: stdin round-trip, timeout and abort', async () => {
  const echo = await runProcess(process.execPath, ['-e', 'process.stdin.pipe(process.stdout)'], { input: 'héllo', timeoutMs: 5000 });
  assert.equal(echo.stdout, 'héllo');
  assert.equal(echo.code, 0);

  const hang = ['-e', 'setTimeout(() => {}, 10000)'];
  await assert.rejects(() => runProcess(process.execPath, hang, { input: '', timeoutMs: 150 }), /did not finish within 150 ms/);

  const ac = new AbortController();
  const p = runProcess(process.execPath, hang, { input: '', timeoutMs: 0, signal: ac.signal });
  setTimeout(() => ac.abort(), 50);
  await assert.rejects(p, (e: Error) => e.name === 'AbortError');
});

test('exit codes other than 0/1 surface sqlfluff’s own message', { skip: !installed }, async () => {
  await assert.rejects(() => real.lint({ text: 'select 1', dialect: 'nope' }), /Unknown dialect/);
});

test('real sqlfluff: lint reports fixable layout issues with positions', { skip: !installed }, async () => {
  const issues = await real.lint({ text: 'SELECT a,b FROM t WHERE x=1\n', dialect: 'sqlite' });
  assert.ok(issues.length >= 3);
  assert.ok(issues.every((i) => i.line === 1 && i.column >= 1 && i.code && i.message));
  assert.ok(issues.some((i) => i.code === 'LT01' && i.fixable));
  assert.deepEqual(await real.lint({ text: 'SELECT a FROM t;\n', dialect: 'sqlite' }), []);
});

test('real sqlfluff: parse errors are errors', { skip: !installed }, async () => {
  const issues = await real.lint({ text: 'SELEC 1 FRM\n', dialect: 'sqlite' });
  assert.equal(issues[0].code, 'PRS');
  assert.equal(issues[0].severity, 'error');
});

test('real sqlfluff: fix and format rewrite; unparsable input is returned unchanged', { skip: !installed }, async () => {
  assert.equal(await real.fix({ text: 'SELECT a,b FROM t WHERE x=1', dialect: 'sqlite' }), 'SELECT\n    a,\n    b\nFROM t\nWHERE x = 1\n');
  assert.equal(await real.format({ text: 'select a,b from t', dialect: 'sqlite' }), 'select\n    a,\n    b\nfrom t\n');
  assert.equal(await real.fix({ text: 'SELEC 1 FRM\n', dialect: 'sqlite' }), 'SELEC 1 FRM\n');
});

test('real sqlfluff: .sqlfluff in cwd is honoured, and user args can override ours', { skip: !installed }, async () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '.sqlfluff'), '[sqlfluff]\nexclude_rules = LT01,LT09,LT14,CP01\n');
  assert.deepEqual(await real.lint({ text: 'SELECT a,b FROM t WHERE x=1;\n', dialect: 'sqlite', cwd: dir }), []);

  const noisy = new SqlfluffLinter(() => ({ command: 'sqlfluff', args: ['--dialect', 'ansi'], timeoutMs: 30_000 }));
  assert.ok((await noisy.lint({ text: 'SELECT a,b FROM t\n', dialect: 'sqlite' })).length > 0);
});
