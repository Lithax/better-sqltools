import { spawn } from 'node:child_process';
import type { LintRequest, Linter } from '../../application/ports';
import { LinterUnavailableError } from '../../domain/errors';
import type { LintIssue } from '../../domain/model';

export interface SqlfluffOptions {
  /** Executable, e.g. "sqlfluff" or an absolute path into a virtualenv. */
  command: string;
  /** Extra arguments appended after the subcommand (they can override ours, e.g. --config). */
  args: string[];
  timeoutMs: number;
}

export interface ProcResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runProcess(
  command: string,
  args: string[],
  o: { input: string; cwd?: string; timeoutMs: number; signal?: AbortSignal },
): Promise<ProcResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: o.cwd, signal: o.signal, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer =
      o.timeoutMs > 0
        ? setTimeout(() => {
            child.kill();
            done(() => reject(new Error(`sqlfluff did not finish within ${o.timeoutMs} ms.`)));
          }, o.timeoutMs)
        : undefined;

    child.stdout.setEncoding('utf8').on('data', (d: string) => (stdout += d));
    child.stderr.setEncoding('utf8').on('data', (d: string) => (stderr += d));
    child.on('error', (e: NodeJS.ErrnoException) =>
      done(() =>
        reject(
          e.code === 'ENOENT'
            ? new LinterUnavailableError(
                'sqlfluff',
                `"${command}" was not found. Install it with "pip install sqlfluff", or point betterSqlTools.lint.sqlfluffPath at it.`,
              )
            : e,
        ),
      ),
    );
    child.on('close', (code) => done(() => resolve({ code, stdout, stderr })));
    child.stdin.on('error', () => undefined); // EPIPE when the process dies before reading
    child.stdin.end(o.input);
  });
}

const firstLine = (s: string) => s.split(/\r?\n/).find((l) => l.trim())?.trim() ?? '';

/** Turns `sqlfluff lint --format json` output into issues. */
export function parseSqlfluffLint(stdout: string): LintIssue[] {
  const start = stdout.search(/\[\s*[{\]]/);
  let data: unknown;
  try {
    data = JSON.parse(start >= 0 ? stdout.slice(start) : stdout);
  } catch {
    throw new Error('Could not read sqlfluff output (is it a very old or very new version?).');
  }
  const issues: LintIssue[] = [];
  for (const file of Array.isArray(data) ? data : []) {
    for (const v of file?.violations ?? []) {
      const code = String(v.code ?? '');
      const hard = code === 'PRS' || code === 'LXR' || code === 'TMP';
      issues.push({
        line: Number(v.start_line_no ?? v.line_no ?? 1),
        column: Number(v.start_line_pos ?? v.line_pos ?? 1),
        endLine: v.end_line_no === undefined ? undefined : Number(v.end_line_no),
        endColumn: v.end_line_pos === undefined ? undefined : Number(v.end_line_pos),
        code,
        message: String(v.description ?? v.message ?? ''),
        rule: v.name ? String(v.name) : undefined,
        severity: hard ? 'error' : v.warning ? 'info' : 'warning',
        fixable: Array.isArray(v.fixes) && v.fixes.length > 0,
      });
    }
  }
  return issues;
}

/** Linter adapter around the sqlfluff command line. Everything goes through stdin. */
export class SqlfluffLinter implements Linter {
  constructor(private readonly options: () => SqlfluffOptions) {}

  async lint(req: LintRequest): Promise<LintIssue[]> {
    const r = await this.exec('lint', ['--format', 'json'], req);
    return parseSqlfluffLint(r.stdout);
  }

  async fix(req: LintRequest): Promise<string> {
    return this.rewrite('fix', req);
  }

  async format(req: LintRequest): Promise<string> {
    return this.rewrite('format', req);
  }

  private async rewrite(cmd: 'fix' | 'format', req: LintRequest): Promise<string> {
    const r = await this.exec(cmd, [], req);
    // Unparsable input comes back unchanged with exit code 1: that is fine, there is just nothing to apply.
    if (!r.stdout.trim() && req.text.trim()) throw new Error('sqlfluff returned no output; the document was left alone.');
    return r.stdout;
  }

  private async exec(sub: 'lint' | 'fix' | 'format', extra: string[], req: LintRequest): Promise<ProcResult> {
    const o = this.options();
    const args = [sub, ...extra, '--dialect', req.dialect, ...o.args, '-'];
    const r = await runProcess(o.command, args, { input: req.text, cwd: req.cwd, timeoutMs: o.timeoutMs, signal: req.signal });
    if (r.code !== 0 && r.code !== 1) {
      throw new Error(firstLine(r.stderr) || firstLine(r.stdout) || `sqlfluff exited with code ${r.code}.`);
    }
    return r;
  }
}
