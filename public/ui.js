'use strict';
// Terminals, task creation, launch options, raw RPC. Loaded before app.js; helpers from app.js are used at call time.

// ---------------------------------------------------------------- terminals (xterm.js <-> server PTY)
// VS Code integrated-terminal palettes
function termTheme() {
  const light = false; // dark only
  return light
    ? { background: '#ffffff', foreground: '#3b3b3b', cursor: '#005fb8', selectionBackground: '#add6ff',
        black: '#000000', red: '#cd3131', green: '#107c10', yellow: '#949800', blue: '#0451a5', magenta: '#bc05bc', cyan: '#0598bc', white: '#555555',
        brightBlack: '#666666', brightRed: '#cd3131', brightGreen: '#14ce14', brightYellow: '#b5ba00', brightBlue: '#0451a5', brightMagenta: '#bc05bc', brightCyan: '#0598bc', brightWhite: '#a5a5a5' }
    : { background: '#181818', foreground: '#cccccc', cursor: '#aeafad', selectionBackground: '#264f78',
        black: '#000000', red: '#cd3131', green: '#0dbc79', yellow: '#e5e510', blue: '#2472c8', magenta: '#bc3fbc', cyan: '#11a8cd', white: '#e5e5e5',
        brightBlack: '#666666', brightRed: '#f14c4c', brightGreen: '#23d18b', brightYellow: '#f5f543', brightBlue: '#3b8eea', brightMagenta: '#d670d6', brightCyan: '#29b8db', brightWhite: '#e5e5e5' };
}
function setCtrl(on) {
  if (S.term) S.term.ctrl = on;
  $('#ctrlKey')?.classList.toggle('on', on);
}
function mountTerm(id) {
  if (S.term && S.term.id === id) { try { S.term.fit.fit(); } catch {} attachTerm(); return; }
  unmountTerm();
  const host = $('#termHost');
  host.replaceChildren();
  const term = new Terminal({
    cursorBlink: true, scrollback: 10000, allowProposedApi: true, fontSize: store.get('termFont', 13),
    fontFamily: 'Cascadia Code, Consolas, Menlo, "DejaVu Sans Mono", monospace',
    theme: termTheme(),
  });
  const fit = new FitAddon.FitAddon();
  term.loadAddon(fit);
  term.loadAddon(new WebLinksAddon.WebLinksAddon());
  term.open(host);
  document.fonts.load('13px "JetBrains Mono Variable"').finally(() => { try { term.options.fontFamily = '"JetBrains Mono Variable", Cascadia Code, Consolas, Menlo, monospace'; fit.fit(); } catch {} });
  const t = { id, term, fit, ctrl: false };
  term.onData((d) => {
    if (t.ctrl && d.length === 1) { const c = d.toUpperCase().charCodeAt(0); if (c >= 64 && c <= 95) d = String.fromCharCode(c - 64); setCtrl(false); }
    wsSend({ t: 'term-input', id, data: d });
  });
  term.onResize(({ cols, rows }) => wsSend({ t: 'term-resize', id, cols, rows }));
  t.ro = new ResizeObserver(() => { try { fit.fit(); } catch {} });
  t.ro.observe(host);
  S.term = t;
  requestAnimationFrame(() => { try { fit.fit(); } catch {} attachTerm(); term.focus(); });
}
function attachTerm() {
  const t = S.term; if (!t) return;
  try { t.fit.fit(); } catch {}
  wsSend({ t: 'term-attach', id: t.id, cols: t.term.cols, rows: t.term.rows });
}
function unmountTerm() {
  const t = S.term; if (!t) return;
  wsSend({ t: 'term-detach' });
  try { t.ro.disconnect(); t.term.dispose(); } catch {}
  S.term = null;
  $('#termHost').replaceChildren();
}
const TERM_KEYS = { esc: '\x1b', tab: '\t', up: '\x1b[A', down: '\x1b[B', right: '\x1b[C', left: '\x1b[D', c: '\x03', d: '\x04' };
function initTermKeys() {
  $('#termKeys').addEventListener('click', async (e) => {
    const b = e.target.closest('button'); if (!b || !S.term) return;
    const k = b.dataset.k;
    if (k === 'ctrl') setCtrl(!S.term.ctrl);
    else if (k === 'paste') { try { const tx = await navigator.clipboard.readText(); if (tx) wsSend({ t: 'term-input', id: S.term.id, data: tx }); } catch { toast('Clipboard access denied', 'warning'); } }
    else if (TERM_KEYS[k]) wsSend({ t: 'term-input', id: S.term.id, data: TERM_KEYS[k] });
    S.term.term.focus();
  });
}
function onTermMessage(m) {
  const t = S.term;
  if (m.t === 'terms') { S.terms = m.terms; renderTerms(); if (S.curTerm && !S.terms.find((x) => x.id === S.curTerm)) { S.curTerm = null; renderAll(); } return true; }
  if (m.t === 'term-gone') { toast('Terminal no longer exists', 'warning'); return true; }
  if (!t || m.id !== t.id) return m.t.startsWith('term-');
  if (m.t === 'term-replay') { t.term.reset(); t.term.write(m.data); if (m.exited) t.term.write(`\r\n\x1b[90m[process exited with code ${m.exitCode}]\x1b[0m\r\n`); }
  else if (m.t === 'term-data') t.term.write(m.data);
  else if (m.t === 'term-exit') t.term.write(`\r\n\x1b[90m[process exited with code ${m.code}]\x1b[0m\r\n`);
  return true;
}
function selectTerm(id) {
  S.curTerm = id; S.cur = null; S.snap = null; S.ui.clear();
  wsSend({ t: 'detach' });
  document.body.classList.remove('nav-open');
  renderAll();
}
function renderTerms() {
  $('#termList').replaceChildren(...S.terms.map((t) => h('div', { class: 'task' + (t.id === S.curTerm ? ' sel' : '') + (t.exited ? ' exited' : ''), onclick: () => selectTerm(t.id) },
    h('div', { class: 't1' }, h('span', { class: 'dot ' + (t.exited ? 'stopped' : 'idle') }), h('span', { class: 'name', text: t.title }),
      h('button', { class: 'x', title: 'Close terminal', text: '✕', onclick: (e) => { e.stopPropagation(); closeTerm(t.id); } })))));
}
async function closeTerm(id) {
  try { await http('DELETE', '/api/terms/' + id); } catch (e) { toast(e.message, 'error'); }
  if (S.curTerm === id) { S.curTerm = null; renderAll(); }
}
function newTermModal(draft = {}) {
  const cwd = h('input', { type: 'text', value: draft.cwd || S.snap?.task?.cwd || store.get('cwd', S.config?.home || '') });
  const kind = h('select', {}, h('option', { value: 'shell', text: `Shell (${(S.config.shell || '').split(/[\\/]/).pop() || 'default'})`, selected: draft.kind !== 'omp' }), h('option', { value: 'omp', text: 'omp (full TUI / any subcommand)', selected: draft.kind === 'omp' }));
  const args = h('input', { type: 'text', value: draft.args || '', placeholder: 'omp arguments, e.g. git   |   shell   |   login   |   (empty = interactive omp)' });
  const collect = () => ({ cwd: cwd.value, kind: kind.value, args: args.value });
  if (!S.config.terminals) {
    return modal([h('h3', { text: 'Terminals unavailable' }), h('p', { class: 'err', text: S.config.terminalProblem || 'No PTY binding is installed on this server.' }),
      h('p', { class: 'muted', text: 'Install @homebridge/node-pty-prebuilt-multiarch (prebuilt) or build node-pty (needs python3, make and a C++ compiler), then restart.' }), h('div', { class: 'actions' }, h('button', { text: 'Close', onclick: closeModal }))]);
  }
  modal([h('h3', { text: 'New terminal' }),
    h('div', { class: 'formgrid' },
      h('div', { class: 'field' }, h('label', { text: 'Working directory' }), h('div', { class: 'row', style: 'display:flex;gap:6px' }, cwd, h('button', { text: 'Browse…', onclick: () => browseDir(cwd.value, (p) => newTermModal({ ...collect(), cwd: p }), () => newTermModal(collect())) }))),
      h('div', { class: 'field' }, h('label', { text: 'Run' }), kind), h('div', { class: 'field' }, h('label', { text: 'omp arguments' }), args)),
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }),
      h('button', { class: 'primary', text: 'Open', onclick: async () => {
        try {
          const { term } = await http('POST', '/api/terms', { kind: kind.value, cwd: cwd.value, args: args.value.trim() ? args.value.trim().split(/\s+/) : [] });
          closeModal(); selectTerm(term.id);
        } catch (e) { toast(e.message, 'error'); }
      } }))]);
}

// ---------------------------------------------------------------- GUI <-> TUI
async function switchMode() {
  const t = S.snap?.task; if (!t) return;
  const to = t.mode === 'tui' ? 'gui' : 'tui';
  if (to === 'tui' && !S.config.terminals) return toast('Terminal support is unavailable on this server', 'error');
  if (to === 'tui' && (t.status === 'busy' || t.status === 'needs_input') && !confirm('The agent is working. Switching will abort the current turn. Continue?')) return;
  const tid = toast(to === 'tui' ? 'Opening the full omp TUI…' : 'Returning to the web GUI…', 'info', 0);
  try { await http('POST', `/api/tasks/${t.id}/mode`, { mode: to }); } catch (e) { toast(e.message, 'error'); }
  tid.remove();
}
async function restartTask() {
  const t = S.snap?.task; if (!t) return;
  await http('POST', `/api/tasks/${t.id}/stop`).catch(() => {});
  await http('POST', `/api/tasks/${t.id}/start`).catch((e) => toast(e.message, 'error'));
}

// ---------------------------------------------------------------- folder picker
async function browseDir(start, onPick, onBack) {
  const load = async (p) => {
    let d; try { d = await http('GET', '/api/fs?path=' + encodeURIComponent(p || '')); } catch (e) { toast(e.message, 'error'); return; }
    modal([h('h3', { text: 'Choose a folder' }), h('div', { class: 'mono muted', text: d.path }),
      h('div', { class: 'list' },
        d.parent ? h('div', { class: 'item', onclick: () => load(d.parent), text: '↑ ..' }) : null,
        ...(S.config?.platform === 'win32' ? d.drives.map((x) => h('div', { class: 'item', onclick: () => load(x), }, h('i', { class: 'codicon codicon-server', style: 'margin-right:8px;color:var(--muted)' }), x)) : []),
        ...d.entries.map((n) => h('div', { class: 'item', onclick: () => load(d.path.replace(/[\\/]$/, '') + S.config.sep + n), }, h('i', { class: 'codicon codicon-folder', style: 'margin-right:8px;color:#dcb67a' }), n))),
      h('div', { class: 'actions' }, h('button', { text: 'Back', onclick: onBack }), h('button', { class: 'primary', text: 'Use this folder', onclick: () => onPick(d.path) }))]);
  };
  load(start);
}

// ---------------------------------------------------------------- new task
function newTaskModal(draft = {}) {
  const projectId = draft.projectId !== undefined ? draft.projectId : S.curProject;
  const proj = projById(projectId);
  const f = {
    cwd: h('input', { type: 'text', value: draft.cwd ?? (proj ? proj.path : store.get('cwd', S.config?.home || '')), placeholder: 'absolute path on the server' }),
    name: h('input', { type: 'text', value: draft.name || '', placeholder: 'optional' }),
    prompt: h('textarea', { rows: 3, placeholder: 'What should omp work on? (optional)' }, draft.prompt || ''),
  };
  const mode = { v: draft.mode || 'gui' };
  const modeSel = h('select', { onchange: (e) => { mode.v = e.target.value; } },
    h('option', { value: 'gui', text: 'Web GUI (rich, runs in the background)', selected: mode.v === 'gui' }),
    h('option', { value: 'tui', text: 'Full omp terminal UI (every TUI feature)', selected: mode.v === 'tui' }));
  const lf = launchForm(draft.launch || proj?.defaults?.launch || {});
  const err = h('div', { class: 'err' });
  const collect = () => ({ cwd: f.cwd.value, name: f.name.value, prompt: f.prompt.value, mode: mode.v, launch: lf.get(), projectId: proj?.id || null });
  const projSel = h('select', { onchange: (e) => {
    const np = projById(e.target.value);
    const cur = collect();
    newTaskModal({ ...cur, projectId: np?.id || null, cwd: np ? np.path : cur.cwd, launch: np?.defaults?.launch && Object.keys(np.defaults.launch).length ? np.defaults.launch : cur.launch });
  } }, h('option', { value: '', text: 'No project (group by folder)', selected: !proj }), ...(S.projects || []).map((p) => h('option', { value: p.id, text: p.name, selected: proj?.id === p.id })));
  f.cwd.style.flex = '1';
  modal([h('h3', { text: 'New task' }),
    h('div', { class: 'formgrid' },
      h('div', { class: 'field' }, h('label', { text: 'Working directory (on the server)' }), h('div', { class: 'row', style: 'display:flex;gap:6px' }, f.cwd, h('button', { text: 'Browse…', onclick: () => browseDir(f.cwd.value, (p) => newTaskModal({ ...collect(), cwd: p }), () => newTaskModal(collect())) }))),
      h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: 'Project' }), projSel), h('div', { class: 'field' }, h('label', { text: 'Name' }), f.name)),
      h('div', { class: 'field' }, h('label', { text: 'Interface' }), modeSel),
      h('div', { class: 'field' }, h('label', { text: 'First prompt (GUI mode)' }), f.prompt),
      lf.el, err),
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }),
      h('button', { class: 'primary', text: 'Create & run', onclick: async (e) => {
        e.target.disabled = true; err.textContent = '';
        try {
          store.set('cwd', f.cwd.value);
          const { task } = await http('POST', '/api/tasks', { name: f.name.value.trim() || undefined, cwd: f.cwd.value.trim(), mode: mode.v, launch: lf.get(), prompt: f.prompt.value.trim() || undefined, projectId: proj?.id || undefined });
          closeModal(); selectTask(task.id);
        } catch (x) { err.textContent = x.message; e.target.disabled = false; }
      } }))]);
  f.cwd.focus();
}

function launchOptionsModal() {
  const t = S.snap?.task; if (!t) return;
  const lf = launchForm(S.snap.launch || {});
  modal([h('h3', { text: `Launch options — ${t.name}` }),
    h('div', { class: 'muted', text: 'These become omp command-line flags. They apply the next time the task starts. Model and thinking only apply to a brand-new session; use the model picker for a running one.' }),
    lf.el,
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }),
      h('button', { text: 'Save', onclick: async () => { await http('PATCH', `/api/tasks/${t.id}`, { launch: lf.get() }).catch((e) => toast(e.message, 'error')); S.snap.launch = lf.get(); closeModal(); toast('Saved — applies on next start'); } }),
      h('button', { class: 'primary', text: 'Save & restart', onclick: async () => { await http('PATCH', `/api/tasks/${t.id}`, { launch: lf.get() }).catch((e) => toast(e.message, 'error')); S.snap.launch = lf.get(); closeModal(); restartTask(); } }))]);
}

// ---------------------------------------------------------------- raw RPC
function rawRpcModal() {
  const ta = h('textarea', { rows: 5, spellcheck: 'false', class: 'mono', placeholder: '{"type":"get_session_stats"}' });
  const out = h('pre', { class: 'cmdout' });
  const go = async () => {
    let cmd; try { cmd = JSON.parse(ta.value); } catch (e) { out.textContent = 'Invalid JSON: ' + e.message; return; }
    out.textContent = 'Running…';
    try { const r = await rpc(cmd); out.textContent = JSON.stringify(r, null, 2); } catch (e) { out.textContent = e.message; }
  };
  modal([h('h3', { text: 'Raw omp RPC command' }),
    h('div', { class: 'muted', text: 'Send any command from omp\'s RPC protocol (docs/rpc.md) to this task\'s omp process and see the raw response.' }),
    ta, h('div', { class: 'chips' }, ...['get_state', 'get_session_stats', 'get_available_models', 'get_available_commands', 'get_tree', 'get_btw_history', 'get_subagents', 'get_login_providers'].map((c) => h('button', { class: 'chip', text: c, onclick: () => { ta.value = JSON.stringify({ type: c }); go(); } }))),
    out, h('div', { class: 'actions' }, h('button', { text: 'Close', onclick: closeModal }), h('button', { class: 'primary', text: 'Send', onclick: go }))]);
}
