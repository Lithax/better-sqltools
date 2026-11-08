// Bundles the extension into a single file and copies the sql.js WASM next to it.
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const options = {
  entryPoints: ['src/extension.ts'],
  outfile: 'dist/extension.js',
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node18',
  external: ['vscode'],
  sourcemap: !production,
  minify: production,
  keepNames: true, // readable class names in logs and stack traces, even minified
  logLevel: 'info',
};

mkdirSync('dist', { recursive: true });
copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'dist/sql-wasm.wasm');

if (watch) {
  const ctx = await context(options);
  await ctx.watch();
} else {
  await build(options);
}
