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
  // the results page keeps its pure logic in a script of its own, loaded first, as in the real page
  for (const file of page === 'results' ? ['results-core.js', 'results.js'] : [`${page}.js`]) w.eval(fs.readFileSync(path.join(__dirname, '..', 'media', file), 'utf8'));
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
  assert.deepEqual(firstRow, [['1', 'rownum'], ['3', 'num k-integer'], ['Carol', 'str k-text'], ['NULL', 'null k-binary']], 'the kind of a column the driver said nothing about comes from its values');
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

const toolbarButton = (p: ReturnType<typeof boot>, label: string) => p.$(`.toolbar button[aria-label^="${label}"]`) as HTMLButtonElement;
// the lock and the Commit / Roll back buttons are in the toolbar from the start and shown only when the host has something to say about editing
const shownToolbarButtons = (p: ReturnType<typeof boot>) => p.$$('.toolbar button').filter((b) => (b as HTMLElement).style.display !== 'none');
const press = (p: ReturnType<typeof boot>, k: string, el: Element, extra: Record<string, unknown> = {}) =>
  el.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...extra }));

test('results: Copy and Export send the rows as shown, in the order shown; the dialog picks the format and the action', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  assert.deepEqual(shownToolbarButtons(p).map((b) => b.getAttribute('aria-label')), ['Column widths', 'Copy the rows shown, tab-separated', 'Export the rows shown\u2026'], 'a read-only result with no word from the host about editing shows no lock');
  assert.ok(p.$$('.toolbar button').every((b) => b.querySelector('.codicon')), 'icon buttons, with their meaning in the label and tooltip');
  assert.equal(p.$('.filter'), null, 'the filter box is gone');

  p.click(p.$$('.hcell')[0]); // sort by id: 1, 2, 3, 10 are rows 1, 2, 0, 3
  p.click(toolbarButton(p, 'Copy'));
  assert.deepEqual(p.last('export'), { type: 'export', format: 'tsv', action: 'copy', index: 0, rows: [1, 2, 0, 3] });
  assert.equal(p.text('.toast'), 'Copied');

  p.click(toolbarButton(p, 'Export'));
  assert.equal(p.$('.popover').getAttribute('role'), 'dialog');
  assert.match(p.text('.popover'), /4 rows, as shown/);
  assert.equal((p.$('.popover input:checked') as HTMLInputElement).value, 'csv', 'CSV unless told otherwise');
  assert.equal(toolbarButton(p, 'Export').getAttribute('aria-expanded'), 'true');
  const choose = (v: string) => {
    const r = p.$(`.popover input[value=${v}]`) as HTMLInputElement;
    r.checked = true;
    r.dispatchEvent(new p.w.Event('change', { bubbles: true }));
  };
  const action = (label: string) => p.$$('.popover button').find((b) => b.textContent === label)!;

  choose('json');
  p.click(action('Copy'));
  assert.deepEqual(p.last('export'), { type: 'export', format: 'json', action: 'copy', index: 0, rows: [1, 2, 0, 3] });
  assert.equal(p.$('.popover'), null, 'the dialog closes');
  assert.equal(toolbarButton(p, 'Export').getAttribute('aria-expanded'), 'false');
  assert.equal(p.doc.activeElement, toolbarButton(p, 'Export'), 'focus returns to the button');

  p.click(toolbarButton(p, 'Export'));
  assert.equal((p.$('.popover input:checked') as HTMLInputElement).value, 'json', 'the last format is remembered');
  p.click(action('Save as\u2026'));
  assert.deepEqual(p.last('export'), { type: 'export', format: 'json', action: 'save', index: 0, rows: [1, 2, 0, 3] });

  const sent = p.posted.length;
  p.click(toolbarButton(p, 'Export'));
  p.click(action('Cancel'));
  p.click(toolbarButton(p, 'Export'));
  p.doc.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(p.$('.popover'), null, 'Cancel and Escape both close it');
  assert.equal(p.posted.length, sent, 'and send nothing');

  p.click(toolbarButton(p, 'Export'));
  p.doc.body.dispatchEvent(new p.w.MouseEvent('mousedown', { bubbles: true }));
  assert.equal(p.$('.popover'), null, 'so does a click elsewhere');
});

test('results: the width menu applies a fit mode at once, tells the host, and follows the setting', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  const widths = () => p.$$('.hcell').map((c) => parseInt(c.style.width, 10));
  const items = () => p.$$('.popover [role=menuitemradio]');
  const open = () => p.click(toolbarButton(p, 'Column widths'));

  // jsdom has no layout: text is estimated at 7.5 px a character, and a grid of unknown width is fitted to 800 px
  assert.deepEqual(widths(), [89, 294, 104], 'the default: names and values, the long value\u2019s column wide but not absurd');
  open();
  assert.deepEqual(items().map((i) => i.textContent!.split('\n')[0].replace(/Equal.*|As wide.*|Wide enough.*/, '')), ['Fit all columns to the panel', 'Fit column names', 'Fit names and values']);
  assert.deepEqual(items().map((i) => i.getAttribute('aria-checked')), ['false', 'false', 'true']);

  p.click(items()[0]);
  assert.deepEqual(p.last('setColumnFit'), { type: 'setColumnFit', mode: 'fitAll' });
  assert.deepEqual(widths(), [267, 267, 266], 'equal shares of the panel, whatever is in the columns');
  assert.equal(p.$('.popover'), null);

  open();
  assert.equal(items()[0].getAttribute('aria-checked'), 'true');
  p.click(items()[1]);
  assert.deepEqual(widths(), [89, 104, 104], 'as wide as the names');

  const sent = p.posted.filter((m) => m.type === 'setColumnFit').length;
  open();
  p.click(items()[1]); // the mode it already is
  assert.equal(p.posted.filter((m) => m.type === 'setColumnFit').length, sent, 'nothing to tell the host');

  p.send({ type: 'settings', settings: { columnFit: 'fitNameAndValue', showTypes: true, colorByType: true } }); // the setting changed elsewhere
  assert.deepEqual(widths(), [89, 294, 104]);
});

test('results: headers show the type and the constraints the driver reported; values are styled by kind and constraint', () => {
  const p = boot('results');
  const columns = [
    { name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true, notNull: true },
    { name: 'author_id', type: 'INTEGER', kind: 'integer', foreignKey: { table: 'authors', column: 'id' } },
    { name: 'isbn', type: 'TEXT', kind: 'text', unique: true },
    { name: 'in_stock', type: 'BOOLEAN', kind: 'boolean' },
    { name: 'total' },
  ];
  p.send({ type: 'state', state: done([stmt(0, { columns, rows: [[1, 7, '978', 1, 60], [2, null, null, 0, 60]] })]) });
  assert.deepEqual(p.$$('.hcell .htype').map((e) => e.textContent), ['INTEGER', 'INTEGER', 'TEXT', 'BOOLEAN'], 'the type as the database spells it (the page lowercases it for display)');
  assert.deepEqual(p.$$('.hcell').map((c) => [...c.querySelectorAll('.pill')].map((e) => e.textContent)), [['PK'], ['FK'], ['UQ'], [], []]);
  assert.equal(p.$$('.hcell .pill')[1].getAttribute('title'), 'Foreign key to authors.id');
  assert.match(p.$$('.hcell')[0].getAttribute('title')!, /^id \(INTEGER\)\nprimary key\nnot null\nClick to sort$/);

  const row = (i: number) => [...p.$$('.gbody .grow')[i].querySelectorAll('.cell')].slice(1).map((c) => c.className.split(' ').filter((k) => k !== 'cell').join(' '));
  assert.deepEqual(row(0), ['num k-integer c-pk', 'num k-integer c-fk', 'str k-text', 'num k-boolean', 'num k-integer'], 'kinds come from the driver, or from the values when it said nothing');
  assert.deepEqual(row(1), ['num k-integer c-pk', 'null k-integer c-fk', 'null k-text', 'num k-boolean', 'num k-integer']);
  assert.deepEqual(p.$$('.hcell').map((c) => c.className.split(' ').find((k) => k.startsWith('k-'))), ['k-integer', 'k-integer', 'k-text', 'k-boolean', 'k-integer']);
});

test('results: type labels and colours are settings, and the page follows them as they change', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([stmt(0, { columns: [{ name: 'id', type: 'INTEGER', kind: 'integer', primaryKey: true }], rows: [[1]] })]) });
  assert.equal(p.doc.body.classList.contains('typed'), true, 'on by default');
  assert.equal(p.$$('.htype').length, 1);
  const wide = parseInt(p.$$('.hcell')[0].style.width, 10);

  p.send({ type: 'settings', settings: { columnFit: 'fitNameAndValue', showTypes: false, colorByType: false } });
  assert.equal(p.doc.body.classList.contains('typed'), false);
  assert.equal(p.$$('.htype').length, 0);
  assert.equal(p.$$('.pill').length, 1, 'the constraint pills are information, not decoration');
  assert.ok(parseInt(p.$$('.hcell')[0].style.width, 10) < wide, 'the column no longer reserves room for the type');

  p.send({ type: 'settings', settings: { columnFit: 'fitNameAndValue', showTypes: true, colorByType: true } });
  assert.equal(p.$$('.htype').length, 1);
  assert.equal(parseInt(p.$$('.hcell')[0].style.width, 10), wide);
});

test('results: a column border resizes by drag, by keyboard, and fits on double-click; sizes outlive tabs and re-sent results', () => {
  const p = boot('results');
  const second = { ...people, index: 1, sql: 'select 2' };
  const state = done([people, second]);
  p.send({ type: 'state', state });
  const width = (i: number) => parseInt(p.$$('.hcell')[i].style.width, 10);
  const handle = (i: number) => p.$$('.resizer')[i];
  assert.equal(handle(1).getAttribute('role'), 'separator');
  assert.equal(width(1), 294);
  const total = () => parseInt(p.$('.grid-inner').style.width, 10);
  const before = total();

  const mouse = (type: string, x: number) => handle(1).dispatchEvent(new p.w.MouseEvent(type, { clientX: x, button: 0, bubbles: true, cancelable: true }));
  mouse('pointerdown', 500);
  mouse('pointermove', 560);
  assert.equal(width(1), 354, 'follows the pointer');
  assert.equal(total(), before + 60, 'and the grid grows with it');
  mouse('pointermove', 100);
  assert.equal(width(1), 40, 'but not below a sliver');
  mouse('pointerup', 100);
  mouse('pointermove', 900);
  assert.equal(width(1), 40, 'a released handle does not follow the pointer');

  press(p, 'ArrowRight', handle(1));
  assert.equal(width(1), 50);
  press(p, 'ArrowRight', handle(1), { shiftKey: true });
  assert.equal(width(1), 100);
  press(p, 'ArrowLeft', handle(1));
  assert.equal(width(1), 90);
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'none', 'resizing is not sorting');

  p.click(handle(1));
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'none', 'a click on the handle is not a click on the header');
  handle(1).dispatchEvent(new p.w.MouseEvent('dblclick', { bubbles: true }));
  assert.equal(width(1), 294, 'double-click fits that column to its name and values');

  press(p, 'ArrowLeft', handle(0), { shiftKey: true });
  assert.equal(width(0), 40, 'every column can be resized, down to a sliver');

  p.click(p.$$('.tab')[0]); // the last statement with rows is the one shown first; go to the other and come back
  assert.equal(width(0), 89, 'each statement has its own sizes');
  p.click(p.$$('.tab')[1]);
  assert.equal(width(0), 40, 'switching tabs keeps what was set by hand');
  p.send({ type: 'state', state: JSON.parse(JSON.stringify(state)) });
  assert.equal(width(0), 40, 'so does the same result arriving again');
  p.send({ type: 'state', state: done([people, second], { startedAt: 2 }) });
  assert.equal(width(0), 89, 'a new run starts fitted again');
});

test('results: the grid works from the keyboard: arrows, paging, Home and End, header keys, and copying the cell', () => {
  const p = boot('results');
  const rows = Array.from({ length: 40 }, (_, i) => [i + 1, `row ${i + 1}`, i % 2 ? null : 'x']);
  p.send({ type: 'state', state: done([stmt(0, { columns: [{ name: 'n' }, { name: 's' }, { name: 'o' }], rows })]) });
  const grid = p.$('.grid');
  Object.defineProperty(grid, 'clientHeight', { value: 300, configurable: true }); // jsdom has no layout
  const selected = () => {
    const c = p.$('.cell.sel');
    return c ? [Number(c.dataset.r), Number(c.dataset.c)] : null;
  };
  assert.equal(selected(), null);
  press(p, 'ArrowDown', grid);
  assert.deepEqual(selected(), [0, 0], 'the first key press selects the first cell');

  // header cells and resize handles keep their own keys
  press(p, 'ArrowDown', p.$$('.resizer')[0]);
  assert.deepEqual(selected(), [0, 0], 'an arrow on a resize handle does not move the selection');
  press(p, 'Enter', p.$$('.hcell')[1]);
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'ascending');
  press(p, ' ', p.$$('.hcell')[1]);
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'descending');
  press(p, 'Enter', p.$$('.hcell')[1]);
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'none');
  assert.deepEqual(selected(), [0, 0]);
  press(p, 'ArrowDown', grid);
  press(p, 'ArrowRight', grid);
  assert.deepEqual(selected(), [1, 1]);
  press(p, 'End', grid);
  assert.deepEqual(selected(), [1, 2]);
  press(p, 'Home', grid);
  assert.deepEqual(selected(), [1, 0]);
  press(p, 'ArrowLeft', grid);
  press(p, 'ArrowUp', grid);
  press(p, 'ArrowUp', grid);
  assert.deepEqual(selected(), [0, 0], 'it stops at the edges');
  press(p, 'PageDown', grid);
  assert.ok(selected()![0] > 5, 'a page at a time');
  for (let i = 0; i < 10; i++) press(p, 'PageDown', grid);
  assert.deepEqual(selected(), [39, 0], 'the last row');
  assert.ok(grid.scrollTop > 0, 'and the grid scrolled to keep it in view');

  press(p, 'c', grid, { ctrlKey: true });
  assert.deepEqual(p.last('copy'), { type: 'copy', text: '40' });
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
  assert.equal(p.$('.grid-inner').style.height, `${32 + 5000 * 26}px`);

  const grid = p.$('.grid');
  grid.scrollTop = 26 * 4980;
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
  assert.match(p.text('.runinfo'), /Local · SQLite · 481 statements · 12 ms/, 'the run\u2019s summary shares the toolbar with the buttons');
  assert.match(p.text('.runinfo'), /480 quiet results not shown/);
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

// ---------------------------------------------------------------- column filters

const orders = stmt(0, {
  sql: 'select * from orders',
  columns: [{ name: 'id', type: 'integer' }, { name: 'status', type: 'text' }, { name: 'region', type: 'text' }],
  rows: [[1, 'open', 'EU'], [2, 'closed', 'EU'], [3, 'open', 'US'], [4, 'open', null], [5, 'closed', 'US'], [6, 'void', 'US']],
});
const funnel = (p: ReturnType<typeof boot>, col: number) => p.$$('.hcell')[col].querySelector('.filterbtn') as HTMLButtonElement;
const shownIds = (p: ReturnType<typeof boot>) => p.$$('.gbody .grow').map((r) => r.querySelectorAll('.cell')[1].textContent);
const listed = (p: ReturnType<typeof boot>) => p.$$('.popover .vlist .vopt').map((l) => [l.querySelector('.vtext')!.textContent, l.querySelector('.vcount')!.textContent, (l.querySelector('input') as HTMLInputElement).checked]);
const tick = (p: ReturnType<typeof boot>, value: string) => {
  const cb = p.$$('.popover .vlist .vopt').find((l) => l.querySelector('.vtext')!.textContent === value)!.querySelector('input') as HTMLInputElement;
  cb.checked = !cb.checked;
  cb.dispatchEvent(new p.w.Event('change', { bubbles: true }));
};
const popoverButton = (p: ReturnType<typeof boot>, label: string) => p.$$('.popover .actions button').find((b) => b.textContent === label) as HTMLButtonElement;
const selectAll = (p: ReturnType<typeof boot>) => p.$('.popover .selectall') as HTMLInputElement;

test('results: every header has a filter button; its dialog lists the column\u2019s values with counts; Apply hides what is unticked', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([orders]) });
  assert.equal(p.$$('.hcell .filterbtn').length, 3);
  assert.equal(p.$$('.filterbtn.on').length, 0, 'nothing is filtered yet');
  assert.equal(p.$('.toolbar button[aria-label="Clear all filters"]'), null, 'and there is nothing to clear');

  p.click(funnel(p, 1));
  assert.equal(p.$('.popover').getAttribute('role'), 'dialog');
  assert.match(p.text('.popover h2'), /Filter status/);
  assert.match(p.text('.popover .sub'), /^3 values$/);
  assert.deepEqual(listed(p), [['closed', '2', true], ['open', '3', true], ['void', '1', true]], 'natural order, with how many rows have each, all ticked');
  assert.equal(p.doc.activeElement, p.$('.popover .search'), 'typing starts at once');
  assert.equal(selectAll(p).checked, true);
  assert.equal(popoverButton(p, 'Clear filter').disabled, true, 'no filter yet to clear');
  assert.equal(funnel(p, 0).getAttribute('aria-expanded'), 'false');
  assert.equal(funnel(p, 1).getAttribute('aria-expanded'), 'true');

  tick(p, 'open');
  assert.equal(selectAll(p).indeterminate, true, 'some, not all');
  assert.equal(p.$$('.gbody .grow').length, 6, 'nothing changes until Apply');
  p.click(popoverButton(p, 'Apply'));
  assert.equal(p.$('.popover'), null);
  assert.deepEqual(shownIds(p), ['2', '5', '6'], 'only the closed and void orders');
  assert.match(p.text('.toolbar .muted'), /3 of 6 rows match/);
  assert.ok(funnel(p, 1).classList.contains('on'), 'the funnel shows the column is filtered');
  assert.match(funnel(p, 1).getAttribute('aria-label')!, /filtered/);
  assert.match(funnel(p, 1).title, /1 value hidden/);
  assert.ok(p.$$('.hcell')[1].classList.contains('filtered'));
  assert.equal(p.doc.activeElement, funnel(p, 1), 'focus comes back to the button');
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'none', 'filtering is not sorting');

  p.click(p.$('.toolbar button[aria-label^="Copy"]'));
  assert.deepEqual(p.last('export').rows, [1, 4, 5], 'Copy and Export carry the rows that are left');
  p.click(p.$('.toolbar button[aria-label^="Export"]'));
  assert.match(p.text('.popover'), /3 rows, as shown/);
});

test('results: typing in the filter keeps only the matching values, and clearing the search brings the earlier choice back', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([orders]) });
  p.click(funnel(p, 2));
  assert.deepEqual(listed(p), [['EU', '2', true], ['US', '3', true], ['NULL', '1', true]], 'NULL is a value, shown last');
  assert.ok(p.$('.popover .vtext.null'), 'and looks like NULL does in the grid');

  tick(p, 'EU'); // a choice made before searching
  p.type(p.$('.popover .search') as HTMLInputElement, 'us');
  assert.deepEqual(listed(p), [['US', '3', true]], 'only the matches are listed, ticked');
  assert.equal(selectAll(p).checked, true);
  p.type(p.$('.popover .search') as HTMLInputElement, 'zzz');
  assert.deepEqual(listed(p), []);
  assert.match(p.text('.popover .more'), /No values match/);
  assert.equal(selectAll(p).disabled, true);
  p.type(p.$('.popover .search') as HTMLInputElement, '');
  assert.deepEqual(listed(p), [['EU', '2', false], ['US', '3', true], ['NULL', '1', true]], 'the choice made before the search is back');

  p.type(p.$('.popover .search') as HTMLInputElement, 'null');
  assert.deepEqual(listed(p), [['NULL', '1', true]], 'NULL is found by typing null');
  p.type(p.$('.popover .search') as HTMLInputElement, 'US');
  (p.$('.popover .search') as HTMLInputElement).dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  assert.equal(p.$('.popover'), null, 'Enter in the search applies');
  assert.deepEqual(shownIds(p), ['3', '5', '6'], 'rows from the US only');

  p.click(funnel(p, 2));
  assert.deepEqual(listed(p), [['EU', '2', false], ['US', '3', true], ['NULL', '1', false]], 'the filter is shown as it was left');
  p.click(popoverButton(p, 'Clear filter'));
  assert.equal(p.$$('.gbody .grow').length, 6);
  assert.equal(p.$$('.filterbtn.on').length, 0);
  assert.equal(p.text('.toolbar .muted'), '');
});

test('results: Select all, Cancel and Escape; keeping nothing is not offered; ticking everything removes the filter', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([orders]) });
  p.click(funnel(p, 1));
  selectAll(p).click();
  assert.deepEqual(listed(p).map((v) => v[2]), [false, false, false], 'Select all, when everything is ticked, unticks everything');
  assert.equal(popoverButton(p, 'Apply').disabled, true, 'a filter that keeps nothing would only empty the grid');
  selectAll(p).click();
  assert.deepEqual(listed(p).map((v) => v[2]), [true, true, true]);

  tick(p, 'void');
  p.click(popoverButton(p, 'Cancel'));
  assert.equal(p.$('.popover'), null);
  assert.equal(p.$$('.gbody .grow').length, 6, 'Cancel changes nothing');
  assert.equal(p.doc.activeElement, funnel(p, 1), 'and returns to the button');

  p.click(funnel(p, 1));
  tick(p, 'void');
  p.doc.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(p.$('.popover'), null);
  assert.equal(p.$$('.gbody .grow').length, 6, 'so does Escape');

  p.click(funnel(p, 1)); // hide void, then bring it back by ticking everything
  tick(p, 'void');
  p.click(popoverButton(p, 'Apply'));
  assert.equal(p.$$('.gbody .grow').length, 5);
  p.click(funnel(p, 1));
  tick(p, 'void');
  p.click(popoverButton(p, 'Apply'));
  assert.equal(p.$$('.gbody .grow').length, 6);
  assert.equal(p.$$('.filterbtn.on').length, 0, 'everything ticked is no filter');

  p.click(funnel(p, 1));
  p.click(funnel(p, 1)); // the button that opened it closes it
  assert.equal(p.$('.popover'), null);
});

test('results: columns combine; a column lists only what the other filters leave; Clear all filters brings everything back', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([orders]) });
  p.click(funnel(p, 1));
  tick(p, 'closed');
  p.click(popoverButton(p, 'Apply'));
  assert.deepEqual(shownIds(p), ['1', '3', '4', '6']);

  p.click(funnel(p, 2));
  assert.deepEqual(listed(p), [['EU', '1', true], ['US', '2', true], ['NULL', '1', true]], 'the counts are those of the rows left by the status filter');
  assert.match(p.text('.popover .sub'), /in the rows the other filters leave/);
  tick(p, 'US');
  p.click(popoverButton(p, 'Apply'));
  assert.deepEqual(shownIds(p), ['1', '4'], 'both filters apply');
  assert.match(p.text('.toolbar .muted'), /2 of 6 rows match/);
  assert.equal(p.$$('.filterbtn.on').length, 2);

  p.click(funnel(p, 1)); // the status list counts the rows the region filter leaves, and "closed" is still unticked there
  assert.deepEqual(listed(p), [['closed', '1', false], ['open', '2', true]], 'void is not listed: its only order is in the US, which is hidden');
  p.click(popoverButton(p, 'Cancel'));

  const clear = p.$('.toolbar button[aria-label="Clear all filters"]');
  assert.ok(clear, 'the way back to everything is offered while a filter is on');
  assert.equal(shownToolbarButtons(p)[0], clear, 'next to the other tools');
  p.click(clear);
  assert.equal(p.$$('.gbody .grow').length, 6);
  assert.equal(p.$$('.filterbtn.on').length, 0);
  assert.equal(p.$('.toolbar button[aria-label="Clear all filters"]'), null, 'and gone again');
});

test('results: filters work with sorting and the keyboard, and are kept when the same result is re-sent, but not for a new run', () => {
  const p = boot('results');
  const state = done([orders]);
  p.send({ type: 'state', state });
  const header = p.$$('.hcell')[1];
  header.focus();
  header.dispatchEvent(new p.w.KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true }));
  assert.ok(p.$('.popover'), 'Alt+Down on a header opens its filter');
  tick(p, 'open');
  p.click(popoverButton(p, 'Apply'));
  assert.equal(p.$$('.hcell')[1].getAttribute('aria-sort'), 'none', 'opening the filter from the header did not sort it');

  p.click(p.$$('.hcell')[0]); // id ascending, then descending
  p.click(p.$$('.hcell')[0]);
  assert.deepEqual(shownIds(p), ['6', '5', '2'], 'the filter holds under a sort');
  assert.deepEqual(p.last('export') ?? null, null, 'nothing was exported by all this');
  p.click(p.$('.toolbar button[aria-label^="Copy"]'));
  assert.deepEqual(p.last('export').rows, [5, 4, 1], 'in the order shown');

  p.send({ type: 'state', state: JSON.parse(JSON.stringify(state)) });
  assert.deepEqual(shownIds(p), ['6', '5', '2'], 're-shown: still filtered and sorted');
  p.send({ type: 'state', state: done([orders], { startedAt: 2 }) });
  assert.equal(p.$$('.gbody .grow').length, 6, 'a new run starts unfiltered');
  assert.equal(p.$$('.filterbtn.on').length, 0);
});

// ---------------------------------------------------------------- editing

// The page only asks. The host decides whether a result can be edited (editStatus), whether a value is accepted and what the database now
// holds (editResult), and how a commit or rollback ended (editEnd); these tests play the host.
const items = stmt(0, {
  sql: 'select id, name, score from items',
  columns: [{ name: 'id', primaryKey: true, notNull: true }, { name: 'name' }, { name: 'score', notNull: true }],
  rows: [[1, 'one', 10], [2, 'two', 20], [3, null, 30]],
});
const editStatus = (o: Record<string, unknown> = {}) => ({
  type: 'editStatus', index: 0,
  status: { editable: true, columns: [{ editable: true }, { editable: true }, { editable: true }], mode: 'manual', transaction: false, pending: [], ...o },
});
const lockButton = (p: ReturnType<typeof boot>) => p.$('.toolbar button[aria-pressed]') as HTMLButtonElement;
const dataCell = (p: ReturnType<typeof boot>, row: number, col: number) => p.$(`.gbody .cell[data-r="${row}"][data-c="${col}"]`);
const dblclick = (p: ReturnType<typeof boot>, el: Element) => el.dispatchEvent(new p.w.MouseEvent('dblclick', { bubbles: true }));
const editsSent = (p: ReturnType<typeof boot>) => p.posted.filter((m) => m.type === 'edit').length;
const unlockedItems = () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([items]) });
  p.send(editStatus());
  p.click(lockButton(p));
  return p;
};

test('results: a real double click opens the editor, although the first click repaints the cell and the browser then sends no dblclick', () => {
  const p = unlockedItems();
  const click = (el: Element, detail: number) => el.dispatchEvent(new p.w.MouseEvent('click', { bubbles: true, detail }));
  const first = dataCell(p, 0, 1)!;
  click(first, 1);
  assert.equal(p.$('.cell-input'), null, 'one click only selects');
  const second = dataCell(p, 0, 1)!;
  assert.notEqual(second, first, 'the first click rebuilt the cell, as it does in a browser');
  assert.ok(second.classList.contains('sel'));
  click(second, 2); // the second click of the pair is on the NEW element, and no dblclick event follows
  const input = p.$('.cell-input') as HTMLInputElement;
  assert.ok(input, 'the editor is open');
  assert.equal(input.value, 'one');
  assert.equal(p.doc.activeElement, input);
  p.send({ type: 'editStatus', index: 0, status: editStatus().status }); // an unrelated host message does not close or rebuild it
  assert.equal(p.$('.cell-input'), input, 'the same editor');

  const q = unlockedItems();
  const press2 = (el: Element, detail: number) => el.dispatchEvent(new q.w.MouseEvent('click', { bubbles: true, detail }));
  press2(dataCell(q, 0, 1)!, 1);
  press2(dataCell(q, 1, 1)!, 2); // two quick clicks on DIFFERENT cells are not a double click
  assert.equal(q.$('.cell-input'), null);
  assert.ok(dataCell(q, 1, 1)!.classList.contains('sel'), 'the second cell is selected');
});

test('results: the lock appears once the host reports on editing; a result that cannot be edited says why and stays locked', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([items]) });
  assert.equal(lockButton(p).style.display, 'none', 'nothing is known about editing until the host has looked at the result');
  assert.equal(p.$$('.cell.editable').length, 0);

  p.send(editStatus());
  assert.equal(lockButton(p).style.display, '');
  assert.equal(lockButton(p).getAttribute('aria-pressed'), 'false');
  assert.match(lockButton(p).title, /^Locked\./);
  assert.equal((p.$('.toolbar .txnbtn') as HTMLElement).style.display, 'none', 'Commit and Roll back wait for a pending edit');
  dblclick(p, dataCell(p, 0, 1)!);
  assert.equal(p.$('.cell-input'), null, 'locked: a double click edits nothing');

  p.click(lockButton(p));
  assert.equal(lockButton(p).getAttribute('aria-pressed'), 'true');
  assert.match(lockButton(p).title, /^Editing is on/);
  assert.equal(p.$$('.gbody .cell.editable').length, 9, 'every cell the host allows can be edited');
  p.click(lockButton(p));
  assert.equal(p.$$('.gbody .cell.editable').length, 0, 'and the lock shuts it again');

  const q = boot('results');
  q.send({ type: 'state', state: done([items]) });
  q.send(editStatus({ editable: false, reason: 'The result joins two tables.' }));
  assert.match(lockButton(q).title, /^Read-only: The result joins two tables\./);
  assert.equal(lockButton(q).getAttribute('aria-disabled'), 'true');
  q.click(lockButton(q));
  assert.equal(lockButton(q).getAttribute('aria-pressed'), 'false', 'the lock does not open');
  assert.match(q.text('.toast'), /Read-only: The result joins two tables\./);
});

test('results: a cell is edited in place; the page waits for the host, shows what the database holds, marks the change as pending and commits', () => {
  const p = unlockedItems();
  dblclick(p, dataCell(p, 0, 1)!);
  const input = p.$('.cell-input') as HTMLInputElement;
  assert.equal(input.value, 'one');
  assert.equal(p.doc.activeElement, input, 'the editor has the focus');
  p.type(input, 'uno');
  press(p, 'Enter', input);
  assert.deepEqual(p.last('edit'), { type: 'edit', index: 0, row: 0, col: 1, value: 'uno', id: 1 });
  assert.equal(input.readOnly, true, 'it waits for the host');
  assert.equal(dataCell(p, 0, 1)!.querySelector('.cell-input'), input, 'and nothing has changed on the page yet');

  p.send({ type: 'editResult', id: 1, index: 0, row: 0, col: 1, ok: true, changed: true, value: 'UNO' }); // the database may store something else than what was typed
  assert.equal(p.$('.cell-input'), null);
  assert.equal(dataCell(p, 0, 1)!.textContent, 'UNO', 'the value as the database holds it');

  p.send(editStatus({ transaction: true, pending: [{ row: 0, col: 1, before: 'one', after: 'UNO' }] }));
  assert.ok(dataCell(p, 0, 1)!.classList.contains('pending'));
  assert.equal(p.$$('.cell.pending').length, 1);
  assert.equal(p.text('.pendingcount'), '1 pending edit');
  const [commit, rollback] = p.$$('.toolbar .txnbtn');
  assert.deepEqual([commit.style.display, rollback.style.display], ['', '']);
  assert.deepEqual([commit.textContent, rollback.textContent], ['Commit', 'Roll back']);

  p.click(commit);
  assert.deepEqual(p.last('commit'), { type: 'commit', index: 0 });
  p.send({ type: 'editEnd', index: 0, kind: 'commit', ok: true, count: 1, restored: [] });
  assert.match(p.text('.toast'), /Committed 1 edit/);
  p.send(editStatus());
  assert.deepEqual([commit.style.display, rollback.style.display], ['none', 'none']);
  assert.equal(p.$$('.cell.pending').length, 0);
  assert.equal(dataCell(p, 0, 1)!.textContent, 'UNO');
});

test('results: Roll back puts back the values the host gives; a failed commit says why', () => {
  const p = unlockedItems();
  p.send({ type: 'editResult', id: 7, index: 0, row: 1, col: 2, ok: true, changed: true, value: 99 }); // an edit made earlier: the page applies what the host holds
  p.send(editStatus({ transaction: true, pending: [{ row: 1, col: 2, before: 20, after: 99 }, { row: 2, col: 1, before: null, after: 'x' }] }));
  assert.equal(dataCell(p, 1, 2)!.textContent, '99');
  assert.equal(p.text('.pendingcount'), '2 pending edits');

  p.click(p.$$('.toolbar .txnbtn')[1]);
  assert.deepEqual(p.last('rollback'), { type: 'rollback', index: 0 });
  p.send({ type: 'editEnd', index: 0, kind: 'rollback', ok: true, count: 2, restored: [{ row: 1, col: 2, value: 20 }, { row: 2, col: 1, value: null }] });
  assert.equal(dataCell(p, 1, 2)!.textContent, '20');
  assert.match(p.text('.toast'), /Rolled back 2 edits/);

  p.click(p.$$('.toolbar .txnbtn')[0]);
  p.send({ type: 'editEnd', index: 0, kind: 'commit', ok: false, error: 'database is locked' });
  assert.match(p.text('.toast'), /database is locked/);
  assert.ok(p.$('.toast')!.classList.contains('bad'));
});

test('results: a refused value stays in the editor with the reason; Escape drops the edit; an unchanged value sends nothing; NULL is offered only where the column allows it', () => {
  const p = unlockedItems();

  dblclick(p, dataCell(p, 1, 2)!); // score: NOT NULL
  assert.equal(p.$$('.nullbtn').length, 0, 'a NOT NULL column has no NULL button');
  const input = p.$('.cell-input') as HTMLInputElement;
  p.type(input, 'lots');
  press(p, 'Enter', input);
  const sent = p.last('edit');
  assert.equal(sent.value, 'lots');
  p.send({ type: 'editResult', id: sent.id, index: 0, row: 1, col: 2, ok: false, error: 'score must be a whole number.' });
  assert.equal(input.getAttribute('aria-invalid'), 'true');
  assert.equal(input.title, 'score must be a whole number.');
  assert.equal(input.readOnly, false, 'the person can correct it');
  assert.match(p.text('.toast'), /whole number/);
  assert.ok(p.$('.toast')!.classList.contains('bad'));
  press(p, 'Escape', input);
  assert.equal(p.$('.cell-input'), null, 'Escape drops what was typed');
  assert.equal(dataCell(p, 1, 2)!.textContent, '20');
  assert.equal(editsSent(p), 1, 'and sends nothing');

  dblclick(p, dataCell(p, 0, 1)!); // name: nullable
  press(p, 'Enter', p.$('.cell-input'));
  assert.equal(editsSent(p), 1, 'the same value is not sent again');
  assert.equal(p.$('.cell-input'), null);

  dblclick(p, dataCell(p, 0, 1)!);
  assert.equal(p.$$('.nullbtn').length, 1);
  p.click(p.$('.nullbtn'));
  assert.deepEqual(p.last('edit'), { type: 'edit', index: 0, row: 0, col: 1, value: null, id: 2 });
});

test('results: Enter on the selected cell opens the editor; a column the host calls read-only says why; binary values are not edited here', () => {
  const p = boot('results');
  p.send({ type: 'state', state: done([people]) });
  p.send(editStatus({ columns: [{ editable: false, reason: 'This value is computed.' }, { editable: true }, { editable: true }] }));
  press(p, 'Enter', p.$('.grid'));
  assert.equal(p.$('.cell-input'), null, 'locked: Enter does nothing');
  p.click(lockButton(p));

  dblclick(p, dataCell(p, 0, 0)!);
  assert.equal(p.$('.cell-input'), null);
  assert.match(p.text('.toast'), /This value is computed\./);

  dblclick(p, dataCell(p, 1, 2)!); // the blob
  assert.equal(p.$('.cell-input'), null);
  assert.match(p.text('.toast'), /Binary values cannot be edited here/);

  p.click(dataCell(p, 2, 1)!);
  press(p, 'Enter', p.$('.grid'));
  assert.equal((p.$('.cell-input') as HTMLInputElement).value, 'Bob', 'the selected cell, edited from the keyboard');
  press(p, 'Escape', p.$('.cell-input'));
  assert.equal(p.$('.cell-input'), null);
  assert.equal(editsSent(p), 0);
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
