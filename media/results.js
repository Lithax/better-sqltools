(function () {
  'use strict';

  const core = window.BstResults;
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  const ROW_H = 26;
  const HEAD_H = 32;
  const BUFFER = 10;
  const MIN_W = 40;
  const SAMPLE_ROWS = 300;
  const mod = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
  const fmtInt = core.fmtInt;

  let settings = { columnFit: 'fitNameAndValue', showTypes: true, colorByType: true };
  let state = { status: 'idle' };
  let tab = 0;
  let timer = null;
  let exportFormat = 'csv';
  let openPop = null; // the popover that is open, if any
  const views = new Map(); // statement index -> { sort, selected, widths, manual, filters, unlocked }
  const edits = new Map(); // statement index -> what the host says about editing it: editable, why not, mode, pending edits
  const live = new Map(); // statement index -> the grid on show, so replies from the host can reach it
  let editSeq = 0;

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

  const fmtMs = (ms) => (ms < 1 ? '<1 ms' : ms < 1000 ? Math.round(ms) + ' ms' : (ms / 1000).toFixed(2) + ' s');
  const oneLine = (s, n) => {
    const t = String(s).replace(/\s+/g, ' ').trim();
    return t.length > n ? t.slice(0, n - 1) + '\u2026' : t;
  };
  const icon = (name) => h('span', { class: 'codicon codicon-' + name, 'aria-hidden': 'true' });
  const iconButton = (name, label, onclick, extra) => h('button', Object.assign({ class: 'iconbtn', type: 'button', title: label, 'aria-label': label, onclick: onclick }, extra || {}), icon(name));

  function viewOf(index) {
    let v = views.get(index);
    if (!v) views.set(index, (v = { sort: null, selected: null, widths: null, manual: false, filters: new Map(), unlocked: false }));
    return v;
  }

  // ---- messages ----
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    if (m.type === 'settings') {
      const fitChanged = m.settings.columnFit !== settings.columnFit;
      const typesChanged = m.settings.showTypes !== settings.showTypes;
      settings = Object.assign({}, settings, m.settings);
      document.body.classList.toggle('typed', !!settings.colorByType);
      // a new mode sizes everything again; showing or hiding type labels changes what a header needs, which a hand-sized column should not undo
      if (fitChanged) views.forEach((v) => { v.widths = null; v.manual = false; });
      else if (typesChanged) views.forEach((v) => { if (!v.manual) v.widths = null; });
      render();
      return;
    }
    if (m.type === 'editStatus') {
      edits.set(m.index, m.status);
      const g = live.get(m.index);
      if (g) g.editsChanged();
      return;
    }
    if (m.type === 'editResult' || m.type === 'editEnd') {
      const g = live.get(m.index);
      if (g) (m.type === 'editResult' ? g.editResult : g.editEnd)(m);
      return;
    }
    if (m.type !== 'state') return;
    const prev = state;
    state = m.state;
    if (state.status === 'done') {
      const same = prev.status === 'done' && prev.result.startedAt === state.result.startedAt;
      if (!same) {
        tab = initialTab(state.result);
        views.clear();
        edits.clear();
      }
    }
    render();
  });
  document.body.classList.toggle('typed', !!settings.colorByType);
  render(); // show the idle state right away; the extension replies to `ready` with the real one
  vscode.postMessage({ type: 'ready' });

  function initialTab(result) {
    const list = result.statements;
    const err = list.findIndex((s) => s.error);
    if (err >= 0) return err;
    for (let i = list.length - 1; i >= 0; i--) if (list[i].columns.length) return i;
    return Math.max(0, list.length - 1);
  }

  // ---- popovers: the export dialog and the column-width menu ----
  function closePopover(refocus) {
    if (!openPop) return;
    const p = openPop;
    openPop = null;
    p.off();
    p.pop.remove();
    p.anchor.setAttribute('aria-expanded', 'false');
    if (refocus) p.anchor.focus();
  }

  function popover(anchor, label, content) {
    closePopover(false);
    const pop = h('div', { class: 'popover', role: 'dialog', 'aria-label': label }, ...content);
    pop.style.visibility = 'hidden';
    document.body.append(pop);
    const r = anchor.getBoundingClientRect();
    const w = pop.offsetWidth;
    const ph = pop.offsetHeight;
    const left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8));
    const below = r.bottom + 4;
    pop.style.left = left + 'px';
    pop.style.top = (below + ph > window.innerHeight - 8 ? Math.max(8, r.top - ph - 4) : below) + 'px';
    pop.style.visibility = '';

    const onDown = (e) => { if (!pop.contains(e.target) && !anchor.contains(e.target)) closePopover(false); };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closePopover(true); return; }
      if (e.key === 'Tab') { // keep focus in the popover
        const items = [...pop.querySelectorAll('button, input')].filter((x) => !x.disabled);
        if (!items.length) return;
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
      }
    };
    document.addEventListener('mousedown', onDown, true);
    document.addEventListener('keydown', onKey, true);
    anchor.setAttribute('aria-expanded', 'true');
    openPop = { pop: pop, anchor: anchor, off: () => { document.removeEventListener('mousedown', onDown, true); document.removeEventListener('keydown', onKey, true); } };
    return pop;
  }

  const FIT_LABELS = {
    fitAll: ['Fit all columns to the panel', 'Equal widths, whatever the names and values are'],
    fitName: ['Fit column names', 'As wide as each name and type'],
    fitNameAndValue: ['Fit names and values', 'Wide enough for both, up to a limit'],
  };

  function fitMenu(anchor, grid) {
    const items = core.FIT_MODES.map((mode) =>
      h('button', {
        class: 'menuitem', type: 'button', role: 'menuitemradio', 'aria-checked': mode === settings.columnFit ? 'true' : 'false',
        onclick: () => {
          closePopover(true);
          if (mode === settings.columnFit) { grid.fit(); return; }
          settings.columnFit = mode;
          views.forEach((v) => { v.widths = null; v.manual = false; });
          vscode.postMessage({ type: 'setColumnFit', mode: mode }); // the setting is the one source of truth
          grid.fit();
        },
      }, h('span', { class: 'tick' }, mode === settings.columnFit ? icon('check') : null),
      h('span', null, FIT_LABELS[mode][0], h('span', { class: 'desc' }, FIT_LABELS[mode][1]))));
    const pop = popover(anchor, 'Column widths', [h('h2', null, 'Column widths'), h('div', { class: 'sub' }, 'Drag a column border to size one by hand; double-click it to fit that column.'), ...items]);
    const checked = pop.querySelector('[aria-checked="true"]') || pop.querySelector('button');
    if (checked) checked.focus();
  }

  function exportDialog(anchor, s, grid, say) {
    const n = grid.count();
    const rows = n === 1 ? '1 row' : fmtInt(n) + ' rows';
    const radios = [['csv', 'CSV'], ['json', 'JSON']].map((f) =>
      h('label', { class: 'opt' },
        h('input', { type: 'radio', name: 'format', value: f[0], checked: exportFormat === f[0], onchange: () => { exportFormat = f[0]; } }), f[1]));
    const send = (action) => {
      closePopover(true);
      vscode.postMessage({ type: 'export', format: exportFormat, action: action, index: s.index, rows: grid.order() });
      if (action === 'copy') say('Copied');
    };
    const pop = popover(anchor, 'Export rows', [
      h('h2', null, 'Export rows'),
      h('div', { class: 'sub' }, rows + ', as shown'),
      h('fieldset', null, h('legend', { class: 'sr' }, 'Format'), ...radios),
      h('div', { class: 'actions' },
        h('button', { type: 'button', onclick: () => closePopover(true) }, 'Cancel'),
        h('button', { type: 'button', onclick: () => send('copy') }, 'Copy'),
        h('button', { type: 'button', class: 'primary', onclick: () => send('save') }, 'Save as\u2026')),
    ]);
    const checked = pop.querySelector('input:checked');
    if (checked) checked.focus();
  }

  /**
   * The filter dialog of one column: its distinct values with counts, to tick. Typing keeps only the values that match.
   * What is unticked is what the column hides; ticking everything removes the filter.
   */
  function filterDialog(anchor, grid, col, name) {
    const MAX_SHOWN = 200;
    const list = grid.candidates(col);
    const had = grid.hidden(col);
    let hidden = new Set(had || []);
    let saved = null; // the selection from before a search began, back when the search is cleared
    let query = '';

    const matches = () => core.searchValues(list, query);
    const search = h('input', {
      type: 'search', class: 'search', placeholder: 'Type to keep only matching values', 'aria-label': 'Search values', autocomplete: 'off', spellcheck: 'false',
      oninput: () => {
        if (!query.trim() && search.value.trim()) saved = new Set(hidden);
        query = search.value;
        if (query.trim()) {
          const keep = new Set(matches().map((e) => e.key));
          hidden = new Set(list.filter((e) => !keep.has(e.key)).map((e) => e.key));
        } else if (saved) {
          hidden = saved;
          saved = null;
        }
        draw();
      },
    });
    const all = h('input', {
      type: 'checkbox', class: 'selectall',
      onchange: () => {
        matches().forEach((e) => { if (all.checked) hidden.delete(e.key); else hidden.add(e.key); });
        draw();
      },
    });
    const allCount = h('span', { class: 'vcount' });
    const vlist = h('div', { class: 'vlist', role: 'group', 'aria-label': 'Values' });
    const more = h('div', { class: 'sub more' });
    const clear = h('button', { type: 'button', disabled: !(had && had.size), onclick: () => finish(null) }, 'Clear filter');
    const apply = h('button', { type: 'button', class: 'primary', onclick: () => finish(hidden) }, 'Apply');

    function finish(next) {
      const hides = next && list.some((e) => next.has(e.key));
      closePopover(false);
      grid.setFilter(col, hides ? next : null);
      grid.focusFilter(col);
    }

    function syncAll() {
      const m = matches();
      const kept = m.filter((e) => !hidden.has(e.key)).length;
      all.checked = m.length > 0 && kept === m.length;
      all.indeterminate = kept > 0 && kept < m.length;
      all.disabled = !m.length;
      allCount.textContent = fmtInt(kept) + ' of ' + fmtInt(m.length);
      apply.disabled = !list.some((e) => !hidden.has(e.key)); // keeping nothing is not a filter, it is an empty grid
    }

    function draw() {
      const m = matches();
      vlist.replaceChildren(...m.slice(0, MAX_SHOWN).map((e) => {
        const cb = h('input', {
          type: 'checkbox', checked: !hidden.has(e.key),
          onchange: () => { if (cb.checked) hidden.delete(e.key); else hidden.add(e.key); syncAll(); },
        });
        const text = e.key === null ? 'NULL' : core.describe(e.value).text;
        return h('label', { class: 'vopt', title: e.key === null ? 'NULL' : core.describe(e.value).title },
          cb, h('span', { class: 'vtext' + (e.key === null ? ' null' : '') }, text), h('span', { class: 'vcount' }, fmtInt(e.count)));
      }));
      more.textContent = !m.length ? 'No values match.' : m.length > MAX_SHOWN ? 'Showing the first ' + MAX_SHOWN + ' of ' + fmtInt(m.length) + ' values. Type to narrow the list.' : '';
      syncAll();
    }

    const n = list.length;
    const pop = popover(anchor, 'Filter ' + name, [
      h('h2', null, 'Filter ', h('span', { class: 'colname' }, name)),
      h('div', { class: 'sub' }, fmtInt(n) + (n === 1 ? ' value' : ' values') + (grid.otherFilters(col) ? ', in the rows the other filters leave' : '')),
      search,
      h('div', { class: 'vbox' }, h('label', { class: 'vopt all' }, all, h('span', { class: 'vtext' }, '(Select all)'), allCount), vlist),
      more,
      h('div', { class: 'actions' }, clear, h('button', { type: 'button', onclick: () => closePopover(true) }, 'Cancel'), apply),
    ]);
    pop.classList.add('filterpop');
    pop.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target === search && !apply.disabled) { e.preventDefault(); apply.click(); } });
    draw();
    search.focus();
  }

  // ---- views ----
  function render() {
    closePopover(false);
    live.clear();
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
    const summary = parts.join(' \u00b7 ');

    if (!r.statements.length) {
      wrap.append(h('div', { class: 'summary' }, summary),
        h('div', { class: 'empty' }, h('strong', null, r.cancelled ? 'Cancelled' : 'Nothing to run'),
          r.cancelled ? 'The run was cancelled before the first statement.' : 'The editor has no SQL statements.'));
      return wrap;
    }
    if (r.statements.length > 1) wrap.append(tabsView(r));
    const s = r.statements[Math.min(tab, r.statements.length - 1)];
    wrap.append(statementView(s, summary));
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

  function statementView(s, summary) {
    const panel = h('div', { class: 'panel' });
    if (s.error) {
      panel.append(h('div', { class: 'summary' }, summary), h('div', { class: 'msg' },
        h('div', { class: 'errorbox', role: 'alert' }, s.error.message + (s.error.code ? '\n(' + s.error.code + ')' : '')),
        h('div', { class: 'sql' }, s.sql)));
      return panel;
    }
    if (!s.columns.length) {
      const n = s.affectedRows;
      panel.append(h('div', { class: 'summary' }, summary), h('div', { class: 'msg' },
        h('div', { class: 'okbox' }, n === undefined ? 'Statement executed' : n === 1 ? '1 row affected' : fmtInt(n) + ' rows affected', ' \u00b7 ' + fmtMs(s.durationMs)),
        (s.notices || []).map((t) => h('div', { class: 'sql' }, t)),
        h('div', { class: 'sql' }, s.sql)));
      return panel;
    }

    const vs = viewOf(s.index);
    const grid = createGrid(s, vs);
    const shown = h('span', { class: 'muted' });
    const toast = h('span', { class: 'toast', role: 'status' });
    const say = (t, ms, bad) => {
      toast.textContent = t;
      toast.classList.toggle('bad', !!bad);
      setTimeout(() => { if (toast.textContent === t) { toast.textContent = ''; toast.classList.remove('bad'); } }, ms || 1500);
    };

    const fitBtn = iconButton('arrow-both', 'Column widths', () => fitMenu(fitBtn, grid), { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });
    const clearBtn = iconButton('clear-all', 'Clear all filters', () => grid.clearFilters());
    const copyBtn = iconButton('copy', 'Copy the rows shown, tab-separated', () => {
      vscode.postMessage({ type: 'export', format: 'tsv', action: 'copy', index: s.index, rows: grid.order() });
      say('Copied');
    });
    const exportBtn = iconButton('export', 'Export the rows shown\u2026', () => exportDialog(exportBtn, s, grid, say), { 'aria-haspopup': 'dialog', 'aria-expanded': 'false' });

    const bar = editBar(s, vs, grid, say);
    const toolbar = h('div', { class: 'toolbar' }, h('span', { class: 'runinfo', title: summary }, summary), shown, h('span', { class: 'spacer' }), toast, ...bar.nodes, fitBtn, copyBtn, exportBtn);
    // what the filters leave is said in words, and the way back to everything is offered only while a filter is on
    grid.onCount((n) => {
      shown.textContent = n === s.rows.length ? '' : fmtInt(n) + ' of ' + fmtInt(s.rows.length) + ' rows match';
      if (grid.filtered()) { if (!clearBtn.isConnected) toolbar.insertBefore(clearBtn, fitBtn); } else clearBtn.remove();
    });

    panel.append(
      toolbar,
      grid.el,
      h('div', { class: 'footer' },
        fmtInt(s.rows.length) + (s.rows.length === 1 ? ' row' : ' rows') + ' \u00b7 ' + fmtMs(s.durationMs),
        s.truncated ? h('span', { class: 'warn' }, ' \u00b7 stopped at the row limit (betterSqlTools.results.maxRows)') : null));

    grid.copyCell = (text) => { vscode.postMessage({ type: 'copy', text: text }); say('Copied'); };
    grid.say = say;
    grid.onEditStatus = bar.update;
    live.set(s.index, grid);
    bar.update();
    return panel;
  }

  /**
   * The lock, and in manual mode Commit and Roll back. The page only asks: whether a value is accepted, and what the database
   * ends up holding, is the host's to say. A result the host says cannot be edited keeps its lock shut and says why.
   */
  function editBar(s, vs, grid, say) {
    const lock = iconButton('lock', 'Locked', () => {
      const st = edits.get(s.index);
      if (!st || !st.editable) { say('Read-only: ' + ((st && st.reason) || 'these rows cannot be edited.'), 5000); return; }
      vs.unlocked = !vs.unlocked;
      grid.lockChanged();
      update();
    }, { 'aria-pressed': 'false' });
    const count = h('span', { class: 'pendingcount' });
    const commit = h('button', { class: 'txnbtn primary', type: 'button', title: 'Make the pending edits final', onclick: () => vscode.postMessage({ type: 'commit', index: s.index }) }, icon('check'), 'Commit');
    const rollback = h('button', { class: 'txnbtn', type: 'button', title: 'Undo every pending edit', onclick: () => vscode.postMessage({ type: 'rollback', index: s.index }) }, icon('discard'), 'Roll back');

    function update() {
      const st = edits.get(s.index);
      lock.style.display = st ? '' : 'none'; // nothing is known until the host has looked at the result
      if (st) {
        const ok = !!st.editable;
        const on = ok && vs.unlocked;
        lock.replaceChildren(icon(on ? 'unlock' : 'lock'));
        lock.classList.toggle('disabled', !ok);
        lock.setAttribute('aria-disabled', ok ? 'false' : 'true');
        lock.setAttribute('aria-pressed', on ? 'true' : 'false');
        const label = !ok ? 'Read-only: ' + (st.reason || 'these rows cannot be edited.')
          : on ? 'Editing is on. Double-click a cell or press Enter to change it. Click to lock again.'
            : 'Locked. Click to edit the values in this grid.';
        const full = label + (ok && st.note ? ' ' + st.note : '');
        lock.title = full;
        lock.setAttribute('aria-label', full);
      }
      const n = st ? st.pending.length : 0;
      const open = !!st && (st.transaction || n > 0);
      count.style.display = commit.style.display = rollback.style.display = open ? '' : 'none';
      count.textContent = n === 1 ? '1 pending edit' : n + ' pending edits';
    }
    return { nodes: [count, commit, rollback, lock], update: update };
  }

  // ---- measuring text, to fit columns ----
  // (jsdom has no canvas; estimating there keeps the page testable)
  const measureCtx = /jsdom/i.test(navigator.userAgent) ? null : document.createElement('canvas').getContext('2d');
  function textWidth(text, font) {
    if (!measureCtx) return String(text).length * 7.5;
    measureCtx.font = font;
    return measureCtx.measureText(text).width;
  }
  function fonts() {
    const cs = getComputedStyle(document.documentElement);
    const v = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    const uiSize = v('--vscode-font-size', '13px');
    const uiFamily = v('--vscode-font-family', 'sans-serif');
    const px = parseFloat(uiSize) || 13;
    return {
      cell: v('--vscode-editor-font-weight', 'normal') + ' ' + v('--vscode-editor-font-size', '13px') + ' ' + v('--vscode-editor-font-family', 'monospace'),
      head: '600 ' + uiSize + ' ' + uiFamily,
      type: Math.max(9, px * 0.85) + 'px ' + uiFamily,
      pill: '700 ' + Math.max(8, px * 0.72) + 'px ' + uiFamily,
    };
  }
  const nextFrame = (fn) => (window.requestAnimationFrame || ((f) => setTimeout(f, 16)))(fn);

  // ---- the grid: virtualised rows, columns sized in pixels ----
  function createGrid(s, vs) {
    const cols = s.columns;
    const rows = s.rows;
    const kinds = cols.map((c, i) => core.columnKind(c, rows, i));
    const facts = cols.map((c) => core.columnFacts(c));
    const rowNumWidth = () => Math.max(44, Math.ceil(textWidth(String(rows.length), fonts().cell)) + 24);
    let rowNumW = rowNumWidth();

    const header = h('div', { class: 'grow ghead' });
    const body = h('div', { class: 'gbody' });
    const inner = h('div', { class: 'grid-inner' }, header, body);
    const el = h('div', { class: 'grid', tabindex: '0', role: 'grid', 'aria-rowcount': String(rows.length + 1) }, inner);

    let order = rows.map((_, i) => i); // row indexes in the order they are shown
    let headerCells = [];
    let countCb = null;
    let lastClientWidth = 0;
    const api = { el: el, copyCell: null, say: null, onEditStatus: null };
    const totalWidth = () => rowNumW + vs.widths.reduce((a, b) => a + b, 0);

    /** What each column needs: for its header, and for the widest of the first rows' values. */
    function measure() {
      const f = fonts();
      const head = cols.map((c, i) => {
        let w = 24 + textWidth(c.name, f.head) + 18 + 8 + 24; // padding, the sort arrow, the resize handle, the filter button
        if (settings.showTypes && c.type) w += textWidth(c.type, f.type) + 6;
        facts[i].pills.forEach((p) => { w += textWidth(p.text, f.pill) + 16; });
        return w;
      });
      const vals = cols.map((_, i) => {
        let widest = 0;
        for (let r = 0, n = Math.min(rows.length, SAMPLE_ROWS); r < n; r++) widest = Math.max(widest, textWidth(core.describe(rows[r][i]).text, f.cell));
        return widest + 24;
      });
      return { head: head, vals: vals };
    }

    /** Sizes every column by the current mode. */
    function fit() {
      rowNumW = rowNumWidth();
      const m = measure();
      const known = el.clientWidth; // 0 until the grid is on screen; fit-all is corrected once it is
      vs.widths = core.fitWidths({ mode: settings.columnFit, headerPx: m.head, valuePx: m.vals, available: known ? known - rowNumW : 800 });
      vs.manual = false;
      layout();
    }

    function fitColumn(i) {
      const m = measure();
      vs.widths[i] = core.fitWidths({ mode: 'fitNameAndValue', headerPx: [m.head[i]], valuePx: [m.vals[i]] })[0];
      vs.manual = true;
      layout();
    }

    function layout() {
      inner.style.width = totalWidth() + 'px';
      buildHeader();
      paint();
    }

    function setWidth(i, w) {
      vs.widths[i] = Math.max(MIN_W, Math.round(w));
      vs.manual = true;
      headerCells[i].style.width = vs.widths[i] + 'px';
      inner.style.width = totalWidth() + 'px';
      schedulePaint();
    }

    let painting = 0;
    function schedulePaint() {
      if (!painting) painting = nextFrame(() => { painting = 0; paint(); });
    }

    function startResize(e, i, handle) {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      e.stopPropagation();
      const startX = e.clientX;
      const startW = vs.widths[i];
      handle.classList.add('active');
      if (handle.setPointerCapture && e.pointerId !== undefined) handle.setPointerCapture(e.pointerId);
      const move = (ev) => setWidth(i, startW + (ev.clientX - startX));
      const up = () => {
        handle.classList.remove('active');
        handle.removeEventListener('pointermove', move);
        handle.removeEventListener('pointerup', up);
        handle.removeEventListener('pointercancel', up);
      };
      handle.addEventListener('pointermove', move);
      handle.addEventListener('pointerup', up);
      handle.addEventListener('pointercancel', up);
    }

    function buildHeader() {
      header.replaceChildren(h('div', { class: 'cell rownum', style: { width: rowNumW + 'px' } }, '#'));
      headerCells = [];
      cols.forEach((c, i) => {
        const dir = vs.sort && vs.sort.col === i ? vs.sort.dir : 0;
        const toggleSort = () => {
          vs.sort = !vs.sort || vs.sort.col !== i ? { col: i, dir: 1 } : vs.sort.dir === 1 ? { col: i, dir: -1 } : null;
          refresh();
        };
        const resizer = h('div', {
          class: 'resizer', role: 'separator', 'aria-orientation': 'vertical', tabindex: '0',
          'aria-label': 'Resize column ' + c.name, title: 'Drag to resize. Double-click to fit this column.',
          onpointerdown: (e) => startResize(e, i, resizer),
          ondblclick: (e) => { e.stopPropagation(); fitColumn(i); },
          onclick: (e) => e.stopPropagation(),
          onkeydown: (e) => {
            const step = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
            if (!step) return;
            e.preventDefault();
            e.stopPropagation();
            setWidth(i, vs.widths[i] + step * (e.shiftKey ? 50 : 10));
          },
        });
        const hiddenKeys = vs.filters.get(i);
        const active = !!(hiddenKeys && hiddenKeys.size);
        const filterBtn = h('button', {
          class: 'filterbtn' + (active ? ' on' : ''), type: 'button',
          'aria-label': 'Filter column ' + c.name + (active ? ', filtered' : ''),
          title: active ? 'Filtered: ' + fmtInt(hiddenKeys.size) + (hiddenKeys.size === 1 ? ' value' : ' values') + ' hidden. Click to change.' : 'Filter by value (Alt+Down)',
          'aria-haspopup': 'dialog', 'aria-expanded': 'false',
          onclick: (e) => { e.stopPropagation(); toggleFilter(i, filterBtn); },
        }, icon(active ? 'filter-filled' : 'filter'));
        const cell = h('div', {
          class: 'cell hcell k-' + kinds[i] + (active ? ' filtered' : ''), role: 'columnheader', tabindex: '0', style: { width: vs.widths[i] + 'px' },
          title: core.columnTitle(c), 'aria-sort': dir === 0 ? 'none' : dir > 0 ? 'ascending' : 'descending',
          onclick: toggleSort,
          onkeydown: (e) => {
            if (e.target !== cell) return;
            if (e.altKey && e.key === 'ArrowDown') { e.preventDefault(); toggleFilter(i, filterBtn); }
            else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleSort(); }
          },
        },
        h('span', { class: 'hname' }, c.name),
        settings.showTypes && c.type ? h('span', { class: 'htype' }, c.type) : null,
        ...facts[i].pills.map((p) => h('span', { class: 'pill ' + p.text.toLowerCase(), title: p.title }, p.text)),
        dir ? h('span', { class: 'sort' }, icon(dir > 0 ? 'arrow-up' : 'arrow-down')) : null,
        filterBtn,
        resizer);
        headerCells.push(cell);
        header.append(cell);
      });
    }

    const allRows = () => rows.map((_, i) => i);

    function toggleFilter(col, anchor) {
      if (openPop && openPop.anchor === anchor) { closePopover(true); return; }
      filterDialog(anchor, api, col, cols[col].name);
    }

    function refresh() {
      order = core.applyFilters(rows, allRows(), vs.filters);
      if (vs.sort) order = core.sortOrder(rows, order, vs.sort.col, vs.sort.dir);
      buildHeader();
      inner.style.height = HEAD_H + order.length * ROW_H + 'px';
      el.scrollTop = 0;
      paint();
      if (countCb) countCb(order.length);
    }

    function paint() {
      const top = el.scrollTop;
      const view = el.clientHeight || 400;
      const first = Math.max(0, Math.floor((top - HEAD_H) / ROW_H) - BUFFER);
      const last = Math.min(order.length, Math.ceil((top + view) / ROW_H) + BUFFER);
      body.style.transform = 'translateY(' + (HEAD_H + first * ROW_H) + 'px)';
      pendingKeys = pendingSet();
      const hadFocus = !!editing && document.activeElement === editing.input;
      const frag = document.createDocumentFragment();
      for (let k = first; k < last; k++) frag.append(rowEl(order[k]));
      repainting = true; // taking the editor out of the page for a moment must not read as the person leaving it
      body.replaceChildren(frag);
      repainting = false;
      if (hadFocus && editing && editing.input.isConnected) editing.input.focus();
    }

    function rowEl(ri) {
      const row = rows[ri];
      const r = h('div', { class: 'grow', role: 'row' }, h('div', { class: 'cell rownum', style: { width: rowNumW + 'px' } }, String(ri + 1)));
      for (let c = 0; c < cols.length; c++) {
        const f = core.describe(row[c]);
        const col = cols[c];
        const selected = vs.selected && vs.selected.row === ri && vs.selected.col === c;
        const here = !!editing && editing.row === ri && editing.col === c;
        const pending = pendingKeys.has(ri + ':' + c);
        r.append(h('div', {
          class: 'cell ' + f.cls + ' k-' + kinds[c] + (col.primaryKey ? ' c-pk' : '') + (col.foreignKey ? ' c-fk' : '') + (selected ? ' sel' : '')
            + (canEditCell(c) ? ' editable' : '') + (pending ? ' pending' : '') + (here ? ' editing' : ''),
          role: 'gridcell', style: { width: vs.widths[c] + 'px' }, title: pending ? f.title + '\n(changed, not committed yet)' : f.title, 'data-r': String(ri), 'data-c': String(c),
        }, here ? editing.el : f.text));
      }
      return r;
    }

    // ---- editing: the lock decides whether a cell may be changed, the host whether a value is accepted ----
    let editing = null; // { row, col, el, input, original, wasNull, busy, id, refocus }
    let pendingKeys = new Set();
    let repainting = false;
    const editInfo = () => edits.get(s.index);
    const tell = (text, ms, bad) => { if (api.say) api.say(text, ms, bad); };
    const pendingSet = () => { const st = editInfo(); return new Set(st ? st.pending.map((p) => p.row + ':' + p.col) : []); };
    function canEditCell(c) {
      const st = editInfo();
      return !!(vs.unlocked && st && st.editable && st.columns[c] && st.columns[c].editable);
    }

    function startEdit(ri, c) {
      const st = editInfo();
      if (!vs.unlocked || !st || !st.editable || (editing && editing.busy)) return;
      if (editing && editing.row === ri && editing.col === c) return; // already open (a click pair can also be followed by a dblclick)
      if (!canEditCell(c)) { tell((st.columns[c] && st.columns[c].reason) || 'This column cannot be edited.', 4000); return; }
      const v = rows[ri][c];
      if (typeof v === 'object' && v !== null) { tell('Binary values cannot be edited here.', 4000); return; }
      const text = v === null ? '' : core.cellText(v);
      const input = h('input', { class: 'cell-input', type: 'text', spellcheck: 'false', autocomplete: 'off', 'aria-label': 'Edit ' + cols[c].name, placeholder: v === null ? 'NULL' : null });
      input.value = text;
      const kids = [input];
      if (!cols[c].notNull) {
        kids.push(h('button', { class: 'nullbtn', type: 'button', tabindex: '-1', title: 'Set to NULL', onmousedown: (e) => e.preventDefault(), onclick: () => submit(true, true) }, 'NULL'));
      }
      editing = { row: ri, col: c, el: h('div', { class: 'cell-edit' }, ...kids), input: input, original: text, wasNull: v === null, busy: false, id: 0, refocus: false };
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submit(false, true); }
        else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (editing && !editing.busy) { cancelEdit(); el.focus(); } }
      });
      // leaving the editor keeps what was typed, as in VS Code's own settings editor; Escape is the way to drop it
      input.addEventListener('blur', () => { if (!repainting && editing && editing.input === input && !editing.busy) submit(false, false); });
      input.addEventListener('input', () => { input.removeAttribute('aria-invalid'); input.removeAttribute('title'); });
      vs.selected = { row: ri, col: c };
      paint();
      input.focus();
      input.select();
    }

    function cancelEdit() {
      if (!editing) return;
      editing = null;
      paint();
    }

    /** Sends what was typed (null for NULL). Nothing changes on the page until the host has answered. */
    function submit(asNull, refocus) {
      const ed = editing;
      if (!ed || ed.busy) return;
      const value = asNull ? null : ed.input.value;
      if (asNull ? ed.wasNull : value === ed.original) { // nothing differs from what is there
        cancelEdit();
        if (refocus) el.focus();
        return;
      }
      ed.busy = true;
      ed.refocus = refocus;
      ed.input.readOnly = true;
      ed.id = ++editSeq;
      vscode.postMessage({ type: 'edit', index: s.index, row: ed.row, col: ed.col, value: value, id: ed.id });
    }

    let raf = 0;
    el.addEventListener('scroll', () => {
      if (!raf) raf = nextFrame(() => { raf = 0; paint(); });
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(() => {
        const w = el.clientWidth;
        if (w && w !== lastClientWidth) {
          lastClientWidth = w;
          if (settings.columnFit === 'fitAll' && !vs.manual) { fit(); return; }
        }
        paint();
      }).observe(el);
    }

    el.addEventListener('click', (e) => {
      if (e.target.closest && e.target.closest('.cell-edit')) return; // a click inside the editor is the editor's
      const cell = e.target.closest ? e.target.closest('.cell[data-r]') : null;
      if (!cell) return;
      const r = Number(cell.dataset.r);
      const c = Number(cell.dataset.c);
      // A double click is the second click on the selected cell. The browser's own `dblclick` cannot be the only trigger: the first click
      // repaints the grid, the clicked element is gone by the second one, and Chromium then never fires `dblclick`.
      if (e.detail === 2 && vs.selected && vs.selected.row === r && vs.selected.col === c) { startEdit(r, c); return; }
      vs.selected = { row: r, col: c };
      paint();
    });
    el.addEventListener('dblclick', (e) => {
      if (e.target.closest && e.target.closest('.cell-edit')) return;
      const cell = e.target.closest ? e.target.closest('.cell[data-r]') : null;
      if (cell) startEdit(Number(cell.dataset.r), Number(cell.dataset.c));
    });

    /** Moves the selected cell, keeping it in view. */
    function moveSelection(dr, dc) {
      if (!order.length) return;
      let k;
      let c;
      if (!vs.selected) { // the first key press selects the first cell rather than moving away from it
        k = 0;
        c = 0;
      } else {
        k = Math.max(0, Math.min(order.length - 1, Math.max(0, order.indexOf(vs.selected.row)) + dr));
        c = Math.max(0, Math.min(cols.length - 1, vs.selected.col + dc));
      }
      vs.selected = { row: order[k], col: c };
      const rowTop = HEAD_H + k * ROW_H;
      if (rowTop < el.scrollTop + HEAD_H) el.scrollTop = rowTop - HEAD_H;
      else if (rowTop + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = rowTop + ROW_H - el.clientHeight;
      const left = rowNumW + vs.widths.slice(0, c).reduce((a, b) => a + b, 0);
      if (left < el.scrollLeft + rowNumW) el.scrollLeft = left - rowNumW;
      else if (left + vs.widths[c] > el.scrollLeft + el.clientWidth) el.scrollLeft = left + vs.widths[c] - el.clientWidth;
      paint();
    }

    el.addEventListener('keydown', (e) => {
      if (e.target !== el) return; // keys on a header cell or a resize handle are theirs
      if ((e.key === 'Enter' || e.key === 'F2') && vs.unlocked && vs.selected) {
        e.preventDefault();
        startEdit(vs.selected.row, vs.selected.col);
        return;
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c' && vs.selected && api.copyCell) {
        e.preventDefault();
        api.copyCell(core.cellText(rows[vs.selected.row][vs.selected.col]));
        return;
      }
      const page = Math.max(1, Math.floor((el.clientHeight - HEAD_H) / ROW_H) - 1);
      const move = { ArrowDown: [1, 0], ArrowUp: [-1, 0], ArrowRight: [0, 1], ArrowLeft: [0, -1], PageDown: [page, 0], PageUp: [-page, 0], Home: [0, -1e6], End: [0, 1e6] }[e.key];
      if (move) {
        e.preventDefault();
        moveSelection(move[0], move[1]);
      }
    });

    // what the host tells the page about editing: the status, the answer to an edit, and how a commit or rollback ended
    api.editsChanged = () => {
      if (editing && !editing.busy && !canEditCell(editing.col)) editing = null;
      paint();
      if (api.onEditStatus) api.onEditStatus();
    };
    api.lockChanged = () => {
      if (!vs.unlocked && editing && !editing.busy) editing = null;
      paint();
    };
    api.editResult = (m) => {
      const ed = editing;
      const mine = !!ed && ed.id === m.id;
      if (m.ok) {
        if (m.changed && rows[m.row]) rows[m.row][m.col] = m.value; // the value as the database holds it now
        if (mine) editing = null;
        paint();
        if (mine && ed.refocus) el.focus();
        return;
      }
      tell(m.error, 6000, true);
      if (!mine) return;
      ed.busy = false;
      ed.input.readOnly = false;
      ed.input.setAttribute('aria-invalid', 'true');
      ed.input.title = m.error;
      if (ed.input.isConnected) ed.input.focus();
    };
    api.editEnd = (m) => {
      if (!m.ok) { tell(m.error, 6000, true); return; }
      (m.restored || []).forEach((r) => { if (rows[r.row]) rows[r.row][r.col] = r.value; });
      if (m.count) tell((m.kind === 'commit' ? 'Committed ' : 'Rolled back ') + m.count + (m.count === 1 ? ' edit' : ' edits'), 2500);
      paint();
    };
    api.refresh = refresh;
    api.fit = fit;
    api.order = () => order.slice();
    api.count = () => order.length;
    api.onCount = (cb) => { countCb = cb; cb(order.length); };
    // filters: what a column's dialog needs. A column's list only holds values that exist under the OTHER columns' filters and
    // Apply needs one ticked, so the filters can never leave the grid empty.
    /** The values a column can still show: those among the rows the OTHER columns' filters leave. */
    api.candidates = (col) => core.distinctValues(rows, core.applyFilters(rows, allRows(), vs.filters, col), col);
    api.hidden = (col) => vs.filters.get(col);
    api.otherFilters = (col) => [...vs.filters].some(([c, set]) => c !== col && set.size > 0);
    api.filtered = () => [...vs.filters.values()].some((set) => set.size > 0);
    api.setFilter = (col, hidden) => {
      if (hidden && hidden.size) vs.filters.set(col, hidden); else vs.filters.delete(col);
      refresh();
    };
    api.clearFilters = () => { vs.filters.clear(); refresh(); };
    api.focusFilter = (col) => { const b = headerCells[col] && headerCells[col].querySelector('.filterbtn'); if (b) b.focus(); };
    if (!vs.widths || vs.widths.length !== cols.length) fit(); else layout();
    refresh();
    return api;
  }
}());
