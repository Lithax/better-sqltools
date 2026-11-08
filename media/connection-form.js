(function () {
  'use strict';

  const vscode = acquireVsCodeApi();
  const root = document.getElementById('root');

  let init = null;
  let busy = null; // 'test' | 'save' | null
  let notice = null; // { kind: 'ok' | 'error', text }
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
        draft.name = m.profile.name;
        draft.driver = m.profile.driver;
        draft.scope = m.profile.scope;
        draft.options = Object.assign({}, m.profile.options);
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

    const driverSelect = h('select', {
      id: 'driver', disabled: editing(),
      onchange: (e) => { draft.driver = e.target.value; draft.options = {}; draft.secrets = {}; notice = null; render(); },
    }, ...init.drivers.map((x) => h('option', { value: x.id }, x.displayName)));
    driverSelect.value = draft.driver;
    form.append(h('div', { class: 'field' }, h('label', { for: 'driver' }, 'Driver'), driverSelect,
      d && d.description ? h('div', { class: 'hint' }, d.description) : null));

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
}());
