import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { DriverEnvironment, Logger } from '../src/application/ports';

export const silentLogger: Logger = { debug() {}, info() {}, warn() {}, error() {} };

export function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bst-'));
}

export const testEnv = (cwd = process.cwd()): DriverEnvironment => ({
  logger: silentLogger,
  resolvePath: (p) => (path.isAbsolute(p) ? p : path.join(cwd, p)),
});
