// The "Inspect connection" page: what the core measured plus what the driver reports. No innerHTML: values come from drivers.
(function () {
  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');
  let data;
  let receivedAt = 0;

  function h(tag, props, ...kids) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : String(v));
    }
    for (const kid of kids.flat()) if (kid) e.append(kid);
    return e;
  }

  const number = (n, digits = 0) => n.toLocaleString(undefined, { maximumFractionDigits: digits });

  function duration(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const parts = [[Math.floor(s / 86400), 'd'], [Math.floor((s % 86400) / 3600), 'h'], [Math.floor((s % 3600) / 60), 'm'], [s % 60, 's']];
    const shown = parts.filter(([n]) => n > 0).slice(0, 3);
    return shown.length ? shown.map(([n, u]) => n + u).join(' ') : '0s';
  }

  function value(item) {
    const dd = h('dd', { class: [item.status, item.mono ? 'mono' : ''].filter(Boolean).join(' '), title: item.hint });
    if (item.value === null || item.value === undefined) dd.textContent = '\u2014';
    else if (typeof item.value === 'boolean') dd.textContent = item.value ? 'yes' : 'no';
    else if (typeof item.value === 'number') dd.textContent = number(item.value, 1);
    else dd.textContent = String(item.value);
    if (item.unit && item.value !== null && item.value !== undefined) dd.append(h('span', { class: 'unit', text: item.unit }));
    if (item.attr) dd.setAttribute(item.attr, '');
    return dd;
  }

  function card(title, items) {
    const dl = h('dl');
    for (const it of items) dl.append(h('dt', { text: it.label }), value(it));
    return h('section', { class: 'card' }, h('h2', { text: title }), dl);
  }

  function ago(at) {
    return duration(Date.now() - at) + ' ago';
  }

  function sessionItems(d) {
    const st = d.stats;
    const items = [
      { label: 'Uptime', value: duration(d.uptimeMs + (Date.now() - receivedAt)), attr: 'data-uptime' },
      { label: 'Connected since', value: new Date(st.connectedAt).toLocaleString() },
      { label: 'Statements run', value: st.statements },
      { label: 'Errors', value: st.errors, status: st.errors ? 'warning' : undefined },
      { label: 'Rows fetched', value: st.rows },
    ];
    if (st.statements) items.push({ label: 'Average time', value: st.totalMs / st.statements, unit: 'ms' });
    if (st.lastAt !== undefined) items.push({ label: 'Last statement', value: `${number(st.lastMs, 1)} ms, ${ago(st.lastAt)}` });
    if (st.lastError) items.push({ label: 'Last error', value: st.lastError, status: 'error' });
    if (d.pingMs !== undefined) items.push({ label: 'Round trip', value: d.pingMs, unit: 'ms' });
    return items;
  }

  const HEALTH = { ok: 'Healthy', warning: 'Needs attention', error: 'Problem', unknown: 'No health data' };

  function render() {
    root.replaceChildren();
    if (!data) return;
    if (data.unavailable) {
      root.append(h('p', { class: 'empty', text: data.unavailable }));
      return;
    }
    const health = data.driver ? data.driver.health : { status: 'unknown', summary: data.driverError ? 'The driver could not be inspected: ' + data.driverError : 'This driver does not report on the database itself.' };
    root.append(
      h('div', { class: 'head' },
        h('div', {}, h('h1', { text: data.name }), h('span', { class: 'muted', text: data.driverName })),
        h('div', { class: 'actions' },
          h('button', { id: 'refresh', onclick: () => vscode.postMessage({ type: 'refresh' }), text: 'Refresh' }),
          h('button', { id: 'copy', onclick: () => vscode.postMessage({ type: 'copy' }), text: 'Copy as JSON' }))),
      h('div', { class: 'health ' + health.status, role: 'status' }, h('strong', { text: HEALTH[health.status] || health.status }), h('span', { text: health.summary })),
      h('div', { class: 'grid' },
        card('Session', sessionItems(data)),
        ...(data.driver ? data.driver.sections.map((s) => card(s.title, s.items)) : [])));
  }

  window.addEventListener('message', (ev) => {
    const m = ev.data;
    if (m.type === 'inspection') {
      data = m.data;
      receivedAt = Date.now();
      render();
    } else if (m.type === 'unavailable') {
      data = { unavailable: m.message };
      render();
    }
  });

  // the uptime counts on its own between refreshes
  setInterval(() => {
    const dd = root.querySelector('[data-uptime]');
    if (dd && data && !data.unavailable) dd.textContent = duration(data.uptimeMs + (Date.now() - receivedAt));
  }, 1000);

  vscode.postMessage({ type: 'ready' });
})();
