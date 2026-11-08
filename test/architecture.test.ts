import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';

/** The dependency rule, enforced: imports only point inward. */
const SRC = path.join(__dirname, '..', 'src');

function files(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : [],
  );
}

function imports(file: string): string[] {
  const src = fs.readFileSync(file, 'utf8');
  return [...src.matchAll(/(?:import|export)\s[^'"]*?from\s+['"]([^'"]+)['"]|import\(['"]([^'"]+)['"]\)|require\(['"]([^'"]+)['"]\)/g)].map(
    (m) => m[1] ?? m[2] ?? m[3],
  );
}

function resolveLayer(from: string, spec: string): string | undefined {
  if (!spec.startsWith('.')) return undefined;
  const rel = path.relative(SRC, path.resolve(path.dirname(from), spec));
  return rel.split(path.sep)[0];
}

const rules: Record<string, { allowedLayers: string[]; allowBare: (spec: string) => boolean }> = {
  domain: { allowedLayers: ['domain'], allowBare: () => false },
  application: { allowedLayers: ['domain', 'application'], allowBare: () => false },
  drivers: { allowedLayers: ['domain', 'application', 'drivers'], allowBare: (s) => s.startsWith('node:') || s === 'sql.js' },
};

for (const [layer, rule] of Object.entries(rules)) {
  test(`${layer}/ only depends on ${rule.allowedLayers.join(', ')}`, () => {
    const offenders: string[] = [];
    for (const f of files(path.join(SRC, layer))) {
      for (const spec of imports(f)) {
        const target = resolveLayer(f, spec);
        const ok = target === undefined ? rule.allowBare(spec) : rule.allowedLayers.includes(target);
        if (!ok) offenders.push(`${path.relative(SRC, f)} → ${spec}`);
      }
    }
    assert.deepEqual(offenders, []);
  });
}
