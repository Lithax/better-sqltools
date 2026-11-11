(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  let init = null;
  let busy = null; // 'test' | 'save' | null
  let notice = null; // { kind: 'ok' | 'error', text }
  let unavailable = []; // installed drivers that cannot be used right now
  let picker = null; // the driver picker while it is open
  const draft = { name: '', driver: '', scope: 'user', options: {}, secrets: {}, saveSecrets: true };

  function h(tag, attrs) {
    const el = document.createElement(tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === undefined || v === null || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'value') el.value = v;
        else if (k === 'checked') el.checked = !!v;
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

  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m) return;
    switch (m.type) {
      case 'init':
        init = m;
        unavailable = m.unavailable || [];
        draft.name = m.profile.name;
        draft.driver = m.profile.driver;
        draft.scope = m.profile.scope;
        draft.options = Object.assign({}, m.profile.options);
        render();
        break;
      case 'drivers': // one was installed or removed while the form is open
        if (!init) break;
        init.drivers = m.drivers;
        unavailable = m.unavailable || [];
        if (picker) picker.update();
        render();
        break;
      case 'testResult':
        busy = null;
        notice = { kind: m.ok ? 'ok' : 'error', text: m.message };
        render();
        break;
      case 'saveError':
        busy = null;
        notice = { kind: 'error', text: m.message };
        render();
        break;
      case 'browsed':
        draft.options[m.key] = m.path;
        render();
        break;
    }
  });
  vscode.postMessage({ type: 'ready' });

  const driver = () => init.drivers.find((d) => d.id === draft.driver);
  const editing = () => init.mode === 'edit';

  function payload() {
    const options = {};
    for (const k of Object.keys(draft.options)) {
      const v = draft.options[k];
      if (v !== '' && v !== undefined && v !== null) options[k] = v;
    }
    const secrets = {};
    for (const k of Object.keys(draft.secrets)) if (draft.secrets[k] !== '') secrets[k] = draft.secrets[k];
    return { name: draft.name.trim(), driver: draft.driver, scope: draft.scope, options, secrets, saveSecrets: draft.saveSecrets };
  }

  function localProblems(requireName) {
    const problems = [];
    const d = driver();
    if (requireName && !draft.name.trim()) problems.push('Give the connection a name.');
    if (!d) problems.push('Pick a driver.');
    else {
      for (const f of d.connectionSchema) {
        if (f.type === 'password' || !f.required) continue;
        const v = draft.options[f.key];
        if ((v === undefined || v === '') && f.default === undefined) problems.push('"' + f.label + '" is required.');
      }
    }
    return problems;
  }

  function submit(kind) {
    const problems = localProblems(kind === 'save');
    if (problems.length) {
      notice = { kind: 'error', text: problems.join('\n') };
      render();
      return;
    }
    busy = kind;
    notice = null;
    render();
    vscode.postMessage({ type: kind, draft: payload() });
  }

  function fieldView(f) {
    const id = 'f-' + f.key;
    const hint = f.description ? h('div', { class: 'hint', id: id + '-hint' }, f.description) : null;
    const described = f.description ? id + '-hint' : null;

    if (f.type === 'boolean') {
      const value = draft.options[f.key] === undefined ? !!f.default : draft.options[f.key] === true || draft.options[f.key] === 'true';
      return h('div', { class: 'field' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', id, checked: value, 'aria-describedby': described, onchange: (e) => (draft.options[f.key] = e.target.checked) }),
          h('span', null, h('span', { class: 'label' }, f.label), hint ? h('div', { class: 'hint' }, f.description) : null)));
    }

    const label = h('label', { for: id }, f.label, f.required && f.type !== 'password' ? h('span', { class: 'req', 'aria-hidden': 'true' }, ' *') : null);
    let input;
    if (f.type === 'select') {
      const value = draft.options[f.key] === undefined ? f.default : draft.options[f.key];
      input = h('select', { id, 'aria-describedby': described, onchange: (e) => (draft.options[f.key] = e.target.value) },
        ...(f.options || []).map((o) => h('option', { value: o.value }, o.label)));
      input.value = value === undefined ? (f.options && f.options[0] ? f.options[0].value : '') : String(value);
      draft.options[f.key] = input.value;
    } else if (f.type === 'password') {
      const stored = editing() && init.storedSecrets.indexOf(f.key) >= 0;
      input = h('input', {
        type: 'password', id, autocomplete: 'new-password', value: draft.secrets[f.key] || '', 'aria-describedby': described,
        placeholder: stored ? 'Saved. Type to replace it.' : f.required ? 'Asked when you connect, if left empty' : '',
        oninput: (e) => (draft.secrets[f.key] = e.target.value),
      });
    } else {
      const common = {
        id, 'aria-describedby': described, placeholder: f.placeholder || (f.default !== undefined ? 'Default: ' + f.default : ''),
        value: draft.options[f.key] === undefined ? '' : String(draft.options[f.key]),
        oninput: (e) => (draft.options[f.key] = e.target.value),
      };
      input = h('input', Object.assign({ type: f.type === 'number' ? 'number' : 'text', min: f.min, max: f.max }, common));
      if (f.type === 'file') {
        return h('div', { class: 'field' }, label,
          h('div', { class: 'row' }, input,
            h('button', { type: 'button', onclick: () => vscode.postMessage({ type: 'browse', key: f.key }) }, 'Browse\u2026')),
          hint);
      }
    }
    return h('div', { class: 'field' }, label, input, hint);
  }

  function render() {
    root.replaceChildren();
    if (!init) return;
    const d = driver();
    const hasSecret = !!d && d.connectionSchema.some((f) => f.type === 'password');

    const form = h('form', { novalidate: true, onsubmit: (e) => { e.preventDefault(); submit('save'); } });
    form.append(
      h('h1', null, editing() ? 'Edit connection' : 'New connection'),
      h('p', { class: 'lead' }, editing() ? 'Changes are saved to your settings. Passwords stay in VS Code\u2019s secret storage.' : 'Pick a driver, fill in the details and test the connection before saving.'));

    const current = d || null;
    const driverBox = h('div', { class: 'input-with-icon' },
      current ? driverIcon(current, 16) : null,
      h('input', {
        type: 'text', id: 'driver', readonly: true, class: editing() ? 'locked' : null, 'aria-describedby': 'driver-hint',
        value: current ? current.displayName : '', placeholder: 'No driver selected',
      }));
    form.append(h('div', { class: 'field' },
      h('label', { for: 'driver' }, 'Driver'),
      h('div', { class: 'row' }, driverBox,
        h('button', { type: 'button', id: 'choose-driver', disabled: editing(), onclick: openPicker }, 'Choose\u2026')),
      h('div', { class: 'hint', id: 'driver-hint' },
        editing() ? 'A connection keeps its driver. Create a new connection to use another one.' : current ? current.description : 'Choose the database driver this connection uses.')));

    form.append(h('div', { class: 'field' },
      h('label', { for: 'name' }, 'Name', h('span', { class: 'req', 'aria-hidden': 'true' }, ' *')),
      h('input', { type: 'text', id: 'name', value: draft.name, placeholder: 'Local development database', oninput: (e) => (draft.name = e.target.value) })));

    if (d) {
      form.append(h('hr'));
      for (const f of d.connectionSchema) form.append(fieldView(f));
    }

    if (hasSecret) {
      form.append(h('div', { class: 'field' },
        h('label', { class: 'check' },
          h('input', { type: 'checkbox', checked: draft.saveSecrets, onchange: (e) => (draft.saveSecrets = e.target.checked) }),
          h('span', null, h('span', { class: 'label' }, 'Remember password'),
            h('div', { class: 'hint' }, 'Stored encrypted by VS Code. Untick to be asked every time you connect.')))));
    }

    if (init.canUseWorkspace) {
      form.append(h('hr'), h('fieldset', null,
        h('legend', null, 'Save in'),
        ...[['user', 'User settings', 'available in every window'], ['workspace', 'Workspace settings', 'shared with this project through .vscode/settings.json']].map((o) =>
          h('label', { class: 'radio' },
            h('input', { type: 'radio', name: 'scope', value: o[0], checked: draft.scope === o[0], onchange: () => (draft.scope = o[0]) }),
            h('span', null, o[1], h('span', { class: 'muted' }, ' \u2013 ' + o[2]))))));
    }

    if (notice) form.append(h('div', { class: 'notice ' + notice.kind, role: notice.kind === 'error' ? 'alert' : 'status' }, notice.text));

    form.append(h('div', { class: 'actions' },
      h('button', { type: 'submit', class: 'primary', disabled: !!busy }, busy === 'save' ? 'Saving\u2026' : 'Save'),
      h('button', { type: 'button', disabled: !!busy, onclick: () => submit('test') }, busy === 'test' ? 'Testing\u2026' : 'Test connection'),
      h('button', { type: 'button', class: 'ghost', onclick: () => vscode.postMessage({ type: 'cancel' }) }, 'Cancel')));

    root.append(form);
  }

  // ---- driver picker --------------------------------------------------------------------------

  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** A plain database glyph for drivers that ship no image icon. */
  function glyph(size) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', String(size));
    svg.setAttribute('height', String(size));
    svg.setAttribute('class', 'dicon glyph');
    svg.setAttribute('aria-hidden', 'true');
    for (const d of ['M8 1.5c-2.9 0-5 .9-5 2s2.1 2 5 2 5-.9 5-2-2.1-2-5-2z', 'M3 3.5v9c0 1.1 2.1 2 5 2s5-.9 5-2v-9', 'M3 8c0 1.1 2.1 2 5 2s5-.9 5-2']) {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', 'currentColor');
      p.setAttribute('stroke-width', '1');
      svg.append(p);
    }
    return svg;
  }

  /** The driver's own icon (one per theme kind if it ships two), else the glyph. */
  function driverIcon(entry, size) {
    const data = entry.iconData;
    if (!data) return glyph(size);
    const img = (src, cls) => h('img', { class: 'dicon ' + cls, src, alt: '', width: size, height: size });
    return data.light === data.dark ? img(data.dark, '') : h('span', { class: 'dicon-pair' }, img(data.light, 'for-light'), img(data.dark, 'for-dark'));
  }

  function openPicker() {
    if (picker || !init) return;
    let query = '';
    let selected = draft.driver;

    const matches = (d) => {
      const q = query.trim().toLowerCase();
      return !q || [d.displayName, d.id, d.description || ''].some((s) => s.toLowerCase().indexOf(q) >= 0);
    };
    const choose = (id) => { selected = id; paint(); focusSelected(); };
    const focusSelected = () => { const el = list.querySelector('.driver-card.selected'); if (el) el.focus(); };

    const card = (d) => {
      const on = d.id === selected;
      return h('button', {
        type: 'button', role: 'option', class: 'driver-card' + (on ? ' selected' : ''), 'aria-selected': on ? 'true' : 'false',
        tabindex: on ? '0' : '-1', 'data-id': d.id, title: d.description || d.displayName,
        onclick: () => choose(d.id),
        ondblclick: () => { selected = d.id; confirm(); },
      }, driverIcon(d, 32), h('span', { class: 'driver-name' }, d.displayName), h('span', { class: 'driver-id muted' }, d.id));
    };
    const missing = (d) =>
      h('div', { class: 'driver-card unavailable', role: 'option', 'aria-disabled': 'true', title: d.error || d.description || d.displayName },
        driverIcon(d, 32), h('span', { class: 'driver-name' }, d.displayName),
        h('span', { class: 'driver-id muted' }, d.state === 'failed' ? 'Failed to load' : 'Not loaded'));

    const search = h('input', { type: 'search', placeholder: 'Search drivers', 'aria-label': 'Search drivers', oninput: (e) => { query = e.target.value; paint(); } });
    const list = h('div', { class: 'driver-grid', role: 'listbox', 'aria-label': 'Drivers' });
    const count = h('div', { class: 'muted picker-count', role: 'status' });
    const select = h('button', { type: 'button', class: 'primary', onclick: () => confirm() }, 'Select');
    const overlay = h('div', { class: 'overlay', onmousedown: (e) => { if (e.target === overlay) close(); } });

    function paint() {
      const usable = init.drivers.filter(matches);
      const others = unavailable.filter(matches);
      list.replaceChildren(...usable.map(card), ...others.map(missing));
      if (!list.querySelector('[tabindex="0"]')) { const first = list.querySelector('.driver-card[tabindex]'); if (first) first.setAttribute('tabindex', '0'); }
      count.textContent = usable.length + others.length === 0
        ? (query ? 'No driver matches \u201c' + query.trim() + '\u201d.' : 'No drivers are installed.')
        : usable.length + (usable.length === 1 ? ' driver' : ' drivers') + (others.length ? ', ' + others.length + ' not available' : '');
      select.disabled = !init.drivers.some((d) => d.id === selected);
    }

    function confirm() {
      const d = init.drivers.find((x) => x.id === selected);
      if (!d) return;
      close();
      if (d.id !== draft.driver) {
        draft.driver = d.id;
        draft.options = {};
        draft.secrets = {};
        notice = null;
        render();
      }
    }

    function close() {
      overlay.remove();
      picker = null;
      const back = document.getElementById('choose-driver');
      if (back) back.focus();
    }

    function move(delta) {
      const cards = [...list.querySelectorAll('button.driver-card')];
      if (!cards.length) return;
      const at = cards.findIndex((c) => c.getAttribute('data-id') === selected);
      const next = Math.max(0, Math.min(cards.length - 1, (at < 0 ? 0 : at) + delta));
      choose(cards[next].getAttribute('data-id'));
    }
    const columns = () => {
      const cards = [...list.querySelectorAll('button.driver-card')];
      return Math.max(1, cards.filter((c) => c.offsetTop === (cards[0] ? cards[0].offsetTop : 0)).length);
    };

    function keys(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); return; }
      if (e.key === 'Tab') { // keep focus inside the dialog
        const items = [...dialog.querySelectorAll('input, button')].filter((x) => !x.disabled && x.getAttribute('tabindex') !== '-1');
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
        else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
        return;
      }
      const onCard = e.target.classList && e.target.classList.contains('driver-card');
      const onSearch = e.target === search;
      if (e.key === 'Enter' && (onCard || onSearch) && !select.disabled) { e.preventDefault(); confirm(); return; }
      if (!onCard && !(onSearch && e.key === 'ArrowDown')) return;
      const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns(), ArrowUp: -columns() }[e.key];
      if (step !== undefined) { e.preventDefault(); move(onSearch ? 0 : step); }
    }

    const dialog = h('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'picker-title', onkeydown: keys },
      h('h2', { id: 'picker-title' }, 'Select a driver'),
      search, list, count,
      h('div', { class: 'dialog-actions' },
        h('button', { type: 'button', onclick: () => vscode.postMessage({ type: 'findDrivers' }) }, 'Install more drivers\u2026'),
        h('span', { class: 'spacer' }),
        h('button', { type: 'button', onclick: () => close() }, 'Cancel'),
        select));
    overlay.append(dialog);
    document.body.append(overlay);
    picker = { update: paint };
    paint();
    search.focus();
  }
}());
