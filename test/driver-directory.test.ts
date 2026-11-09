import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DriverDirectory } from '../src/application/driver-directory';
import { DriverRegistry } from '../src/application/driver-registry';
import { Emitter } from '../src/application/events';
import type { DriverExtensionHost, InstalledDriver } from '../src/application/ports';
import { DriverNotFoundError } from '../src/domain/errors';
import { fakeFactory } from './fakes';
import { silentLogger } from './helpers';

class FakeHost implements DriverExtensionHost {
  installed: InstalledDriver[] = [];
  activations: string[] = [];
  /** What an extension does when it is activated. */
  behaviour = new Map<string, () => void | Promise<void>>();
  private em = new Emitter<void>();
  onDidChange = this.em.event;
  list() { return [...this.installed]; }
  async activate(extensionId: string) {
    this.activations.push(extensionId);
    await this.behaviour.get(extensionId)?.();
  }
  /** Installing at runtime: VS Code announces it. */
  install(d: InstalledDriver) {
    this.installed.push(d);
    this.em.fire();
  }
}

const tick = (ms = 10) => new Promise((r) => setTimeout(r, ms));
const state = () => ({ opened: 0, closed: 0, executed: [] as string[], openDelayMs: 0 });
const installed = (over: Partial<InstalledDriver> = {}): InstalledDriver => ({ id: 'fake', name: 'Fake DB', extensionId: 'acme.fake', ...over });

function setup() {
  const registry = new DriverRegistry();
  const host = new FakeHost();
  const directory = new DriverDirectory(registry, host, silentLogger);
  return { registry, host, directory };
}

test('an installed driver is listed before it loads and is ready once it registers', () => {
  const { registry, host, directory } = setup();
  host.installed.push(installed({ icon: 'media/fake.svg', baseUri: 'file:///ext/fake', version: '1.2.3' }));
  assert.deepEqual(
    directory.list().map((d) => [d.id, d.state, d.displayName, d.icon, d.iconBase, d.descriptor]),
    [['fake', 'inactive', 'Fake DB', 'media/fake.svg', 'file:///ext/fake', undefined]],
  );

  const reg = registry.register(fakeFactory(state()));
  const [entry] = directory.list();
  assert.equal(entry.state, 'ready');
  assert.equal(entry.descriptor?.id, 'fake');
  assert.equal(entry.icon, 'media/fake.svg', 'the manifest icon is used when the descriptor has none');
  assert.equal(entry.version, '1.2.3');
  assert.equal(entry.extensionId, 'acme.fake');
  reg.dispose();
  assert.equal(directory.list()[0].state, 'inactive');
});

test('drivers registered without a manifest still show up', () => {
  const { registry, directory } = setup();
  registry.register(fakeFactory(state()));
  assert.deepEqual(directory.list().map((d) => [d.id, d.state, d.extensionId]), [['fake', 'ready', undefined]]);
});

test('ensure() wakes the extension that provides a driver, once', async () => {
  const { registry, host } = setup();
  host.installed.push(installed()); // present from the start: nobody announced it
  host.behaviour.set('acme.fake', () => void registry.register(fakeFactory(state())));
  assert.equal((await registry.ensure('fake')).descriptor.id, 'fake');
  await registry.ensure('fake');
  assert.deepEqual(host.activations, ['acme.fake']);
});

test('a driver installed while the editor runs is woken without being asked', async () => {
  const { registry, host, directory } = setup();
  host.behaviour.set('acme.fake', () => void registry.register(fakeFactory(state())));
  host.install(installed());
  await tick();
  assert.equal(registry.get('fake')?.descriptor.id, 'fake');
  assert.deepEqual(directory.list().map((d) => d.state), ['ready']);
  assert.deepEqual(host.activations, ['acme.fake']);
});

test('ensure() waits for a driver that registers just after activate() returned', async () => {
  const { registry, host } = setup();
  host.installed.push(installed());
  host.behaviour.set('acme.fake', () => void setTimeout(() => registry.register(fakeFactory(state())), 20));
  assert.equal((await registry.ensure('fake', 1000)).descriptor.id, 'fake');
});

test('ensure() says why a driver cannot be used', async () => {
  const { registry, host, directory } = setup();
  await assert.rejects(registry.ensure('nope'), (e: unknown) => e instanceof DriverNotFoundError && /not installed/.test(e.message));

  host.installed.push(installed());
  host.behaviour.set('acme.fake', () => { throw new Error('boom'); });
  await assert.rejects(registry.ensure('fake'), /failed to load: boom/);
  assert.deepEqual(directory.list().map((d) => [d.state, d.error]), [['failed', 'boom']]);

  host.installed.push(installed({ id: 'ghost', extensionId: 'acme.ghost' }));
  await assert.rejects(registry.ensure('ghost', 30), /never registered/);
});

test('a failed driver extension is tried again on the next request', async () => {
  const { registry, host, directory } = setup();
  host.installed.push(installed());
  let broken = true;
  host.behaviour.set('acme.fake', () => {
    if (broken) throw new Error('not yet');
    registry.register(fakeFactory(state()));
  });
  await assert.rejects(registry.ensure('fake'), /not yet/);
  broken = false;
  assert.equal((await registry.ensure('fake')).descriptor.id, 'fake');
  assert.deepEqual(directory.list().map((d) => [d.state, d.error]), [['ready', undefined]]);
});

test('activateAll() wakes each extension once and survives one that fails', async () => {
  const { host, directory } = setup();
  host.installed.push(installed({ id: 'a', extensionId: 'acme.multi' }), installed({ id: 'b', extensionId: 'acme.multi' }), installed({ id: 'c', extensionId: 'acme.bad' }));
  host.behaviour.set('acme.bad', () => { throw new Error('nope'); });
  await directory.activateAll();
  assert.deepEqual([...host.activations].sort(), ['acme.bad', 'acme.multi']);
  assert.deepEqual(directory.list().map((d) => [d.id, d.state]), [['a', 'inactive'], ['b', 'inactive'], ['c', 'failed']]);
});
