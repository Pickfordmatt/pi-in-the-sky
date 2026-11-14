'use strict';
// Full-screen pages: settings, models & roles, omp subcommands, files. Uses helpers from app.js (loaded after this file; used only at call time).

// The UI composes children with `cond ? el : null`. Native replaceChildren() would render such a null as
// the text "null", so skip null/false/undefined the same way the h() helper does. (pages.js loads first.)
{
  const native = Element.prototype.replaceChildren;
  Element.prototype.replaceChildren = function (...nodes) {
    return native.apply(this, nodes.filter((n) => n != null && n !== false));
  };
}

// ---------------------------------------------------------------- ANSI -> DOM
const ANSI16 = ['#000000', '#cd3131', '#0dbc79', '#e5e510', '#2472c8', '#bc3fbc', '#11a8cd', '#e5e5e5', '#666666', '#f14c4c', '#23d18b', '#f5f543', '#3b8eea', '#d670d6', '#29b8db', '#e5e5e5'];
function ansi256(n) {
  if (n < 16) return ANSI16[n];
  if (n < 232) { n -= 16; const c = (v) => (v ? 55 + v * 40 : 0); return `rgb(${c(Math.floor(n / 36))},${c(Math.floor(n / 6) % 6)},${c(n % 6)})`; }
  const g = 8 + (n - 232) * 10; return `rgb(${g},${g},${g})`;
}
function ansiToEl(text) {
  const root = document.createElement('span');
  let st = {};
  const re = /\x1b\[([0-9;:]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
  let last = 0, m;
  const emit = (t) => {
    if (!t) return;
    const s = document.createElement('span');
    s.textContent = t;
    if (st.fg) s.style.color = st.fg;
    if (st.bg) s.style.background = st.bg;
    if (st.bold) s.style.fontWeight = '700';
    if (st.dim) s.style.opacity = '.7';
    if (st.italic) s.style.fontStyle = 'italic';
    if (st.ul) s.style.textDecoration = 'underline';
    root.append(s);
  };
  while ((m = re.exec(text))) {
    emit(text.slice(last, m.index));
    last = re.lastIndex;
    if (m[2] !== 'm') continue;
    const p = (m[1] || '0').split(/[;:]/).map(Number);
    for (let i = 0; i < p.length; i++) {
      const c = p[i];
      if (c === 0) st = {};
      else if (c === 1) st.bold = true; else if (c === 2) st.dim = true; else if (c === 3) st.italic = true; else if (c === 4) st.ul = true;
      else if (c === 22) { st.bold = false; st.dim = false; } else if (c === 23) st.italic = false; else if (c === 24) st.ul = false;
      else if (c >= 30 && c <= 37) st.fg = ANSI16[c - 30]; else if (c >= 90 && c <= 97) st.fg = ANSI16[c - 90 + 8]; else if (c === 39) st.fg = null;
      else if (c >= 40 && c <= 47) st.bg = ANSI16[c - 40]; else if (c >= 100 && c <= 107) st.bg = ANSI16[c - 100 + 8]; else if (c === 49) st.bg = null;
      else if ((c === 38 || c === 48) && p[i + 1] === 5) { const col = ansi256(p[i + 2] || 0); c === 38 ? (st.fg = col) : (st.bg = col); i += 2; }
      else if ((c === 38 || c === 48) && p[i + 1] === 2) { const col = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`; c === 38 ? (st.fg = col) : (st.bg = col); i += 4; }
    }
  }
  emit(text.slice(last));
  return root;
}

// ---------------------------------------------------------------- page shell
function page(title, body, { wide = true, actions = [] } = {}) {
  const pg = $('#page');
  pg.hidden = false;
  pg.replaceChildren(
    h('div', { class: 'page-head' }, h('strong', { text: title }), h('span', { class: 'grow' }), ...actions, h('button', { text: 'Close', onclick: closePage })),
    h('div', { class: 'page-body' }, body));
}
function closePage() { $('#page').hidden = true; $('#page').replaceChildren(); }

// ---------------------------------------------------------------- settings
const settingsState = { items: [], group: null, q: '', optionsReady: false, version: '' };

async function settingsPage() {
  page('omp settings', h('div', { class: 'muted pad', text: 'Loading all settings from omp…' }));
  let d;
  try { d = await http('GET', '/api/settings'); } catch (e) { return page('omp settings', h('div', { class: 'err pad', text: e.message })); }
  Object.assign(settingsState, { items: d.items, optionsReady: d.optionsReady, version: d.version });
  renderSettingsPage();
  if (!d.optionsReady) pollOptions(0);
}
async function pollOptions(n) {
  if (n > 30 || $('#page').hidden) return;
  await new Promise((r) => setTimeout(r, 2000));
  try {
    const d = await http('GET', '/api/settings');
    if (d.optionsReady) {
      const mod = new Map(settingsState.items.map((i) => [i.key, i.value]));
      Object.assign(settingsState, { items: d.items, optionsReady: true });
      if ($('#page').querySelector('.settings') && !document.activeElement?.closest('.srow')) renderSettingsRows();
      return;
    }
  } catch {}
  pollOptions(n + 1);
}
function groupOf(key) { const i = key.indexOf('.'); return i < 0 ? 'general' : key.slice(0, i); }

function renderSettingsPage() {
  const groups = new Map();
  for (const it of settingsState.items) { const g = groupOf(it.key); groups.set(g, (groups.get(g) || 0) + 1); }
  const names = [...groups.keys()].sort((a, b) => (a === 'general' ? -1 : b === 'general' ? 1 : a.localeCompare(b)));
  if (!settingsState.group) settingsState.group = names[0];
  const search = h('input', { type: 'search', placeholder: `Search ${settingsState.items.length} settings…`, value: settingsState.q, oninput: (e) => { settingsState.q = e.target.value; renderSettingsRows(); renderGroups(); } });
  const gl = h('div', { class: 'groups' });
  const renderGroups = () => gl.replaceChildren(...names.map((n) => h('div', { class: 'item' + (n === settingsState.group && !settingsState.q ? ' sel' : ''), onclick: () => { settingsState.group = n; settingsState.q = ''; search.value = ''; renderGroups(); renderSettingsRows(); } },
    h('span', { text: n }), h('span', { class: 'muted', text: groups.get(n) }))));
  renderGroups();
  page(`omp settings · ${settingsState.version}`, h('div', { class: 'settings' }, h('div', { class: 'sidecol' }, search, gl), h('div', { class: 'rows', id: 'settingsRows' })), {
    actions: [h('button', { text: 'Edit config.yml', onclick: async () => { const p = await http('GET', '/api/omp/paths'); filesPage(p.configFile); } })],
  });
  renderSettingsRows();
}

function renderSettingsRows() {
  const box = $('#settingsRows'); if (!box) return;
  const q = settingsState.q.trim().toLowerCase();
  let items = settingsState.items;
  items = q ? items.filter((i) => i.key.toLowerCase().includes(q) || i.description.toLowerCase().includes(q)) : items.filter((i) => groupOf(i.key) === settingsState.group);
  const shown = items.slice(0, 300);
  box.replaceChildren(...shown.map(settingRow), items.length > 300 ? h('div', { class: 'muted pad', text: `${items.length - 300} more — refine the search` }) : null);
}

async function saveSetting(it, value, rowEl) {
  try {
    const r = await http('PUT', '/api/settings', { key: it.key, value, type: it.type });
    it.value = r.value !== undefined ? r.value : value;
    it.modified = true;
    rowEl.classList.add('saved'); setTimeout(() => rowEl.classList.remove('saved'), 900);
    refreshRow(it, rowEl);
  } catch (e) { toast(`${it.key}: ${e.message}`, 'error', 8000); }
}
async function resetSetting(it, rowEl) {
  try {
    const r = await http('DELETE', '/api/settings/' + encodeURIComponent(it.key));
    it.value = r.value; it.modified = false; refreshRow(it, rowEl);
    toast(`Reset ${it.key}`);
  } catch (e) { toast(e.message, 'error'); }
}
function refreshRow(it, rowEl) { const n = settingRow(it); rowEl.replaceWith(n); }

function settingRow(it) {
  const row = h('div', { class: 'srow' + (it.modified ? ' mod' : '') });
  let ed;
  const save = (v) => saveSetting(it, v, row);
  if (it.type === 'boolean') ed = h('input', { type: 'checkbox', checked: !!it.value, onchange: (e) => save(e.target.checked) });
  else if (it.type === 'enum' && it.options) ed = h('select', { onchange: (e) => save(e.target.value) }, ...[...new Set([...(it.options || []), it.value])].filter((v) => v != null).map((o) => h('option', { value: o, text: o, selected: o === it.value })));
  else if (it.type === 'number') ed = h('input', { type: 'number', step: 'any', value: it.value ?? '', onchange: (e) => e.target.value !== '' && save(Number(e.target.value)) });
  else if (it.type === 'array' || it.type === 'record') {
    const ta = h('textarea', { rows: Math.min(8, Math.max(2, JSON.stringify(it.value ?? (it.type === 'array' ? [] : {}), null, 2).split('\n').length)), spellcheck: 'false' });
    ta.value = JSON.stringify(it.value ?? (it.type === 'array' ? [] : {}), null, 2);
    const btn = h('button', { text: 'Save', onclick: () => { try { JSON.parse(ta.value); } catch (e) { return toast('Invalid JSON: ' + e.message, 'error'); } save(ta.value); } });
    ed = h('div', { class: 'jsonedit' }, ta, btn);
  } else ed = h('input', { type: 'text', value: it.value ?? '', placeholder: it.value == null ? '(unset)' : '', onchange: (e) => save(e.target.value) });
  row.append(
    h('div', { class: 'sk' }, h('code', { text: it.key }), it.modified ? h('span', { class: 'badge', text: 'modified' }) : null, h('span', { class: 'muted', text: it.type })),
    h('div', { class: 'sd muted', text: it.description || '' }),
    h('div', { class: 'se' }, ed, it.modified ? h('button', { text: 'Reset', title: 'Back to default', onclick: () => resetSetting(it, row) }) : null));
  return row;
}

// ---------------------------------------------------------------- models & roles
const ROLE_HINTS = { default: 'Main model', smol: 'Fast/cheap tasks', slow: 'Deep reasoning', plan: 'Planning', advisor: 'Reviews each turn', commit: 'omp commit', title: 'Session titles', vision: 'Image description' };
async function modelsPage() {
  page('Models & roles', h('div', { class: 'muted pad', text: 'Loading model catalog…' }));
  let cat, set;
  try {
    [cat, set] = await Promise.all([http('GET', '/api/omp/models?kind=all').catch(() => http('GET', '/api/omp/models')), http('GET', '/api/settings')]);
  } catch (e) { return page('Models & roles', h('div', { class: 'err pad', text: e.message })); }
  const item = (k) => set.items.find((i) => i.key === k);
  const roles = { ...(item('modelRoles')?.value || {}) };
  const disabled = new Set(item('disabledProviders')?.value || []);
  const models = cat.models || [];
  const selectors = models.filter((m) => m.kind === 'chat' || !m.kind).map((m) => m.selector || `${m.provider}/${m.id}`);
  const providers = [...new Set(models.map((m) => m.provider))].sort();
  const setRoles = async (next) => { try { await http('PUT', '/api/settings', { key: 'modelRoles', value: next, type: 'record' }); toast('Roles saved'); } catch (e) { toast(e.message, 'error'); } };
  const roleNames = [...new Set([...Object.keys(ROLE_HINTS), ...Object.keys(roles)])];
  const roleBox = h('div', { class: 'card' }, h('strong', { text: 'Model roles' }), h('div', { class: 'muted', text: 'Which model omp uses for each job. Changes apply to new sessions and running tasks reload them from config.' }),
    ...roleNames.map((r) => h('div', { class: 'field' }, h('label', { text: `${r}${ROLE_HINTS[r] ? ' — ' + ROLE_HINTS[r] : ''}` }),
      h('select', { onchange: async (e) => { if (e.target.value) roles[r] = e.target.value; else delete roles[r]; await setRoles(roles); } },
        h('option', { value: '', text: '(unset)' }), ...[...new Set([...selectors, roles[r]].filter(Boolean))].map((s) => h('option', { value: s, text: s, selected: s === roles[r] }))))),
    h('div', { class: 'row' }, h('input', { type: 'text', id: 'newRole', placeholder: 'custom role name' }), h('button', { text: 'Add role', onclick: () => { const n = $('#newRole').value.trim(); if (n) { roles[n] = roles[n] || selectors[0]; setRoles(roles).then(modelsPage); } } })));
  const provBox = h('div', { class: 'card' }, h('strong', { text: 'Providers' }), h('div', { class: 'muted', text: 'Untick to hide a provider from model lists.' }),
    ...providers.map((p) => h('label', { class: 'toggle' }, h('span', { text: `${p} (${models.filter((m) => m.provider === p).length})` }),
      h('input', { type: 'checkbox', checked: !disabled.has(p), onchange: async (e) => { e.target.checked ? disabled.delete(p) : disabled.add(p); try { await http('PUT', '/api/settings', { key: 'disabledProviders', value: [...disabled], type: 'array' }); } catch (x) { toast(x.message, 'error'); } } }))));
  const q = h('input', { type: 'search', placeholder: 'Filter models…', oninput: () => draw() });
  const list = h('div', { class: 'list tall' });
  const draw = () => {
    const f = q.value.toLowerCase();
    list.replaceChildren(...models.filter((m) => `${m.provider}/${m.id} ${m.name} ${m.kind}`.toLowerCase().includes(f)).slice(0, 400).map((m) => h('div', { class: 'item' },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { text: m.name || m.id }), h('div', { class: 'muted mono', text: m.selector || `${m.provider}/${m.id}` })),
      h('span', { class: 'muted', text: [m.kind && m.kind !== 'chat' ? m.kind : '', m.reasoning ? '🧠' : '', m.contextWindow ? Math.round(m.contextWindow / 1000) + 'k ctx' : '', m.thinking ? 'think: ' + m.thinking.join('/') : ''].filter(Boolean).join(' · ') }))));
  };
  draw();
  page('Models & roles', h('div', { class: 'two' }, h('div', { class: 'col' }, roleBox, provBox), h('div', { class: 'col' }, h('div', { class: 'row' }, q, h('button', { text: 'Refresh catalog', onclick: async (e) => { e.target.disabled = true; toast('Refreshing models…'); try { await http('POST', '/api/omp/models/refresh'); } catch (x) { toast(x.message, 'error'); } modelsPage(); } })), list)));
}

// ---------------------------------------------------------------- omp subcommands
const QUICK = [['models'], ['usage'], ['stats'], ['plugin', 'list'], ['skill', 'list'], ['agents', 'list'], ['ssh', 'list'], ['worktree', 'list'], ['ps'], ['gc'], ['update'], ['session', 'lease', '--json'], ['config', 'path'], ['setup']];
async function commandsPage(pre) {
  page('omp commands', h('div', { class: 'muted pad', text: 'Loading…' }));
  let list; try { list = (await http('GET', '/api/omp/commands')).commands; } catch (e) { return page('omp commands', h('div', { class: 'err pad', text: e.message })); }
  const cwd = h('input', { type: 'text', value: S.snap?.task?.cwd || store.get('cwd', S.config?.home || ''), placeholder: 'working directory' });
  const args = h('input', { type: 'text', placeholder: 'arguments, e.g. list --json   (quote with " " for spaces)', onkeydown: (e) => e.key === 'Enter' && run() });
  const out = h('pre', { class: 'cmdout' });
  const help = h('pre', { class: 'cmdout muted' });
  let sel = pre || list[0]?.name;
  const parseArgs = (s) => { const r = []; const re = /"([^"]*)"|'([^']*)'|(\S+)/g; let m; while ((m = re.exec(s))) r.push(m[1] ?? m[2] ?? m[3]); return r; };
  const showHelp = async () => { help.textContent = 'Loading help…'; try { help.textContent = (await http('GET', '/api/omp/help?cmd=' + encodeURIComponent(sel))).help; } catch (e) { help.textContent = e.message; } };
  const run = async () => {
    out.replaceChildren('Running…');
    try {
      const r = await http('POST', '/api/omp/run', { args: [sel, ...parseArgs(args.value)], cwd: cwd.value });
      out.replaceChildren(ansiToEl((r.stdout || '') + (r.stderr ? '\n' + r.stderr : '')), h('div', { class: r.code ? 'err' : 'muted', text: `\n[exit ${r.code}]` }));
    } catch (e) { out.textContent = e.message; }
  };
  const inTerm = async () => {
    if (!S.config.terminals) return toast('Terminal support is not available on this server', 'error');
    try { const { term } = await http('POST', '/api/terms', { kind: 'omp', args: [sel, ...parseArgs(args.value)], cwd: cwd.value }); closePage(); selectTerm(term.id); } catch (e) { toast(e.message, 'error'); }
  };
  const lst = h('div', { class: 'list tall' });
  const selLabel = h('strong', { text: sel });
  const drawList = () => {
    selLabel.textContent = sel;
    lst.replaceChildren(...list.map((c) => h('div', { class: 'item' + (c.name === sel ? ' sel' : ''), onclick: () => { sel = c.name; drawList(); showHelp(); } },
      h('div', { style: 'flex:1;min-width:0' }, h('strong', { text: c.name }), h('div', { class: 'muted', text: c.description })))));
  };
  drawList(); showHelp();
  page('omp commands', h('div', { class: 'two' }, h('div', { class: 'col' }, lst),
    h('div', { class: 'col' },
      h('div', { class: 'muted', text: 'Every omp subcommand. Run to capture output, or open in a real terminal for interactive ones (git, shell, setup, login, join, play…).' }),
      h('div', { class: 'chips' }, ...QUICK.map((q) => h('button', { class: 'chip', text: q.join(' '), onclick: () => { sel = q[0]; args.value = q.slice(1).join(' '); drawList(); showHelp(); run(); } }))),
      h('div', { class: 'field' }, h('label', { text: 'Working directory' }), cwd),
      h('div', { class: 'row' }, h('span', { class: 'mono', text: 'omp' }), selLabel, args, h('button', { class: 'primary', text: 'Run', onclick: run }), h('button', { text: 'Open in terminal', onclick: inTerm })),
      out, h('details', {}, h('summary', { text: 'Help' }), help))));
}

// ---------------------------------------------------------------- files
const FS = { dir: null, file: null, mtime: null, dirty: false };
async function filesPage(target) {
  let start = target || S.snap?.task?.cwd || S.config?.home;
  let openFile = null;
  try { const probe = await http('GET', '/api/files?path=' + encodeURIComponent(start)).catch(() => null); if (!probe) { openFile = start; start = start.replace(/[\\/][^\\/]*$/, '') || '/'; } } catch {}
  const paths = await http('GET', '/api/omp/paths').catch(() => null);
  const pathIn = h('input', { type: 'text', class: 'grow', onkeydown: (e) => e.key === 'Enter' && go(pathIn.value) });
  const list = h('div', { class: 'list tall' });
  const editor = h('textarea', { class: 'editor', spellcheck: 'false', wrap: 'off', placeholder: 'Select a file…', oninput: () => { FS.dirty = true; status.textContent = 'modified'; } });
  const status = h('span', { class: 'muted', text: '' });
  const imgBox = h('div');
  const join = (d, n) => d.replace(/[\\/]+$/, '') + S.config.sep + n;
  const go = async (dir) => {
    try {
      const d = await http('GET', '/api/files?path=' + encodeURIComponent(dir));
      FS.dir = d.path; pathIn.value = d.path;
      list.replaceChildren(d.parent ? h('div', { class: 'item', onclick: () => go(d.parent), text: '↑ ..' }) : null,
        ...d.entries.map((e) => h('div', { class: 'item', onclick: () => (e.dir ? go(join(d.path, e.name)) : open(join(d.path, e.name))) }, h('span', {}, h('i', { class: 'codicon codicon-' + (e.dir ? 'folder' : 'file'), style: 'margin-right:8px;color:' + (e.dir ? '#dcb67a' : 'var(--muted)') }), e.name))));
    } catch (e) { toast(e.message, 'error'); }
  };
  const open = async (file) => {
    if (FS.dirty && !confirm('Discard unsaved changes?')) return;
    imgBox.replaceChildren();
    try {
      if (/\.(png|jpe?g|gif|webp|svg|ico)$/i.test(file)) { editor.hidden = true; imgBox.replaceChildren(h('img', { src: '/api/file?raw=1&path=' + encodeURIComponent(file), style: 'max-width:100%' })); status.textContent = file; FS.file = null; return; }
      const d = await http('GET', '/api/file?path=' + encodeURIComponent(file));
      editor.hidden = false;
      if (d.binary || d.tooLarge) { editor.value = ''; editor.disabled = true; status.textContent = `${file}: ${d.binary ? 'binary' : 'too large (' + d.size + ' bytes)'} — not editable here`; FS.file = null; return; }
      editor.disabled = false; editor.value = d.content; FS.file = d.path; FS.mtime = d.mtime; FS.dirty = false; status.textContent = d.path;
    } catch (e) { toast(e.message, 'error'); }
  };
  const save = async () => {
    if (!FS.file) return;
    try { const r = await http('PUT', '/api/file', { path: FS.file, content: editor.value, expectMtime: FS.mtime }); FS.mtime = r.mtime; FS.dirty = false; status.textContent = 'saved ' + FS.file; }
    catch (e) { toast(e.message, 'error', 8000); }
  };
  editor.addEventListener('keydown', (e) => { if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); save(); } if (e.key === 'Tab') { e.preventDefault(); const s = editor.selectionStart; editor.setRangeText('  ', s, editor.selectionEnd, 'end'); } });
  const quick = [];
  const proj = S.snap?.task?.cwd;
  if (proj) quick.push(['Project', proj], ['Project .omp', join(proj, '.omp')], ['AGENTS.md', join(proj, 'AGENTS.md')]);
  if (paths) quick.push(['Agent dir', paths.agentDir], ['config.yml', paths.configFile], ['models.yml', join(paths.agentDir, 'models.yml')], ['mcp.json', join(paths.agentDir, 'mcp.json')], ['Global AGENTS.md', join(paths.agentDir, 'AGENTS.md')], ['Sessions', join(paths.agentDir, 'sessions')]);
  page('Files', h('div', { class: 'files' }, h('div', { class: 'col' },
    h('div', { class: 'chips' }, ...quick.map(([l, p]) => h('button', { class: 'chip', text: l, onclick: () => { /\.[a-z]+$/i.test(p) && !/\.omp$/.test(p) ? open(p) : go(p); } }))),
    h('div', { class: 'row' }, pathIn), list),
    h('div', { class: 'col' }, h('div', { class: 'row' }, status, h('span', { class: 'grow' }), h('button', { class: 'primary', text: 'Save (Ctrl+S)', onclick: save })), imgBox, editor)));
  await go(start);
  if (openFile) open(openFile);
}

// ---------------------------------------------------------------- launch options form
const LAUNCH_FIELDS = [
  { group: 'Models', items: [
    { k: 'model', l: 'Model', t: 'text', ph: 'e.g. opus, openai/gpt-5.2 (new sessions)' },
    { k: 'smol', l: 'Smol model', t: 'text', ph: 'fast/cheap tasks' }, { k: 'slow', l: 'Slow model', t: 'text', ph: 'deep reasoning' },
    { k: 'plan', l: 'Plan model', t: 'text' }, { k: 'models', l: 'Cycle models', t: 'text', ph: 'comma-separated patterns (Ctrl+P)' },
    { k: 'thinking', l: 'Thinking', t: 'select', o: ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'] },
    { k: 'serviceTier', l: 'OpenAI service tier', t: 'text', ph: 'none to omit' } ] },
  { group: 'Safety & limits', items: [
    { k: 'approvalMode', l: 'Tool approvals', t: 'select', o: ['', 'always-ask', 'always-ask-cached', 'write', 'yolo'] },
    { k: 'autoApprove', l: 'Auto-approve all tool calls', t: 'bool' },
    { k: 'maxCost', l: 'Max cost (USD)', t: 'text' }, { k: 'warnCost', l: 'Warn at cost (USD)', t: 'text' }, { k: 'maxTime', l: 'Max time', t: 'text', ph: '10m, 1h, 600' } ] },
  { group: 'Features', items: [
    { k: 'advisor', l: 'Advisor (second model reviews every turn)', t: 'bool' },
    { k: 'planYolo', l: 'Plan-yolo (plan read-only, auto-approve, implement)', t: 'bool' }, { k: 'planYoloInto', l: 'Plan-yolo implementation model', t: 'text' },
    { k: 'prewalk', l: 'Prewalk (switch to cheap model at first edit)', t: 'select', o: ['', 'on', 'off'] }, { k: 'prewalkInto', l: 'Prewalk target model', t: 'text' },
    { k: 'noLsp', l: 'Disable LSP', t: 'bool' }, { k: 'noPty', l: 'Disable PTY bash', t: 'bool' }, { k: 'noTools', l: 'Disable all built-in tools', t: 'bool' },
    { k: 'noSkills', l: 'Disable skills', t: 'bool' }, { k: 'noRules', l: 'Disable rules', t: 'bool' }, { k: 'noExtensions', l: 'Disable extension discovery', t: 'bool' }, { k: 'noContextFiles', l: 'Disable context files (AGENTS.md…)', t: 'bool' },
    { k: 'tools', l: 'Enabled tools', t: 'text', ph: 'comma-separated names' }, { k: 'skills', l: 'Skill filter', t: 'text', ph: 'glob patterns, e.g. git-*,docker' } ] },
  { group: 'Prompt, profile & storage', items: [
    { k: 'profile', l: 'Profile', t: 'text', ph: 'isolated auth/sessions/settings' }, { k: 'sessionDir', l: 'Session directory', t: 'text' },
    { k: 'systemPrompt', l: 'System prompt', t: 'area' }, { k: 'appendSystemPrompt', l: 'Append to system prompt', t: 'area' },
    { k: 'addDirs', l: 'Extra workspace directories', t: 'list' }, { k: 'configOverlays', l: 'Config overlay files', t: 'list' },
    { k: 'hooks', l: 'Hook files', t: 'list' }, { k: 'extensions', l: 'Extension files', t: 'list' }, { k: 'extraArgs', l: 'Any other omp flags', t: 'list', ph: 'one argument per line' } ] },
];
function launchForm(initial = {}, { only } = {}) {
  const vals = { ...initial };
  const root = h('div', { class: 'formgrid' });
  for (const g of LAUNCH_FIELDS) {
    if (only && !only.includes(g.group)) continue;
    const grid = h('div', { class: 'row2' });
    for (const f of g.items) {
      let ctl;
      if (f.t === 'bool') { ctl = h('label', { class: 'toggle' }, h('span', { text: f.l }), h('input', { type: 'checkbox', checked: !!vals[f.k], onchange: (e) => { vals[f.k] = e.target.checked; } })); grid.append(ctl); continue; }
      if (f.t === 'select') ctl = h('select', { onchange: (e) => { vals[f.k] = e.target.value; } }, ...f.o.map((o) => h('option', { value: o, text: o || 'default', selected: o === (vals[f.k] || '') })));
      else if (f.t === 'area') ctl = h('textarea', { rows: 3, placeholder: f.ph || '', oninput: (e) => { vals[f.k] = e.target.value; } }, vals[f.k] || '');
      else if (f.t === 'list') ctl = h('textarea', { rows: 2, placeholder: f.ph || 'one per line', oninput: (e) => { vals[f.k] = e.target.value.split('\n').map((x) => x.trim()).filter(Boolean); } }, (vals[f.k] || []).join('\n'));
      else ctl = h('input', { type: 'text', value: vals[f.k] || '', placeholder: f.ph || '', oninput: (e) => { vals[f.k] = e.target.value; } });
      grid.append(h('div', { class: 'field' + (f.t === 'area' || f.t === 'list' ? ' span2' : '') }, h('label', { text: f.l }), ctl));
    }
    root.append(h('details', { open: g.group === 'Models' || g.group === 'Safety & limits' }, h('summary', { text: g.group }), grid));
  }
  return { el: root, get: () => ({ ...vals }) };
}
