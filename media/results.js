(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  const ROW_H = 24;
  const HEADER_H = 26;
  const BUFFER = 10;
  const ROWNUM_CH = 7;
  const MAX_TEXT = 500;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';

  let state = { status: 'idle' };
  let tab = 0;
  let timer = null;
  const views = new Map(); // statement index -> { sort, filter, selected }

  // ---- tiny DOM helper. Everything goes through textContent: database values are untrusted. ----
  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'style') Object.assign(el.style, v);
        else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
        else el.setAttribute(k, v === true ? '' : String(v));
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const kid = arguments[i];
      if (kid === null || kid === undefined || kid === false) continue;
      el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const fmtInt = (n) => Number(n).toLocaleString();
  const fmtMs = (ms) => (ms < 1 ? '<1 ms' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s');
  const oneLine = (s, n) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
  };

  function cellText(v) {
    if (v === null) return '';
    if (typeof v === 'object') return '0x' + v.$blob + (v.$blob.length / 2 < v.bytes ? '\u2026' : '');
    return String(v);
  }

  function fmt(v) {
    if (v === null) return { text: 'NULL', cls: 'null', title: 'NULL' };
    if (typeof v === 'number') return { text: String(v), cls: 'num', title: String(v) };
    if (typeof v === 'boolean') return { text: String(v), cls: 'bool', title: String(v) };
    if (typeof v === 'object') {
      const t = cellText(v);
      const cut = v.$blob.length / 2 < v.bytes;
      return {
        text: cut ? '0x' + v.$blob.slice(0, 32) + '\u2026 (' + fmtInt(v.bytes) + ' B)' : t,
        cls: 'blob',
        title: fmtInt(v.bytes) + ' bytes\n' + t,
      };
    }
    const s = String(v);
    return {
      text: s.length > MAX_TEXT ? s.slice(0, MAX_TEXT) + '\u2026' : s,
      cls: 'str',
      title: s.length > 2000 ? s.slice(0, 2000) + '\u2026' : s,
    };
  }

  function compare(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  function viewOf(index) {
    let v = views.get(index);
    if (!v) views.set(index, (v = { sort: null, filter: '', selected: null }));
    return v;
  }

  // ---- messages ----
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || m.type !== 'state') return;
    const prev = state;
    state = m.state;
    if (state.status === 'done') {
      const same = prev.status === 'done' && prev.result.startedAt === state.result.startedAt;
      if (!same) {
        tab = initialTab(state.result);
        views.clear();
      }
    }
    render();
  });
  render(); // show the idle state right away; the extension replies to `ready` with the real one
  vscode.postMessage({ type: 'ready' });

  function initialTab(result) {
    const list = result.statements;
    const err = list.findIndex((s) => s.error);
    if (err >= 0) return err;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].columns.length) return i;
    return Math.max(0, list.length - 1);
  }

  // ---- views ----
  function render() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    root.replaceChildren();
    switch (state.status) {
      case 'running': root.append(runningView()); break;
      case 'error': root.append(h('div', { class: 'msg' }, h('div', { class: 'errorbox', role: 'alert' }, state.message))); break;
      case 'done': root.append(doneView()); break;
      default:
        root.append(
          h('div', { class: 'empty' },
            h('strong', null, 'No results yet'),
            'Press ' + mod + '+Enter in a SQL editor to run the statement under the cursor, or open a table from the Better SQLTools view.'),
        );
    }
  }

  function runningView() {
    const elapsed = h('span', null, '0.0 s');
    const started = state.startedAt;
    timer = setInterval(() => (elapsed.textContent = ((Date.now() - started) / 1000).toFixed(1) + ' s'), 100);
    return h('div', { class: 'running', role: 'status' },
      h('div', { class: 'spinner' }),
      h('span', null, 'Running on ' + state.connection + '\u2026'),
      elapsed,
      h('button', { onclick: () => vscode.postMessage({ type: 'cancel' }) }, 'Cancel'));
  }

  function doneView() {
    const r = state.result;
    const wrap = h('div', { class: 'results' });
    const count = r.statements.length + r.omitted;
    const parts = [r.connectionName, r.driverName, count === 1 ? '1 statement' : fmtInt(count) + ' statements', fmtMs(r.durationMs)];
    if (r.cancelled) parts.push('cancelled');
    if (r.omitted) parts.push(fmtInt(r.omitted) + ' quiet results not shown');
    wrap.append(h('div', { class: 'summary' }, parts.join(' \u00b7 ')));

    if (!r.statements.length) {
      wrap.append(h('div', { class: 'empty' }, h('strong', null, r.cancelled ? 'Cancelled' : 'Nothing to run'),
        r.cancelled ? 'The run was cancelled before the first statement.' : 'The editor has no SQL statements.'));
      return wrap;
    }
    if (r.statements.length > 1) wrap.append(tabsView(r));
    const s = r.statements[Math.min(tab, r.statements.length - 1)];
    wrap.append(statementView(s));
    return wrap;
  }

  function tabsView(r) {
    return h('div', { class: 'tabs', role: 'tablist' },
      ...r.statements.map((s, i) =>
        h('button', {
          class: 'tab' + (i === tab ? ' active' : '') + (s.error ? ' err' : ''),
          role: 'tab',
          'aria-selected': i === tab ? 'true' : 'false',
          title: s.sql,
          onclick: () => { tab = i; render(); },
        }, (i + 1) + '  ' + oneLine(s.sql, 32))));
  }

  function statementView(s) {
    const panel = h('div', { class: 'panel' });
    if (s.error) {
      panel.append(h('div', { class: 'msg' },
        h('div', { class: 'errorbox', role: 'alert' }, s.error.message + (s.error.code ? '\n(' + s.error.code + ')' : '')),
        h('div', { class: 'sql' }, s.sql)));
      return panel;
    }
    if (!s.columns.length) {
      const n = s.affectedRows;
      panel.append(h('div', { class: 'msg' },
        h('div', { class: 'okbox' }, n === undefined ? 'Statement executed' : n === 1 ? '1 row affected' : fmtInt(n) + ' rows affected', ' \u00b7 ' + fmtMs(s.durationMs)),
        (s.notices || []).map((t) => h('div', { class: 'sql' }, t)),
        h('div', { class: 'sql' }, s.sql)));
      return panel;
    }

    const vs = viewOf(s.index);
    const grid = createGrid(s, vs);
    const shown = h('span', { class: 'muted' });
    const toast = h('span', { class: 'toast', role: 'status' });
    const say = (t) => { toast.textContent = t; setTimeout(() => { if (toast.textContent === t) toast.textContent = ''; }, 1500); };
    grid.onCount((n) => { shown.textContent = n === s.rows.length ? '' : fmtInt(n) + ' of ' + fmtInt(s.rows.length) + ' rows match'; });

    panel.append(
      h('div', { class: 'toolbar' },
        h('input', {
          class: 'filter', type: 'search', placeholder: 'Filter rows', 'aria-label': 'Filter rows', value: vs.filter,
          oninput: (e) => { vs.filter = e.target.value; grid.refresh(); },
        }),
        shown,
        h('span', { class: 'spacer' }),
        toast,
        h('button', { class: 'ghost', title: 'Copy the rows shown, tab-separated', onclick: () => { vscode.postMessage({ type: 'copy', text: grid.tsv() }); say('Copied'); } }, 'Copy'),
        h('button', { class: 'ghost', title: 'Save the loaded rows as CSV', onclick: () => vscode.postMessage({ type: 'export', format: 'csv', index: s.index }) }, 'Export CSV'),
        h('button', { class: 'ghost', title: 'Save the loaded rows as JSON', onclick: () => vscode.postMessage({ type: 'export', format: 'json', index: s.index }) }, 'Export JSON')),
      grid.el,
      h('div', { class: 'footer' },
        fmtInt(s.rows.length) + (s.rows.length === 1 ? ' row' : ' rows') + ' \u00b7 ' + fmtMs(s.durationMs),
        s.truncated ? h('span', { class: 'warn' }, ' \u00b7 stopped at the row limit (betterSqlTools.results.maxRows)') : null));

    grid.copyCell = (text) => { vscode.postMessage({ type: 'copy', text }); say('Copied'); };
    return panel;
  }

  // ---- virtualised grid ----
  function createGrid(s, vs) {
    const cols = s.columns;
    const rows = s.rows;
    const widths = cols.map((c, i) => {
      let w = c.name.length + 4;
      for (let r = 0, n = Math.min(rows.length, 200); r < n; r++) {
        const v = rows[r][i];
        const len = v === null ? 4 : typeof v === 'object' ? 20 : String(v).length;
        if (len > w) w = len;
      }
      return Math.max(8, Math.min(48, w)) + 2;
    });
    const total = widths.reduce((a, b) => a + b, ROWNUM_CH);

    const header = h('div', { class: 'grow ghead' });
    const body = h('div', { class: 'gbody' });
    const inner = h('div', { class: 'grid-inner', style: { width: total + 'ch' } }, header, body);
    const el = h('div', { class: 'grid', tabindex: '0', role: 'grid', 'aria-rowcount': String(rows.length + 1) }, inner);

    let order = [];
    let lower = null; // lazily built per-row haystack for the filter
    let countCb = null;
    const api = { el, copyCell: null };

    function buildHeader() {
      header.replaceChildren(h('div', { class: 'cell rownum', style: { width: ROWNUM_CH + 'ch' } }, '#'));
      cols.forEach((c, i) => {
        const dir = vs.sort && vs.sort.col === i ? vs.sort.dir : 0;
        header.append(
          h('div', {
            class: 'cell hcell', role: 'columnheader', style: { width: widths[i] + 'ch' },
            title: c.name + (c.type ? ' (' + c.type + ')' : '') + '\nClick to sort',
            'aria-sort': dir === 0 ? 'none' : dir > 0 ? 'ascending' : 'descending',
            onclick: () => {
              vs.sort = !vs.sort || vs.sort.col !== i ? { col: i, dir: 1 } : vs.sort.dir === 1 ? { col: i, dir: -1 } : null;
              refresh();
            },
          }, h('span', { class: 'hname' }, c.name), dir ? h('span', { class: 'sort' }, dir > 0 ? '\u25B2' : '\u25BC') : null));
      });
    }

    function refresh() {
      const f = vs.filter.trim().toLowerCase();
      if (f && !lower) lower = rows.map((r) => r.map(cellText).join('\u0001').toLowerCase());
      order = [];
      for (let i = 0; i < rows.length; i++) if (!f || lower[i].includes(f)) order.push(i);
      if (vs.sort) {
        const col = vs.sort.col;
        const dir = vs.sort.dir;
        order.sort((x, y) => {
          const a = rows[x][col];
          const b = rows[y][col];
          if (a === null || b === null) return a === b ? x - y : a === null ? 1 : -1; // NULLs last either way
          return dir * compare(a, b) || x - y;
        });
      }
      buildHeader();
      inner.style.height = HEADER_H + order.length * ROW_H + 'px';
      el.scrollTop = 0;
      paint();
      if (countCb) countCb(order.length);
    }

    function paint() {
      const top = el.scrollTop;
      const view = el.clientHeight || 400;
      const first = Math.max(0, Math.floor((top - HEADER_H) / ROW_H) - BUFFER);
      const last = Math.min(order.length, Math.ceil((top + view) / ROW_H) + BUFFER);
      body.style.transform = 'translateY(' + (HEADER_H + first * ROW_H) + 'px)';
      const frag = document.createDocumentFragment();
      for (let k = first; k < last; k++) frag.append(rowEl(order[k], k));
      body.replaceChildren(frag);
    }

    function rowEl(ri, k) {
      const row = rows[ri];
      const r = h('div', { class: 'grow' + (k % 2 ? ' alt' : ''), role: 'row' },
        h('div', { class: 'cell rownum', style: { width: ROWNUM_CH + 'ch' } }, String(ri + 1)));
      for (let c = 0; c < cols.length; c++) {
        const f = fmt(row[c]);
        const selected = vs.selected && vs.selected.row === ri && vs.selected.col === c;
        r.append(h('div', {
          class: 'cell ' + f.cls + (selected ? ' sel' : ''), role: 'gridcell', style: { width: widths[c] + 'ch' },
          title: f.title, 'data-r': String(ri), 'data-c': String(c),
        }, f.text));
      }
      return r;
    }

    let raf = 0;
    el.addEventListener('scroll', () => {
      if (!raf) raf = requestAnimationFrame(() => { raf = 0; paint(); });
    });
    new ResizeObserver(() => paint()).observe(el);

    el.addEventListener('click', (e) => {
      const cell = e.target.closest ? e.target.closest('.cell[data-r]') : null;
      if (!cell) return;
      vs.selected = { row: Number(cell.dataset.r), col: Number(cell.dataset.c) };
      paint();
    });
    el.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && vs.selected && api.copyCell) {
        e.preventDefault();
        api.copyCell(cellText(rows[vs.selected.row][vs.selected.col]));
      }
    });

    api.refresh = refresh;
    api.onCount = (cb) => { countCb = cb; cb(order.length); };
    api.tsv = () => {
      const clean = (t) => t.replace(/[\t\r\n]+/g, ' ');
      const lines = [cols.map((c) => clean(c.name)).join('\t')];
      for (const i of order) lines.push(rows[i].map((v) => clean(cellText(v))).join('\t'));
      return lines.join('\n');
    };
    refresh();
    return api;
  }
}());
