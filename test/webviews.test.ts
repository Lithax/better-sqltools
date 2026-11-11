import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { after, test } from 'node:test';
import { JSDOM } from 'jsdom';
import { sqliteDescriptor } from '../drivers/sqlite/src';

const windows: { close(): void }[] = [];
// jsdom timers (the running spinner's setInterval) would keep the test process alive otherwise
after(() => windows.forEach((w) => w.close()));

function boot(page: 'results' | 'connection-form') {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="root"></div></body>', { runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://webview.invalid/' });
  const w = dom.window as any;
  windows.push(w);
  const posted: any[] = [];
  // VS Code structured-clones messages across the process boundary; mirror that so objects are same-realm
  w.acquireVsCodeApi = () => ({ postMessage: (m: unknown) => posted.push(JSON.parse(JSON.stringify(m))) });
  w.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
  w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', `${page}.js`), 'utf8'));
  const doc: Document = w.document;
  return {
    w, doc, posted,
    send: (data: unknown) => w.dispatchEvent(new w.MessageEvent('message', { data })),
    $: (sel: string) => doc.querySelector(sel) as HTMLElement,
    $$: (sel: string) => [...doc.querySelectorAll(sel)] as HTMLElement[],
    text: (sel: string) => (doc.querySelector(sel)?.textContent ?? ''),
    type: (el: HTMLInputElement, value: string) => { el.value = value; el.dispatchEvent(new w.Event('input', { bubbles: true })); },
    click: (el: Element) => el.dispatchEvent(new w.MouseEvent('click', { bubbles: true })),
    last: (type: string) => [...posted].reverse().find((m) => m.type === type),
  };
}

const stmt = (index: number, o: Record<string, unknown> = {}) => ({ index, sql: `select ${index}`, columns: [], rows: [], truncated: false, durationMs: 3.2, ...o });
const done = (statements: any[], extra: Record<string, unknown> = {}) => ({
  status: 'done',
  result: { connectionId: 'c', connectionName: 'Local', driverName: 'SQLite', startedAt: 1, durationMs: 12, statements, omitted: 0, cancelled: false, ...extra },
});
const people = stmt(0, {
  sql: 'select * from people',
  columns: [{ name: 'id' }, { name: 'name' }, { name: 'blob' }],
  rows: [[3, 'Carol', null], [1, 'ada', { $blob: '0aff', bytes: 2 }], [2, 'Bob', null], [10, '<img src=x onerror="window.pwned=1">', null]],
});

// ---------------------------------------------------------------- results

test('results: asks for state on load and shows an empty state', () => {
  const p = boot('results');
  assert.deepEqual(p.posted, [{ type: 'ready' }]);
  assert.match(p.text('.empty'), /No results yet/);
});

test('results: running state offers Cancel', () => {
  const p = boot('results');
  p.send({ type: 'state', state: { status: 'running', connection: 'Local', sql: 'select 1', startedAt: Date.now() } });
  assert.match(p.text('.running'), /Running on Local/);
  p.click(p.$('.running button'));
  assert.deepEqual(p.last('cancel'), { type: 'cancel' });
});

test('results: renders the grid, with NULL, numbers and blobs styled', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  assert.deepEqual(p.$$('.hcell .hname').map((e) => e.textContent), ['id', 'name', 'blob']);
  assert.equal(p.$$('.gbody .grow').length, 4);
  const firstRow = [...p.$$('.gbody .grow')[0].querySelectorAll('.cell')].map((c) => [c.textContent, c.className.replace('cell ', '')]);
  assert.deepEqual(firstRow, [['1', 'rownum'], ['3', 'num'], ['Carol', 'str'], ['NULL', 'null']]);
  assert.match(p.$$('.gbody .grow')[1].textContent!, /0x0aff$/);
  assert.match(p.text('.footer'), /4 rows/);
  assert.equal(p.$$('.tab').length, 0, 'a single statement has no tabs');
});

test('results: database values are rendered as text, never as HTML', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  assert.equal(p.$$('.grid img').length, 0);
  assert.ok(p.text('.grid').includes('<img src=x onerror="window.pwned=1">'));
  assert.equal(p.w.pwned, undefined);

  p.send({ type: 'state', state: done([stmt(0, { error: { message: '<b>bad</b>' } })]) });
  assert.equal(p.$$('.errorbox b').length, 0);
});

test('results: sorting cycles ascending, descending, off; NULLs stay last; numbers sort numerically', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  const ids = () => p.$$('.gbody .grow').map((r) => r.querySelectorAll('.cell')[1].textContent);
  assert.deepEqual(ids(), ['3', '1', '2', '10']);
  const idHeader = () => p.$$('.hcell')[0];
  p.click(idHeader());
  assert.deepEqual(ids(), ['1', '2', '3', '10']);
  assert.equal(idHeader().getAttribute('aria-sort'), 'ascending');
  p.click(idHeader());
  assert.deepEqual(ids(), ['10', '3', '2', '1']);
  p.click(idHeader());
  assert.deepEqual(ids(), ['3', '1', '2', '10']);

  const blobHeader = () => p.$$('.hcell')[2];
  p.click(blobHeader());
  assert.equal(p.$$('.gbody .grow')[0].querySelectorAll('.cell')[3].textContent!.startsWith('0x0aff'), true);
  p.click(blobHeader());
  assert.equal(p.$$('.gbody .grow')[0].querySelectorAll('.cell')[3].textContent!.startsWith('0x0aff'), true, 'NULLs last in both directions');
});

test('results: filter narrows rows and says how many match; copy and export carry what is shown', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  p.type(p.$('.filter') as HTMLInputElement, 'BOB');
  assert.equal(p.$$('.gbody .grow').length, 1);
  assert.match(p.text('.toolbar'), /1 of 4 rows match/);

  const button = (label: string) => p.$$('.toolbar button').find((b) => b.textContent === label)!;
  p.click(button('Copy'));
  assert.deepEqual(p.last('copy'), { type: 'copy', text: 'id\tname\tblob\n2\tBob\t' });
  p.click(button('Export CSV'));
  assert.deepEqual(p.last('export'), { type: 'export', format: 'csv', index: 0 });
  p.click(button('Export JSON'));
  assert.deepEqual(p.last('export'), { type: 'export', format: 'json', index: 0 });

  p.type(p.$('.filter') as HTMLInputElement, 'no such text');
  assert.equal(p.$$('.gbody .grow').length, 0);
});

test('results: large blobs show their real size', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([stmt(0, { columns: [{ name: 'b' }], rows: [[{ $blob: 'ab'.repeat(64), bytes: 1_500_000 }]] })]) });
  assert.match(p.$$('.gbody .cell')[1].textContent!, /^0x(ab){16}… \(1,500,000 B\)$/);
});

test('results: click selects a cell, Ctrl+C copies its full value', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  p.click(p.$$('.gbody .grow')[0].querySelectorAll('.cell')[2]);
  assert.equal(p.$$('.cell.sel').length, 1);
  p.$('.grid').dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'c', ctrlKey: true, bubbles: true, cancelable: true }));
  assert.deepEqual(p.last('copy'), { type: 'copy', text: 'Carol' });
});

test('results: only a window of a large result is in the DOM, and it follows the scroll position', async () => {
  const rows = Array.from({ length: 5000 }, (_, i) => [i + 1, `row ${i + 1}`]);
  const p = boot('results');
  p.send({ type: 'state', state: done([stmt(0, { columns: [{ name: 'n' }, { name: 's' }], rows })]) });
  assert.ok(p.$$('.gbody .grow').length < 60, `painted ${p.$$('.gbody .grow').length}`);
  assert.equal(p.$('.grid-inner').style.height, `${26 + 5000 * 24}px`);

  const grid = p.$('.grid');
  grid.scrollTop = 24 * 4980;
  grid.dispatchEvent(new p.w.Event('scroll'));
  await new Promise((r) => setTimeout(r, 60));
  const numbers = p.$$('.gbody .grow .rownum').map((c) => Number(c.textContent));
  assert.ok(numbers.includes(4990) && !numbers.includes(1), `rows ${numbers[0]}–${numbers.at(-1)}`);
});

test('results: several statements get tabs; the interesting one is shown first; errors and DML read clearly', () => {
  const p = boot('results');
  const dml = stmt(1, { affectedRows: 2, sql: 'insert into t values (1),(2)' });
  p.send({ type: 'state', state: done([stmt(0, { sql: 'create table t (x)', affectedRows: 0 }), dml, people && { ...people, index: 2 }]) });
  assert.equal(p.$$('.tab').length, 3);
  assert.ok(p.$('.tab.active').textContent!.startsWith('3'), 'the last statement that returned rows');
  p.click(p.$$('.tab')[1]);
  assert.match(p.text('.okbox'), /2 rows affected/);
  assert.equal(p.$$('.grid').length, 0);

  p.send({ type: 'state', state: { ...done([dml, stmt(1, { error: { message: 'no such table: nope', code: 'X1' } })]), } });
  assert.ok(p.$('.tab.active').className.includes('err'), 'a failing statement is shown first');
  assert.match(p.text('.errorbox'), /no such table: nope\n\(X1\)/);
});

test('results: summary, truncation and omitted-result notices', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([stmt(0, { columns: [{ name: 'a' }], rows: [[1]], truncated: true })], { omitted: 480 }) });
  assert.match(p.text('.summary'), /Local · SQLite · 481 statements · 12 ms/);
  assert.match(p.text('.summary'), /480 quiet results not shown/);
  assert.match(p.text('.footer'), /stopped at the row limit/);

  p.send({ type: 'state', state: done([], { cancelled: true }) });
  assert.match(p.text('.empty'), /Cancelled/);
  p.send({ type: 'state', state: { status: 'error', connection: 'Local', message: 'ECONNREFUSED' } });
  assert.match(p.text('.errorbox'), /ECONNREFUSED/);
});

test('results: a re-sent identical result keeps your sort and filter; a new run resets them', () => {
  const p = boot('results');
  const state = done([people]);
  p.send({ type: 'state', state });
  p.click(p.$$('.hcell')[0]);
  p.send({ type: 'state', state: JSON.parse(JSON.stringify(state)) }); // e.g. the panel was re-shown
  assert.equal(p.$$('.hcell')[0].getAttribute('aria-sort'), 'ascending');
  p.send({ type: 'state', state: done([people], { startedAt: 2 }) });
  assert.equal(p.$$('.hcell')[0].getAttribute('aria-sort'), 'none');
});

// ---------------------------------------------------------------- connection form

const fakePg = {
  id: 'pg', displayName: 'PostgreSQL', description: 'Postgres.', capabilities: {}, dialect: sqliteDescriptor.dialect,
  connectionSchema: [
    { key: 'host', label: 'Host', type: 'string', required: true, default: 'localhost' },
    { key: 'port', label: 'Port', type: 'number', default: 5432, min: 1, max: 65535 },
    { key: 'ssl', label: 'SSL mode', type: 'select', default: 'prefer', options: [{ value: 'disable', label: 'Disable' }, { value: 'prefer', label: 'Prefer' }] },
    { key: 'password', label: 'Password', type: 'password', required: true },
  ],
};
const init = (o: Record<string, unknown> = {}) => ({
  type: 'init', mode: 'new', drivers: [sqliteDescriptor, fakePg], storedSecrets: [], canUseWorkspace: true,
  profile: { name: '', driver: 'sqlite', options: {}, scope: 'user' }, ...o,
});

test('form: renders fields from the driver schema, including defaults', () => {
  const p = boot('connection-form');
  assert.deepEqual(p.posted, [{ type: 'ready' }]);
  p.send(init());
  assert.equal(p.text('h1'), 'New connection');
  const driver = p.$('#driver') as HTMLInputElement;
  assert.equal(driver.value, 'SQLite');
  assert.equal(driver.readOnly, true, 'the field shows the driver, the picker changes it');
  assert.equal((p.$('#choose-driver') as HTMLButtonElement).disabled, false);
  assert.ok(p.$('#f-path'));
  assert.equal((p.$('#f-createIfMissing') as HTMLInputElement).checked, true);
  assert.equal((p.$('#f-readOnly') as HTMLInputElement).checked, false);
  assert.equal(p.$$('.hint').some((h) => /Use :memory:/.test(h.textContent!)), true);
  assert.equal(p.$('#f-host'), null, 'only the selected driver’s fields');
  assert.equal(p.$$('input[name=scope]').length, 2);
  assert.equal(p.$$('.check').some((c) => /Remember password/.test(c.textContent!)), false, 'no password field, no remember option');
});

test('form: switching driver re-renders its fields; select and password fields behave', () => {
  const p = boot('connection-form');
  p.send(init());
  pickDriver(p, 'PostgreSQL');
  assert.equal((p.$('#driver') as HTMLInputElement).value, 'PostgreSQL');
  assert.ok(p.$('#f-host') && p.$('#f-port') && p.$('#f-ssl') && p.$('#f-password'));
  assert.equal(p.$('#f-path'), null);
  assert.equal((p.$('#f-ssl') as HTMLSelectElement).value, 'prefer');
  assert.equal((p.$('#f-password') as HTMLInputElement).type, 'password');
  assert.match((p.$('#f-password') as HTMLInputElement).placeholder, /Asked when you connect/);
  assert.ok(p.$$('.check').some((c) => /Remember password/.test(c.textContent!)));
});

type Page = ReturnType<typeof boot>;
const dialogButton = (p: Page, label: string) => p.$$('.dialog button').find((b) => b.textContent === label) as HTMLButtonElement;
const card = (p: Page, name: string) => p.$$('.driver-card').find((c) => c.textContent!.includes(name))!;
/** Opens the picker, selects a driver by name and confirms. */
function pickDriver(p: Page, name: string) {
  p.click(p.$('#choose-driver'));
  p.click(card(p, name));
  p.click(dialogButton(p, 'Select'));
}
const key = (p: Page, k: string, el: Element = p.doc.activeElement!) => el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true }));
const icon = { light: 'data:image/svg+xml;base64,AAA', dark: 'data:image/svg+xml;base64,AAA' };

test('form: the driver picker shows icons and names, filters by search, and cannot select drivers that are unavailable', () => {
  const p = boot('connection-form');
  p.send(init({ drivers: [{ ...sqliteDescriptor, iconData: icon }, fakePg], unavailable: [{ id: 'ora', displayName: 'Oracle', state: 'failed', error: 'Cannot find module oracledb' }, { id: 'sf', displayName: 'Snowflake', state: 'inactive' }] }));
  assert.equal(p.$('.overlay'), null, 'closed until asked for');
  assert.equal(p.$('#driver-hint')!.textContent, sqliteDescriptor.description);

  p.click(p.$('#choose-driver'));
  assert.equal(p.$('.dialog')!.getAttribute('role'), 'dialog');
  assert.equal(p.doc.activeElement, p.$('input[type=search]'), 'typing starts straight away');
  assert.deepEqual(p.$$('.driver-card').map((c) => c.querySelector('.driver-name')!.textContent), ['SQLite', 'PostgreSQL', 'Oracle', 'Snowflake']);
  assert.equal(card(p, 'SQLite').querySelector('img')!.getAttribute('src'), icon.dark, 'the driver’s own icon');
  assert.ok(card(p, 'PostgreSQL').querySelector('svg.glyph'), 'a driver without an image gets the generic glyph');
  assert.equal(card(p, 'SQLite').getAttribute('aria-selected'), 'true', 'the current driver starts selected');
  assert.match(p.text('.picker-count'), /2 drivers, 2 not available/);
  assert.equal(card(p, 'Oracle').getAttribute('aria-disabled'), 'true');
  assert.match(card(p, 'Oracle').getAttribute('title')!, /oracledb/, 'the reason is on hover');
  assert.match(card(p, 'Oracle').textContent!, /Failed to load/);
  assert.match(card(p, 'Snowflake').textContent!, /Not loaded/);

  p.click(card(p, 'Oracle'));
  assert.equal(card(p, 'SQLite').getAttribute('aria-selected'), 'true', 'clicking an unavailable driver does nothing');

  p.type(p.$('input[type=search]') as HTMLInputElement, 'POST');
  assert.deepEqual(p.$$('.driver-card').map((c) => c.querySelector('.driver-name')!.textContent), ['PostgreSQL'], 'case-insensitive, by name');
  p.type(p.$('input[type=search]') as HTMLInputElement, 'zzz');
  assert.equal(p.$$('.driver-card').length, 0);
  assert.match(p.text('.picker-count'), /No driver matches “zzz”/);
  p.type(p.$('input[type=search]') as HTMLInputElement, 'postgres');
  assert.equal(p.$$('.driver-card').length, 1, 'by id too');
});

test('form: picking a driver replaces the fields; cancelling keeps everything as it was', () => {
  const p = boot('connection-form');
  p.send(init());
  p.type(p.$('#f-path') as HTMLInputElement, '/tmp/a.db');

  p.click(p.$('#choose-driver'));
  p.click(card(p, 'PostgreSQL'));
  p.click(dialogButton(p, 'Cancel'));
  assert.equal(p.$('.overlay'), null);
  assert.equal((p.$('#driver') as HTMLInputElement).value, 'SQLite');
  assert.equal((p.$('#f-path') as HTMLInputElement).value, '/tmp/a.db', 'cancel changes nothing');
  assert.equal(p.doc.activeElement, p.$('#choose-driver'), 'focus goes back to the button');

  p.click(p.$('#choose-driver'));
  p.click(card(p, 'SQLite'));
  p.click(dialogButton(p, 'Select'));
  assert.equal((p.$('#f-path') as HTMLInputElement).value, '/tmp/a.db', 'choosing the same driver keeps what was typed');

  pickDriver(p, 'PostgreSQL');
  assert.ok(p.$('#f-host'));
  assert.equal(p.$('#f-path'), null);
  assert.equal(p.$('#driver-hint')!.textContent, 'Postgres.');
  p.click(p.$$('.actions button').find((b) => /Test/.test(b.textContent!))!);
  assert.equal(p.last('test').draft.driver, 'pg');
});

test('form: the picker works from the keyboard', () => {
  const p = boot('connection-form');
  p.send(init());
  p.click(p.$('#choose-driver'));

  key(p, 'ArrowDown'); // from the search field into the grid
  assert.equal(p.doc.activeElement, card(p, 'SQLite'));
  key(p, 'ArrowRight');
  assert.equal(card(p, 'PostgreSQL').getAttribute('aria-selected'), 'true');
  assert.equal(p.doc.activeElement, card(p, 'PostgreSQL'), 'focus follows the selection');
  key(p, 'ArrowLeft');
  key(p, 'ArrowLeft');
  assert.equal(card(p, 'SQLite').getAttribute('aria-selected'), 'true', 'stops at the first');
  key(p, 'ArrowRight');
  key(p, 'Enter');
  assert.equal(p.$('.overlay'), null);
  assert.equal((p.$('#driver') as HTMLInputElement).value, 'PostgreSQL');

  p.click(p.$('#choose-driver'));
  key(p, 'Escape');
  assert.equal(p.$('.overlay'), null, 'Escape closes');
  assert.equal((p.$('#driver') as HTMLInputElement).value, 'PostgreSQL');

  // Tab stays inside the dialog
  p.click(p.$('#choose-driver'));
  const last = dialogButton(p, 'Select');
  last.focus();
  key(p, 'Tab');
  assert.equal(p.doc.activeElement, p.$('input[type=search]'), 'wraps from the last control to the first');
  key(p, 'Tab', p.$('input[type=search]'));
  key(p, 'Escape');
});

test('form: Install more drivers asks the host, and a driver that arrives meanwhile shows up', () => {
  const p = boot('connection-form');
  p.send(init());
  p.click(p.$('#choose-driver'));
  assert.equal(p.$$('.driver-card').length, 2);
  p.click(dialogButton(p, 'Install more drivers…'));
  assert.deepEqual(p.last('findDrivers'), { type: 'findDrivers' });
  assert.ok(p.$('.overlay'), 'the picker stays open while the marketplace opens');

  p.send({ type: 'drivers', drivers: [sqliteDescriptor, fakePg, { ...fakePg, id: 'duck', displayName: 'DuckDB' }], unavailable: [] });
  assert.deepEqual(p.$$('.driver-card').map((c) => c.querySelector('.driver-name')!.textContent), ['SQLite', 'PostgreSQL', 'DuckDB']);
  assert.equal(card(p, 'SQLite').getAttribute('aria-selected'), 'true', 'the selection survives the update');
});

test('form: validates locally, then posts a clean payload', () => {
  const p = boot('connection-form');
  p.send(init());
  p.click(p.$('button[type=submit]'));
  assert.equal(p.last('save'), undefined);
  assert.match(p.text('.notice.error'), /Give the connection a name\.\n"Database file" is required\./);

  p.type(p.$('#name') as HTMLInputElement, '  Dev DB ');
  p.type(p.$('#f-path') as HTMLInputElement, '${workspaceFolder}/dev.db');
  p.click(p.$('#f-readOnly'));
  p.click(p.$('button[type=submit]'));
  assert.deepEqual(p.last('save'), {
    type: 'save',
    draft: { name: 'Dev DB', driver: 'sqlite', scope: 'user', options: { path: '${workspaceFolder}/dev.db', readOnly: true }, secrets: {}, saveSecrets: true },
  });
  assert.equal(p.text('button[type=submit]'), 'Saving…');
  assert.equal((p.$('button[type=submit]') as HTMLButtonElement).disabled, true);

  p.send({ type: 'saveError', message: 'Driver "sqlite" is not installed.' });
  assert.match(p.text('.notice.error'), /not installed/);
  assert.equal((p.$('button[type=submit]') as HTMLButtonElement).disabled, false);
});

test('form: Test posts the draft and shows the outcome', () => {
  const p = boot('connection-form');
  p.send(init({ profile: { name: 'x', driver: 'sqlite', options: { path: ':memory:' }, scope: 'user' } }));
  const test = () => p.$$('.actions button').find((b) => /Test|Testing/.test(b.textContent!))!;
  p.click(test());
  assert.equal(p.last('test').draft.options.path, ':memory:');
  assert.equal(test().textContent, 'Testing…');
  p.send({ type: 'testResult', ok: true, message: 'Connection successful.' });
  assert.match(p.text('.notice.ok'), /Connection successful/);
  p.click(test());
  p.send({ type: 'testResult', ok: false, message: 'ECONNREFUSED' });
  assert.match(p.text('.notice.error'), /ECONNREFUSED/);
});

test('form: browse round trip, edit mode, stored secrets and workspace-less windows', () => {
  const p = boot('connection-form');
  p.send(init({ mode: 'edit', canUseWorkspace: false, storedSecrets: ['password'], profile: { name: 'Prod', driver: 'pg', options: { host: 'db' }, scope: 'user' } }));
  assert.equal(p.text('h1'), 'Edit connection');
  assert.equal((p.$('#driver') as HTMLInputElement).value, 'PostgreSQL');
  assert.equal((p.$('#choose-driver') as HTMLButtonElement).disabled, true, 'a connection keeps its driver');
  assert.equal(p.$$('input[name=scope]').length, 0, 'no workspace, no scope choice');
  assert.equal((p.$('#f-host') as HTMLInputElement).value, 'db');
  assert.match((p.$('#f-password') as HTMLInputElement).placeholder, /Saved\. Type to replace it/);
  p.type(p.$('#f-password') as HTMLInputElement, 'new-secret');
  p.click(p.$('button[type=submit]'));
  assert.deepEqual(p.last('save').draft.secrets, { password: 'new-secret' });

  const q = boot('connection-form');
  q.send(init());
  q.click(q.$$('button').find((b) => b.textContent === 'Browse…')!);
  assert.deepEqual(q.last('browse'), { type: 'browse', key: 'path' });
  q.send({ type: 'browsed', key: 'path', path: '/tmp/x.db' });
  assert.equal((q.$('#f-path') as HTMLInputElement).value, '/tmp/x.db');
  q.click(q.$$('.actions button').find((b) => b.textContent === 'Cancel')!);
  assert.deepEqual(q.last('cancel'), { type: 'cancel' });
});
