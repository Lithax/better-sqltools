/** Driver extensions declare themselves in package.json so the core can list and icon them before they load. */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { test } from 'node:test';
import { sqliteDescriptor } from '../drivers/sqlite/src';

const root = path.join(__dirname, '..');
const core = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const coreId = `${core.publisher}.${core.name}`;
const driverDirs = fs.readdirSync(path.join(root, 'drivers')).filter((d) => fs.existsSync(path.join(root, 'drivers', d, 'package.json')));

test('there is at least one driver extension in the repository', () => {
  assert.ok(driverDirs.includes('sqlite'));
});

for (const dir of driverDirs) {
  const base = path.join(root, 'drivers', dir);
  const pkg = JSON.parse(fs.readFileSync(path.join(base, 'package.json'), 'utf8'));

  test(`drivers/${dir}: package.json is a well-formed driver extension`, () => {
    assert.ok(pkg.keywords.includes('better-sqltools-driver'), 'tagged so "Find Drivers" can list it');
    assert.ok(pkg.extensionDependencies.includes(coreId), 'depends on the core extension');
    assert.equal(pkg.main, './dist/extension.js');
    assert.equal(pkg.engines.vscode, core.engines.vscode, 'same VS Code floor as the core');
    assert.ok(fs.existsSync(path.join(base, pkg.icon)), 'extension icon exists');
    assert.ok(fs.existsSync(path.join(base, '.vscodeignore')));
    const drivers = pkg.betterSqlTools?.drivers;
    assert.ok(Array.isArray(drivers) && drivers.length > 0, 'declares its drivers');
    for (const d of drivers) {
      assert.ok(d.id && d.name, 'id and name');
      const icons = typeof d.icon === 'string' ? [d.icon] : d.icon ? [d.icon.light, d.icon.dark] : [];
      for (const i of icons) assert.ok(fs.existsSync(path.join(base, i)), `icon ${i} exists`);
    }
  });
}

test('the SQLite manifest agrees with what the driver registers', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'drivers', 'sqlite', 'package.json'), 'utf8'));
  const [entry] = pkg.betterSqlTools.drivers;
  assert.equal(entry.id, sqliteDescriptor.id);
  assert.equal(entry.name, sqliteDescriptor.displayName);
  assert.equal(entry.icon, sqliteDescriptor.icon);
});
