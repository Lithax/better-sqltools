// Bundles every extension in this repo: the core, and each driver under drivers/.
import { build, context } from 'esbuild';
import { copyFileSync, mkdirSync } from 'node:fs';

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

const common = {
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

const targets = [
  { entryPoints: ['src/extension.ts'], outfile: 'dist/extension.js' },
  {
    entryPoints: ['drivers/sqlite/src/extension.ts'],
    outfile: 'drivers/sqlite/dist/extension.js',
    // sql.js loads its WASM from next to the bundle
    prepare() {
      mkdirSync('drivers/sqlite/dist', { recursive: true });
      copyFileSync('node_modules/sql.js/dist/sql-wasm.wasm', 'drivers/sqlite/dist/sql-wasm.wasm');
    },
  },
];

for (const { prepare, ...t } of targets) {
  mkdirSync('dist', { recursive: true });
  prepare?.();
  if (watch) {
    const ctx = await context({ ...common, ...t });
    await ctx.watch();
  } else {
    await build({ ...common, ...t });
  }
}
