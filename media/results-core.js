/*
 * The results page's logic that needs no DOM: how a value is shown, what kind a column is, how wide columns should be,
 * in what order rows come. Loaded before results.js in the webview and `require`d directly by the tests.
 * Plain script, no modules, because a webview page has no loader.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.BstResults = api;
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const MAX_TEXT = 500;
  const MAX_TITLE = 2000;
  const fmtInt = (n) => Number(n).toLocaleString();

  /** A value as plain text (what copy and filters work on). */
  function cellText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'object') return '0x' + v.$blob + (v.$blob.length / 2 < v.bytes ? '\u2026' : '');
    return String(v);
  }

  /** How a value is shown: its text, a class for its storage type, and a tooltip. */
  function describe(v) {
    if (v === null || v === undefined) return { text: 'NULL', cls: 'null', title: 'NULL' };
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
      title: s.length > MAX_TITLE ? s.slice(0, MAX_TITLE) + '\u2026' : s,
    };
  }

  /** The kind of a single value, judged by what it is, not by what a database calls it. */
  function kindOfValue(v) {
    if (v === null || v === undefined) return null;
    if (typeof v === 'number') return Number.isInteger(v) ? 'integer' : 'decimal';
    if (typeof v === 'boolean') return 'boolean';
    if (typeof v === 'object') return 'binary';
    return 'text';
  }

  /**
   * The kind of a column. The driver's word is final; only when it gave none do the values decide, and only when they
   * agree. Mixed values (a column SQLite allows to hold anything) get no kind rather than a wrong one.
   */
  function columnKind(column, rows, index) {
    if (column.kind) return column.kind;
    let kind = null;
    for (let r = 0, n = Math.min(rows.length, 200); r < n; r++) {
      const k = kindOfValue(rows[r][index]);
      if (k === null) continue;
      if (kind === null) kind = k;
      else if (kind !== k) {
        if ((kind === 'integer' && k === 'decimal') || (kind === 'decimal' && k === 'integer')) kind = 'decimal';
        else return 'other';
      }
    }
    return kind || 'other';
  }

  /** What is worth saying about a column in its header: the pills and the tooltip lines. */
  function columnFacts(c) {
    const pills = [];
    const lines = [];
    if (c.primaryKey) { pills.push({ text: 'PK', title: 'Primary key' }); lines.push('primary key'); }
    if (c.foreignKey) {
      const to = c.foreignKey.table + (c.foreignKey.column ? '.' + c.foreignKey.column : '');
      pills.push({ text: 'FK', title: 'Foreign key to ' + to });
      lines.push('references ' + to);
    }
    if (c.unique) { pills.push({ text: 'UQ', title: 'Unique' }); lines.push('unique'); }
    if (c.notNull === true) lines.push('not null');
    if (c.notNull === false && !c.primaryKey) lines.push('nullable');
    if (c.autoIncrement) lines.push('filled in by the database when left out');
    if (c.defaultValue !== undefined) lines.push('default ' + c.defaultValue);
    return { pills: pills, lines: lines };
  }

  function columnTitle(c) {
    const facts = columnFacts(c).lines;
    return c.name + (c.type ? ' (' + c.type + ')' : '') + (facts.length ? '\n' + facts.join('\n') : '') + '\nClick to sort';
  }

  /** Orders two cells: numbers as numbers, everything else as text with embedded numbers compared numerically. */
  function compareCells(a, b) {
    if (typeof a === 'number' && typeof b === 'number') return a - b;
    return cellText(a).localeCompare(cellText(b), undefined, { numeric: true, sensitivity: 'base' });
  }

  /** `order` (row indexes) sorted by column `col`; NULLs last in either direction, ties kept in their original order. */
  function sortOrder(rows, order, col, dir) {
    return order.slice().sort(function (x, y) {
      const a = rows[x][col];
      const b = rows[y][col];
      if (a === null || b === null) return a === b ? x - y : a === null ? 1 : -1;
      return dir * compareCells(a, b) || x - y;
    });
  }

  const FIT_MODES = ['fitAll', 'fitName', 'fitNameAndValue'];

  /** What a filter sees of a value: NULL stays null, everything else is its text. (So 1 and '1' are one value.) */
  function filterKey(v) {
    return v === null || v === undefined ? null : cellText(v);
  }

  /**
   * The distinct values of column `col` among the rows in `order`, with how often each occurs.
   * Natural order (numbers as numbers), NULL last. `value` is the first value seen for a key, for display and ordering.
   */
  function distinctValues(rows, order, col) {
    const seen = new Map();
    for (let k = 0; k < order.length; k++) {
      const v = rows[order[k]][col];
      const key = filterKey(v);
      const hit = seen.get(key);
      if (hit) hit.count++;
      else seen.set(key, { key: key, count: 1, value: v === undefined ? null : v });
    }
    return [...seen.values()].sort(function (a, b) {
      if (a.key === null || b.key === null) return a.key === b.key ? 0 : a.key === null ? 1 : -1;
      return compareCells(a.value, b.value);
    });
  }

  /** The values whose text contains `text` (case-insensitive). NULL is found by typing "null". */
  function searchValues(list, text) {
    const q = String(text || '').trim().toLowerCase();
    if (!q) return list;
    return list.filter(function (e) { return (e.key === null ? 'null' : e.key.toLowerCase()).indexOf(q) !== -1; });
  }

  /**
   * The rows of `order` that pass every filter. `filters` maps a column index to the set of keys (see filterKey) it hides;
   * columns combine with AND. `skipCol` leaves one column's filter out, which is how a column's own value list is made.
   */
  function applyFilters(rows, order, filters, skipCol) {
    const active = [];
    filters.forEach(function (hidden, col) { if (col !== skipCol && hidden.size) active.push([col, hidden]); });
    if (!active.length) return order;
    return order.filter(function (ri) {
      const row = rows[ri];
      for (let f = 0; f < active.length; f++) if (active[f][1].has(filterKey(row[active[f][0]]))) return false;
      return true;
    });
  }

  /**
   * Column widths in pixels.
   *  - fitAll: every column gets the same share of `available`, whatever its name or values are.
   *  - fitName: wide enough for the header (`headerPx`).
   *  - fitNameAndValue: wide enough for the header and the widest sampled value (`valuePx`), but never wider than `max`,
   *    so one huge value cannot swallow the grid.
   * Every width is at least `min`. `fitName` and `fitNameAndValue` are capped at `max`.
   */
  function fitWidths(o) {
    const min = o.min === undefined ? 56 : o.min;
    const max = o.max === undefined ? 420 : o.max;
    const n = o.headerPx.length;
    const clamp = function (w) { return Math.max(min, Math.min(max, Math.ceil(w))); };
    if (o.mode === 'fitAll') {
      const share = Math.max(min, Math.floor((o.available || 0) / Math.max(1, n)));
      const spare = (o.available || 0) >= share * n ? (o.available || 0) - share * n : 0;
      return o.headerPx.map(function (_, i) { return share + (i < spare ? 1 : 0); }); // the leftover pixels go to the first columns
    }
    if (o.mode === 'fitName') return o.headerPx.map(clamp);
    return o.headerPx.map(function (h, i) { return clamp(Math.max(h, (o.valuePx && o.valuePx[i]) || 0)); });
  }

  return {
    FIT_MODES: FIT_MODES, MAX_TEXT: MAX_TEXT, cellText: cellText, describe: describe, kindOfValue: kindOfValue, columnKind: columnKind,
    columnFacts: columnFacts, columnTitle: columnTitle, compareCells: compareCells, sortOrder: sortOrder, fitWidths: fitWidths, fmtInt: fmtInt,
    filterKey: filterKey, distinctValues: distinctValues, searchValues: searchValues, applyFilters: applyFilters,
  };
}));
