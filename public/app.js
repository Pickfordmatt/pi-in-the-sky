'use strict';
// ohmypi-web client. Plain JS, no build step. The server owns all state; this is a view.

const $ = (s) => document.querySelector(s);
const h = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') e.className = v;
    else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
    else if (k === 'value') e.value = v;
    else if (v === true) e.setAttribute(k, '');
    else e.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) e.append(k.nodeType ? k : document.createTextNode(String(k)));
  return e;
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('ow:' + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem('ow:' + k, JSON.stringify(v)); } catch {} },
};

// ---------------------------------------------------------------- state
const S = {
  tasks: [],
  cur: null, // current task id
  snap: null, // {task,state,transcript,commands,stats,live}
  ui: new Map(),
  ws: null,
  reqs: new Map(),
  reqSeq: 0,
  attachments: [],
  seen: store.get('seen', {}),
  prevStatus: {},
  panelTab: 'plan',
  config: null,
  terms: [],
  curTerm: null,
  projects: [],
  curProject: null,
  term: null,
};

async function http(method, url, body) {
  const r = await fetch(url, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, credentials: 'same-origin' });
  if (r.status === 401 && !url.includes('/login')) { showLogin(); throw new Error('unauthorized'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || r.statusText);
  return j;
}

function toast(text, kind = 'info', ms = 5000, link) {
  const t = h('div', { class: 'toast ' + kind }, text, link ? [' ', h('a', { href: link.href, target: '_blank', rel: 'noopener', text: link.text, style: 'color:var(--accent2)' })] : null);
  $('#toasts').append(t);
  if (ms) setTimeout(() => t.remove(), ms);
  return t;
}

// ---------------------------------------------------------------- login
function showLogin() { $('#app').hidden = true; $('#login').hidden = false; $('#loginToken').focus(); }
$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  try { await http('POST', '/api/login', { token: $('#loginToken').value.trim() }); location.reload(); }
  catch (err) { $('#loginError').textContent = err.message; }
});
$('#logoutBtn').onclick = async () => { await http('POST', '/api/logout').catch(() => {}); location.reload(); };

async function boot() {
  const m = location.hash.match(/token=([\w-]+)/);
  if (m) {
    history.replaceState(null, '', location.pathname);
    await http('POST', '/api/login', { token: m[1] }).catch(() => {});
  }
  try { S.config = await http('GET', '/api/config'); } catch { return showLogin(); }
  $('#login').hidden = true; $('#app').hidden = false;
  $('#ompVersion').textContent = S.config.ompVersion || 'omp not found';
  connect();
  const last = store.get('last', null);
  if (last) S.pendingSelect = last;
}

// ---------------------------------------------------------------- websocket
function connect() {
  const ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws');
  S.ws = ws;
  let retry = S.retry || 500;
  ws.onopen = () => {
    S.retry = 500;
    $('#conn').className = 'dot on'; $('#conn').title = 'connected';
    if (S.cur) ws.send(JSON.stringify({ t: 'attach', taskId: S.cur }));
    if (S.term) attachTerm();
  };
  ws.onclose = () => {
    $('#conn').className = 'dot off'; $('#conn').title = 'disconnected — retrying';
    for (const [, r] of S.reqs) r.reject(new Error('disconnected'));
    S.reqs.clear();
    S.retry = Math.min(retry * 1.7, 8000);
    setTimeout(async () => {
      try { await http('GET', '/api/config'); connect(); } catch (e) { if (e.message !== 'unauthorized') setTimeout(connect, 1000); }
    }, retry);
  };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.t === 'terms' || m.t.startsWith('term-')) { onTermMessage(m); return; }
    if (m.t === 'projects') { onProjects(m.projects); return; }
    if (m.t === 'tasks') onTasks(m.tasks);
    else if (m.t === 'snapshot') onSnapshot(m);
    else if (m.t === 'event') onEvent(m.ev);
    else if (m.t === 'response') {
      const r = S.reqs.get(m.reqId);
      if (r) { S.reqs.delete(m.reqId); r.resolve(m.response); }
    } else if (m.t === 'error') toast(m.error, 'error');
  };
}
function wsSend(o) { if (S.ws?.readyState === 1) S.ws.send(JSON.stringify(o)); }
function rpc(cmd) {
  return new Promise((resolve, reject) => {
    if (S.ws?.readyState !== 1) return reject(new Error('Not connected'));
    const reqId = ++S.reqSeq;
    S.reqs.set(reqId, { resolve, reject });
    wsSend({ t: 'rpc', reqId, cmd });
  });
}
async function call(cmd, quiet) {
  try {
    const r = await rpc(cmd);
    if (!r.success) { if (!quiet) toast(r.error || `${cmd.type} failed`, 'error'); return null; }
    return r.data ?? {};
  } catch (e) { if (!quiet) toast(e.message, 'error'); return null; }
}

// ---------------------------------------------------------------- tasks list
function relTime(t) {
  if (!t) return '';
  const s = (Date.now() - t) / 1000;
  if (s < 60) return 'now';
  if (s < 3600) return Math.floor(s / 60) + 'm';
  if (s < 86400) return Math.floor(s / 3600) + 'h';
  return Math.floor(s / 86400) + 'd';
}
function onTasks(tasks) {
  for (const t of tasks) {
    const prev = S.prevStatus[t.id];
    if (prev && prev !== t.status && (t.status === 'idle' && prev === 'busy' || t.status === 'needs_input')) {
      notifyTask(t, t.status === 'needs_input' ? 'needs your input' : 'finished');
    }
    S.prevStatus[t.id] = t.status;
  }
  S.tasks = tasks;
  renderTasks();
  if (S.pendingSelect && tasks.find((t) => t.id === S.pendingSelect)) { const id = S.pendingSelect; S.pendingSelect = null; selectTask(id); }
  if (S.cur) {
    const t = tasks.find((x) => x.id === S.cur);
    if (!t) { S.cur = null; S.snap = null; renderAll(); }
    else if (S.snap) { S.snap.task = t; renderHeader(); }
  }
}
function notifyTask(t, what) {
  if (!document.hidden && S.cur === t.id) return;
  if (window.Notification && Notification.permission === 'granted') {
    const n = new Notification(`${t.name} ${what}`, { body: t.preview || t.cwd, tag: t.id });
    n.onclick = () => { window.focus(); selectTask(t.id); n.close(); };
  }
}
$('#notifBtn').onclick = async () => {
  if (!window.Notification) return toast('Notifications are not supported in this browser', 'warning');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Desktop notifications enabled' : 'Notifications ' + p);
};
function renderTasks() { renderSidebarTasks(); }
function selectTask(id) {
  subReset();
  S.cur = id;
  S.curProject = S.tasks.find((x) => x.id === id)?.projectId || null;
  S.curTerm = null;
  store.set('last', id);
  S.seen[id] = Date.now(); store.set('seen', S.seen);
  S.snap = null;
  S.ui.clear();
  document.body.classList.remove('nav-open');
  renderAll();
  wsSend({ t: 'attach', taskId: id });
}

// ---------------------------------------------------------------- snapshot / events
function onSnapshot(m) {
  if (m.task.id !== S.cur) return;
  S.snap = m;
  subLoad(m.live.subagents);
  S.ui = new Map((m.live.ui || []).map((u) => [u.id, u]));
  S.seen[S.cur] = Date.now(); store.set('seen', S.seen);
  renderAll();
}

const NOTE_EVENTS = {
  auto_compaction_start: 'Compacting context…', manual_compaction_start: 'Compacting context…',
  auto_compaction_end: 'Compaction finished', manual_compaction_end: 'Compaction finished',
  auto_retry_start: 'Retrying request…', retry_fallback_applied: 'Switched to fallback model',
  ttsr_triggered: 'Stream rule injected', todo_reminder: 'Todo reminder', irc_message: null,
};
let renderQueued = false;
function onEvent(ev) {
  const s = S.snap;
  if (!s) return;
  const L = s.live;
  switch (ev.type) {
    case 'ww_state':
      s.state = ev.state; renderHeader(); renderQueue(); renderPanel(); renderComposerState(); break;
    case 'ww_stats': s.stats = ev.stats; renderHeader(); break;
    case 'command_output': appendOutput(ev.text); break;
    case 'ww_subagent': case 'ww_sub_messages': subOnEvent(ev); break;
    case 'ww_commands': s.commands = ev.commands; break;
    case 'ww_status': L.status = ev.status; renderWidgets(); break;
    case 'ww_widgets': L.widgets = ev.widgets; renderWidgets(); break;
    case 'ww_ui_resolved': S.ui.delete(ev.id); renderTray(); break;
    case 'extension_ui_request':
      if (ev.method === 'notify') toast(ev.message || ev.text || '', ev.notifyType === 'error' ? 'error' : ev.notifyType === 'warning' ? 'warning' : 'info');
      else if (ev.method === 'open_url') toast(ev.instructions || 'Open this link to continue', 'warning', 0, { href: ev.url || ev.launchUrl, text: 'Open' });
      else if (ev.method === 'set_editor_text') { $('#input').value = ev.text || ''; autosize(); }
      else if (['select', 'confirm', 'input', 'editor', 'ask'].includes(ev.method)) { S.ui.set(ev.id, ev); renderTray(); }
      break;
    case 'agent_start': L.busy = true; renderComposerState(); break;
    case 'agent_end': if (ev.yielded !== false) L.busy = false; renderComposerState(); break;
    case 'message_start':
    case 'message_update':
      if (ev.message?.role === 'assistant') { L.streaming = ev.message; queueStream(); }
      break;
    case 'message_end': {
      const m = ev.message;
      s.transcript.push(m);
      if (m.role === 'assistant') { L.streaming = null; finalizeStream(m); } else appendMessage(m);
      stickScroll();
      break;
    }
    case 'tool_execution_start': {
      const c = getCard(ev.toolCallId, ev.toolName, ev.args, ev.intent);
      c.setRunning(); break;
    }
    case 'tool_execution_update': { const c = cards.get(ev.toolCallId); if (c) c.setResult(ev.partialResult, false, true); break; }
    case 'tool_execution_end': { const c = cards.get(ev.toolCallId); if (c) c.setResult(ev.result, ev.isError, false); break; }
    case 'prompt_result':
      if (ev.status === 'error') note(ev.error?.message || 'Request failed', true);
      break;
    case 'subagent_lifecycle': case 'subagent_progress':
      if (S.panelTab === 'agents') debounce('agents', renderPanel, 600);
      break;
    default:
      if (NOTE_EVENTS[ev.type]) note(NOTE_EVENTS[ev.type]);
      else if (ev.type === 'notice' && ev.message) note(ev.message);
      else if (ev.type === 'irc_message') note(`IRC ${ev.from || ''}: ${ev.message || ev.text || ''}`);
  }
}
const timers = {};
function debounce(k, fn, ms) { clearTimeout(timers[k]); timers[k] = setTimeout(fn, ms); }

// ---------------------------------------------------------------- transcript rendering
const T = () => $('#transcript');
let cards = new Map();
let streamEl = null;
let stuck = true;

$('#transcript').addEventListener('scroll', () => {
  const t = T();
  stuck = t.scrollHeight - t.scrollTop - t.clientHeight < 80;
  $('#jump').hidden = stuck;
});
$('#jump').onclick = () => { stuck = true; T().scrollTop = T().scrollHeight; $('#jump').hidden = true; };
function stickScroll() { if (stuck) requestAnimationFrame(() => { T().scrollTop = T().scrollHeight; }); }

function md(text) {
  const d = h('div', { class: 'md' });
  try { d.innerHTML = DOMPurify.sanitize(marked.parse(text || '', { gfm: true, breaks: false }), { ADD_ATTR: ['target'] }); }
  catch { d.textContent = text; }
  for (const a of d.querySelectorAll('a')) { a.target = '_blank'; a.rel = 'noopener noreferrer'; }
  for (const code of d.querySelectorAll('pre > code')) {
    const lang = (code.className.match(/language-([\w+-]+)/) || [])[1];
    if (window.hljs && code.textContent.length < 40000) {
      try { if (lang && hljs.getLanguage(lang)) hljs.highlightElement(code); else if (!lang && code.textContent.length < 6000) { const r = hljs.highlightAuto(code.textContent); if (r.relevance > 6) { code.innerHTML = r.value; code.classList.add('hljs'); } } } catch {}
    }
    code.parentElement.prepend(h('span', { class: 'lang', text: lang || 'text' }));
  }
  for (const pre of d.querySelectorAll('pre')) {
    pre.append(h('button', { class: 'copy', text: 'copy', onclick: (e) => {
      navigator.clipboard?.writeText(pre.querySelector('code')?.textContent ?? pre.textContent);
      e.target.textContent = 'copied'; setTimeout(() => (e.target.textContent = 'copy'), 1200);
    } }));
  }
  return d;
}
const partsText = (c) => (typeof c === 'string' ? c : (c || []).filter((p) => p.type === 'text').map((p) => p.text).join('\n'));

function summarizeArgs(name, a) {
  if (!a || typeof a !== 'object') return '';
  const pick = a.command ?? a.cmd ?? a.path ?? a.file ?? a.pattern ?? a.query ?? a.url ?? a.task ?? a.prompt ?? a.description;
  if (typeof pick === 'string') return pick.replace(/\s+/g, ' ').slice(0, 160);
  const k = Object.keys(a).filter((x) => x !== 'i' && x !== 'partialArgs');
  return k.length ? k.map((x) => `${x}=${JSON.stringify(a[x]).slice(0, 40)}`).join(' ').slice(0, 160) : '';
}

function getCard(id, name, args, intent) {
  let c = cards.get(id);
  if (c) { if (args && Object.keys(args).length) c.setArgs(args, intent); return c; }
  const stat = h('span', { class: 'tstat', text: '…' });
  const sum = h('span', { class: 'tsum' });
  const argsPre = h('pre');
  const out = h('div');
  const root = h('details', { class: 'tool run' },
    h('summary', {}, h('span', { class: 'tname', text: name }), sum, stat),
    h('div', { class: 'tbody' }, h('div', { class: 'lbl', text: 'arguments' }), argsPre, out));
  c = {
    root,
    setArgs(a, i) {
      sum.textContent = i || summarizeArgs(name, a);
      const { i: _i, ...shown } = a || {};
      argsPre.textContent = shown.command && Object.keys(shown).length === 1 ? shown.command : JSON.stringify(shown, null, 2);
    },
    setRunning() { root.className = 'tool run'; stat.textContent = '⏵ running'; },
    setResult(res, isError, partial) {
      root.className = 'tool ' + (partial ? 'run' : isError ? 'fail' : 'ok');
      stat.textContent = partial ? '⏵ running' : isError ? '✗ error' : '✓';
      out.replaceChildren();
      if (!res) return;
      out.append(h('div', { class: 'lbl', text: 'result' }));
      const diff = res.details?.diff;
      if (typeof diff === 'string') {
        out.append(h('pre', { class: 'diff' }, ...diff.split('\n').map((l) => h('div', { class: l.startsWith('+') ? 'a' : l.startsWith('-') ? 'd' : l.startsWith('@') ? 'h' : '', text: l || ' ' }))));
      }
      for (const p of res.content || []) {
        if (p.type === 'text' && p.text && typeof diff !== 'string') out.append(h('pre', { text: p.text }));
        else if (p.type === 'image') out.append(h('img', { src: `data:${p.mimeType};base64,${p.data}`, style: 'max-width:100%' }));
      }
    },
  };
  c.setArgs(args || {}, intent);
  cards.set(id, c);
  return c;
}

function renderAssistantInto(el, m, streaming) {
  const open = new Set([...el.querySelectorAll('details.think[open]')].map((d) => d.dataset.i));
  const kids = [];
  (m.content || []).forEach((p, i) => {
    if (p.type === 'thinking') {
      if (!p.thinking?.trim()) return;
      const d = h('details', { class: 'think', 'data-i': i }, h('summary', { text: streaming && i === m.content.length - 1 ? 'Thinking…' : 'Thought' }), md(p.thinking));
      if (open.has(String(i))) d.open = true;
      kids.push(d);
    } else if (p.type === 'text') {
      if (!p.text) return;
      const n = md(p.text);
      if (streaming && i === m.content.length - 1) n.classList.add('cursor');
      kids.push(n);
    } else if (p.type === 'toolCall') {
      const c = getCard(p.id, p.name, p.arguments, p.intent);
      kids.push(c.root);
    }
  });
  if (m.stopReason === 'error' || m.errorMessage) kids.push(h('div', { class: 'msg note err', text: m.errorMessage || 'The model returned an error.' }));
  else if (m.stopReason === 'aborted') kids.push(h('div', { class: 'usage', text: '— stopped —' }));
  if (!streaming && m.usage?.totalTokens) kids.push(h('div', { class: 'usage', text: `${m.model || ''} · ${m.usage.input}↑ ${m.usage.output}↓${m.usage.cost?.total ? ' · $' + m.usage.cost.total.toFixed(4) : ''}` }));
  el.replaceChildren(...kids);
}

function renderMessage(m) {
  switch (m.role) {
    case 'user': {
      const sys = m.attribution && m.attribution !== 'user';
      const el = h('div', { class: 'msg user' + (sys ? ' sys' : '') });
      if (typeof m.content === 'string') el.textContent = m.content;
      else for (const p of m.content || []) {
        if (p.type === 'text') el.append(p.text);
        else if (p.type === 'image') el.append(h('img', { src: `data:${p.mimeType};base64,${p.data}` }));
      }
      return el;
    }
    case 'assistant': {
      const el = h('div', { class: 'msg assistant' });
      renderAssistantInto(el, m, false);
      return el;
    }
    case 'toolResult': {
      const c = cards.get(m.toolCallId);
      if (c) c.setResult({ content: m.content, details: m.details }, m.isError, false);
      return null;
    }
    case 'bashExecution': {
      const out = m.output ?? partsText(m.content);
      return h('details', { class: 'tool ' + (m.exitCode ? 'fail' : 'ok') },
        h('summary', {}, h('span', { class: 'tname', text: '!' + (m.excludeFromContext ? '!' : '') }), h('span', { class: 'tsum', text: m.command }), h('span', { class: 'tstat', text: m.exitCode ? `exit ${m.exitCode}` : '✓' })),
        h('div', { class: 'tbody' }, h('pre', { text: out || '(no output)' })));
    }
    default: {
      if (m.display === false) return null;
      const txt = partsText(m.content) || m.summary || m.text || '';
      if (!txt) return null;
      return h('div', { class: 'msg note', text: `${m.customType || m.role}: ${txt.slice(0, 2000)}` });
    }
  }
}
function appendMessage(m) { const el = renderMessage(m); if (el) T().insertBefore(el, streamEl && streamEl.parentNode ? streamEl : null); }

function renderTranscript() {
  cards = new Map();
  streamEl = null;
  T().replaceChildren();
  const s = S.snap;
  if (!s) return;
  const frag = document.createDocumentFragment();
  for (const m of s.transcript) { const el = renderMessage(m); if (el) frag.append(el); }
  T().append(frag);
  for (const o of s.outputs || []) appendOutput(o.text);
  for (const t of s.live.tools || []) { const c = getCard(t.toolCallId, t.toolName, t.args, t.intent); c.setRunning(); if (t.partial) c.setResult(t.partial, false, true); }
  if (s.live.streaming) queueStream();
  stuck = true;
  requestAnimationFrame(() => { T().scrollTop = T().scrollHeight; });
}
function queueStream() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    const m = S.snap?.live.streaming;
    if (!m) return;
    if (!streamEl || !streamEl.parentNode) { streamEl = h('div', { class: 'msg assistant' }); T().append(streamEl); }
    renderAssistantInto(streamEl, m, true);
    stickScroll();
  });
}
function finalizeStream(m) {
  if (streamEl && streamEl.parentNode) { renderAssistantInto(streamEl, m, false); streamEl = null; }
  else { const el = renderMessage(m); if (el) T().append(el); }
}
function appendOutput(text) { T().append(h('div', { class: 'msg note cmd' }, ansiToEl(text))); stickScroll(); }
function note(text, isErr) { T().append(h('div', { class: 'msg note' + (isErr ? ' err' : ''), text })); stickScroll(); }

// ---------------------------------------------------------------- header / composer state
function modelLabel() {
  const m = S.snap?.state?.model;
  return m ? `${m.provider}/${m.id}` : S.snap?.task.model || 'model';
}
function renderHeader() {
  const s = S.snap;
  const term = S.curTerm ? S.terms.find((x) => x.id === S.curTerm) : null;
  const t = s?.task || S.tasks.find((x) => x.id === S.cur);
  const tui = t?.mode === 'tui';
  const proj = !t && !term && S.curProject ? projById(S.curProject) : null;
  $('#taskTitle').textContent = term ? term.title : t ? t.name : proj ? proj.name : 'No task selected';
  $('#taskCwd').textContent = term ? term.cwd : t ? t.cwd : proj ? proj.path : '';
  $('#topControls').hidden = !t && !term;
  $('#topControls').classList.toggle('termOnly', !!term || tui);
  $('#topControls').classList.toggle('standalone', !!term);
  document.title = (t || term ? (term ? term.title : t.name) + ' · ' : '') + 'Co-π-lot';
  if (!t) { $('#banner').hidden = true; return; }
  $('#modeBtn').textContent = tui ? 'GUI' : 'TUI';
  $('#modeBtn').title = tui ? 'Back to the web GUI' : 'Open the full omp terminal UI for this session (every TUI-only feature)';
  $('#modelBtn').textContent = modelLabel();
  const m = s?.state?.model;
  const efforts = ['off', ...((m?.reasoning && m.thinking?.efforts) || [])];
  const cur = s?.state?.thinkingLevel || 'off';
  if (!efforts.includes(cur)) efforts.push(cur);
  const sel = $('#thinkSel');
  sel.replaceChildren(...efforts.map((e) => h('option', { value: e, text: 'think: ' + e, selected: e === cur })));
  sel.value = cur;
  const st = s?.stats;
  $('#statsChip').textContent = st ? `${st.contextUsage ? Math.round(st.contextUsage.percent) + '% ctx' : ''}${st.cost ? ' · $' + st.cost.toFixed(3) : ''}` || '—' : '—';
  $('#statsChip').title = st ? `tokens: ${st.tokens?.total ?? 0} (in ${st.tokens?.input ?? 0}, out ${st.tokens?.output ?? 0}, cache ${st.tokens?.cacheRead ?? 0})\nsession: ${st.sessionId}` : '';
  const banner = $('#banner');
  if (!tui && (t.status === 'stopped' || t.status === 'error')) {
    banner.hidden = false; banner.className = t.status === 'error' ? 'error' : '';
    banner.replaceChildren(
      h('div', {}, t.status === 'error' ? `omp stopped with an error: ${t.lastError || ''}` : 'This task is stopped. Its session is saved on disk.', ' ',
        h('button', { class: 'primary', text: 'Start', onclick: () => http('POST', `/api/tasks/${t.id}/start`).catch((e) => toast(e.message, 'error')) })),
      s?.stderr?.length ? h('pre', { text: s.stderr.join('\n') }) : null);
  } else if (t.status === 'starting') { banner.hidden = false; banner.className = ''; banner.textContent = 'Starting omp…'; }
  else banner.hidden = true;
}
$('#thinkSel').onchange = (e) => call({ type: 'set_thinking_level', level: e.target.value });

function isBusy() { const s = S.snap; return !!(s && (s.live.busy || s.state?.isStreaming || s.state?.isCompacting)); }
function renderComposerState() {
  const busy = isBusy();
  $('#abortBtn').hidden = !busy;
  $('#busyMode').hidden = !busy;
  $('#sendBtn').textContent = busy ? ($('#busyMode').value === 'steer' ? 'Steer' : 'Queue') : 'Send';
}
$('#busyMode').onchange = renderComposerState;
function renderQueue() {
  const q = S.snap?.state?.queuedMessages;
  const chips = [];
  for (const kind of ['steering', 'followUp']) {
    for (const m of q?.[kind] || []) {
      const text = typeof m === 'string' ? m : m.text || m.message || JSON.stringify(m);
      chips.push(h('span', { class: 'chip', title: text }, `${kind === 'steering' ? '↪ steer' : '⏭ next'}: ${text.slice(0, 40)}`,
        h('button', { text: '✕', title: 'Remove', onclick: () => call({ type: 'remove_queued_message', message: text, queue: kind }).then(() => call({ type: 'get_state' }, true)) })));
    }
  }
  $('#queue').replaceChildren(...chips);
}
function renderWidgets() {
  const L = S.snap?.live; if (!L) return;
  const els = Object.entries(L.widgets || {}).map(([k, lines]) => h('pre', { text: lines.join('\n') }));
  for (const [k, v] of Object.entries(L.status || {})) els.push(h('div', { class: 'muted', text: `${k}: ${v}` }));
  $('#widgets').replaceChildren(...els);
}

// ---------------------------------------------------------------- dialogs (approvals, ask, input)
function answer(id, resp) { wsSend({ t: 'ui', response: { id, ...resp } }); S.ui.delete(id); renderTray(); }
function renderTray() {
  $('#tray').replaceChildren(...[...S.ui.values()].map(dialogEl));
}
function dialogEl(r) {
  const id = r.id;
  const cancel = h('button', { text: 'Cancel', onclick: () => answer(id, { cancelled: true }) });
  if (r.method === 'select') {
    return h('div', { class: 'dialog' }, h('div', { class: 'dt', text: r.title }),
      h('div', { class: 'opts' }, ...(r.options || []).map((o, i) => h('button', {
        class: i === 0 ? 'primary' : /deny|reject|no$/i.test(o) ? 'danger' : '', text: o, title: r.optionDetails?.[i]?.description || '',
        onclick: () => answer(id, { value: o }) })), cancel));
  }
  if (r.method === 'confirm') {
    return h('div', { class: 'dialog' }, h('div', { class: 'dt', text: [r.title, r.message].filter(Boolean).join('\n') }),
      h('div', { class: 'opts' }, h('button', { class: 'primary', text: 'Yes', onclick: () => answer(id, { confirmed: true }) }), h('button', { text: 'No', onclick: () => answer(id, { confirmed: false }) })));
  }
  if (r.method === 'input' || r.method === 'editor') {
    const f = r.method === 'editor' ? h('textarea', { rows: 8, text: r.prefill || '' }) : h('input', { type: r.secret ? 'password' : 'text', placeholder: r.placeholder || '' });
    const go = () => answer(id, { value: f.value });
    f.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (r.method === 'input' || e.ctrlKey || e.metaKey)) { e.preventDefault(); go(); } });
    return h('div', { class: 'dialog' }, h('div', { class: 'dt', text: r.title }), f, h('div', { class: 'opts' }, h('button', { class: 'primary', text: 'Submit', onclick: go }), cancel));
  }
  if (r.method === 'ask') {
    const state = {};
    const qs = (r.questions || []).map((q) => {
      const st = (state[q.id] = { sel: new Set(), custom: '' });
      if (q.recommended != null && !q.multi && q.options[q.recommended]) st.sel.add(q.options[q.recommended].label);
      const custom = h('input', { type: 'text', placeholder: 'Other…', oninput: (e) => { st.custom = e.target.value; } });
      return h('div', { class: 'q' }, h('div', { class: 'dt', text: (q.header ? q.header + ': ' : '') + q.question }),
        ...q.options.map((o) => {
          const inp = h('input', { type: q.multi ? 'checkbox' : 'radio', name: id + q.id, checked: st.sel.has(o.label),
            onchange: (e) => { if (!q.multi) st.sel.clear(); e.target.checked ? st.sel.add(o.label) : st.sel.delete(o.label); } });
          return h('label', { class: 'opt' }, inp, h('span', {}, o.label, o.description ? h('div', { class: 'muted', text: o.description }) : null));
        }), custom);
    });
    const go = () => answer(id, { answers: (r.questions || []).map((q) => {
      const st = state[q.id]; const a = { id: q.id, selectedOptions: [...st.sel] };
      if (st.custom.trim()) { a.customInput = st.custom.trim(); if (!q.multi) a.selectedOptions = []; }
      return a; }) });
    return h('div', { class: 'dialog' }, ...qs, h('div', { class: 'opts' }, h('button', { class: 'primary', text: 'Submit', onclick: go }), cancel));
  }
  return h('div', { class: 'dialog' }, JSON.stringify(r));
}

// ---------------------------------------------------------------- composer
const input = $('#input');
function autosize() { input.style.height = 'auto'; input.style.height = Math.min(input.scrollHeight, 220) + 'px'; }
let slashSel = 0, slashItems = [];
function slashCandidates() {
  const v = input.value;
  if (!v.startsWith('/') || v.includes('\n')) return [];
  const cmds = S.snap?.commands || [];
  const sub = v.match(/^\/(\S+)\s(\S*)$/);
  if (sub) {
    const c = cmds.find((x) => x.name === sub[1] || (x.aliases || []).includes(sub[1]));
    return (c?.subcommands || []).filter((x) => x.name.startsWith(sub[2].toLowerCase())).slice(0, 30)
      .map((x) => ({ name: `${c.name} ${x.name}`, insert: `/${c.name} ${x.name} `, description: x.description || '' }));
  }
  if (v.includes(' ')) return [];
  const q = v.slice(1).toLowerCase();
  return cmds.filter((c) => c.name.toLowerCase().startsWith(q) || (c.aliases || []).some((a) => a.startsWith(q))).slice(0, 30)
    .map((c) => ({ name: c.name, insert: '/' + c.name + ' ', description: (c.input?.hint ? c.input.hint + ' — ' : '') + (c.description || '') }));
}
function renderSlash() {
  slashItems = slashCandidates();
  const pop = $('#slashPop');
  pop.hidden = !slashItems.length;
  slashSel = Math.min(slashSel, Math.max(0, slashItems.length - 1));
  pop.replaceChildren(...slashItems.map((c, i) => h('div', { class: i === slashSel ? 'sel' : '', onmousedown: (e) => { e.preventDefault(); pickSlash(i); } },
    h('span', { class: 'n', text: '/' + c.name }), h('span', { class: 'd', text: c.description }))));
}
function pickSlash(i) { const c = slashItems[i]; if (!c) return; input.value = c.insert; $('#slashPop').hidden = true; input.focus(); autosize(); renderSlash(); }
input.addEventListener('input', () => { autosize(); slashSel = 0; renderSlash(); });
input.addEventListener('keydown', (e) => {
  if (!$('#slashPop').hidden) {
    if (e.key === 'ArrowDown') { e.preventDefault(); slashSel = (slashSel + 1) % slashItems.length; renderSlash(); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); slashSel = (slashSel - 1 + slashItems.length) % slashItems.length; renderSlash(); return; }
    if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey && input.value.trim() !== slashItems[slashSel]?.insert.trim())) { e.preventDefault(); pickSlash(slashSel); return; }
    if (e.key === 'Escape') { $('#slashPop').hidden = true; return; }
  }
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing && !(matchMedia('(pointer:coarse)').matches)) { e.preventDefault(); send(); }
  if (e.key === 'Escape' && isBusy()) call({ type: 'abort' });
});
$('#sendBtn').onclick = send;
$('#abortBtn').onclick = () => call({ type: 'abort' });
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = (e) => { addFiles(e.target.files); e.target.value = ''; };
input.addEventListener('paste', (e) => { const f = [...(e.clipboardData?.files || [])].filter((x) => x.type.startsWith('image/')); if (f.length) { e.preventDefault(); addFiles(f); } });
$('#chat').addEventListener('dragover', (e) => e.preventDefault());
$('#chat').addEventListener('drop', (e) => { e.preventDefault(); addFiles(e.dataTransfer.files); });
function addFiles(files) {
  for (const f of files) {
    if (!f.type.startsWith('image/')) { toast('Only images can be attached', 'warning'); continue; }
    const r = new FileReader();
    r.onload = () => { const [, data] = String(r.result).split(','); S.attachments.push({ type: 'image', data, mimeType: f.type }); renderAttachments(); };
    r.readAsDataURL(f);
  }
}
function renderAttachments() {
  $('#attachments').replaceChildren(...S.attachments.map((a, i) => h('div', { class: 'attach' },
    h('img', { src: `data:${a.mimeType};base64,${a.data}` }), h('button', { text: '✕', onclick: () => { S.attachments.splice(i, 1); renderAttachments(); } }))));
}
function routeSlash(text) {
  const m = text.match(/^\/(\S+)(?:\s+(.*))?$/);
  if (!m) return false;
  const n = m[1].toLowerCase(), a = (m[2] || '').trim();
  if ((n === 'model' || n === 'models') && !a) { modelModal(); return true; }
  if ((n === 'settings' || n === 'config') && !a) { settingsPage(); return true; }
  if (n === 'agents' && !a) { agentsPage(); return true; }
  if (n === 'login' || n === 'logout') { accountsModal(); return true; }
  if ((n === 'resume' || n === 'sessions') && !a) { sessionsModal(); return true; }
  if (n === 'tree') { $('#panel').hidden = false; S.panelTab = 'history'; for (const x of $('#panelTabs').children) x.classList.toggle('active', x.dataset.tab === 'history'); renderPanel(); return true; }
  if (n === 'tui' || n === 'terminal') { switchMode(); return true; }
  return false;
}
async function send() {
  let text = input.value.trim();
  if (!text && !S.attachments.length) return;
  if (!S.attachments.length && routeSlash(text)) { input.value = ''; autosize(); $('#slashPop').hidden = true; return; }
  if (!S.snap || S.snap.task.status === 'stopped') return toast('Start the task first', 'warning');
  const images = S.attachments.slice();
  input.value = ''; S.attachments = []; renderAttachments(); autosize(); $('#slashPop').hidden = true;
  stuck = true;
  let r;
  if (text.startsWith('!') && !images.length) {
    const excl = text.startsWith('!!');
    r = await call({ type: 'bash', command: text.slice(excl ? 2 : 1).trim(), excludeFromContext: excl || undefined });
  } else {
    const cmd = { type: 'prompt', message: text };
    if (images.length) cmd.images = images;
    if (isBusy()) cmd.streamingBehavior = $('#busyMode').value;
    r = await call(cmd);
  }
  if (r === null) { input.value = text; autosize(); }
}

// ---------------------------------------------------------------- side panel
$('#panelBtn').onclick = () => { const p = $('#panel'); p.hidden = !p.hidden; store.set('panel', !p.hidden); renderPanel(); };
$('#panelTabs').addEventListener('click', (e) => {
  const b = e.target.closest('button'); if (!b) return;
  S.panelTab = b.dataset.tab;
  for (const x of $('#panelTabs').children) x.classList.toggle('active', x === b);
  renderPanel();
});
async function renderPanel() {
  if ($('#panel').hidden || !S.snap) return;
  const body = $('#panelBody');
  const tab = S.panelTab, st = S.snap.state || {};
  if (tab === 'plan') {
    const phases = st.todoPhases || [];
    body.replaceChildren(...(phases.length ? phases.map((p) => h('div', { class: 'card' }, h('strong', { text: p.name }),
      ...(p.tasks || []).map((t) => h('div', { class: 'todo ' + t.status }, { completed: '✓', in_progress: '●', abandoned: '✗', pending: '○' }[t.status] || '○', ' ', t.content)))) : [h('div', { class: 'muted', text: 'No todo plan yet. omp builds one while working on bigger tasks.' })]));
  } else if (tab === 'agents') {
    const d = await call({ type: 'get_subagents' }, true);
    if (tab !== S.panelTab) return;
    const list = d?.subagents || (Array.isArray(d) ? d : []);
    body.replaceChildren(...(list.length ? list.map((a) => {
      const id = a.id || a.subagentId || a.name;
      return h('div', { class: 'card' }, h('div', { class: 'row' }, h('strong', { class: 'grow', text: id }), h('span', { class: 'muted', text: a.status || '' })),
        a.description || a.task ? h('div', { class: 'muted', text: String(a.description || a.task).slice(0, 200) }) : null,
        h('div', { class: 'row' },
          h('button', { text: 'Steer', onclick: () => { const m = prompt(`Message for ${id}`); if (m) call({ type: 'steer_subagent', subagentId: id, message: m }); } }),
          h('button', { class: 'danger', text: 'Kill', onclick: () => call({ type: 'cancel_subagent', subagentId: id }).then(renderPanel) })));
    }) : [h('div', { class: 'muted', text: 'No subagents. omp fans work out to subagents via its task tool.' }), h('button', { text: 'Refresh', onclick: renderPanel })]));
  } else if (tab === 'history') {
    const d = await call({ type: 'get_entries' }, true);
    if (tab !== S.panelTab) return;
    const msgs = (d?.entries || []).filter((e) => e.type === 'message' && e.message && (e.message.role === 'user' && e.message.attribution !== 'agent' || e.message.role === 'assistant'));
    body.replaceChildren(h('div', { class: 'row' }, h('button', { text: 'Refresh', onclick: renderPanel }), h('button', { text: 'Fork whole session', onclick: () => call({ type: 'fork' }).then(() => toast('Forked into a new session file')) })),
      ...msgs.slice(-80).reverse().map((e) => {
        const txt = partsText(e.message.content).replace(/\s+/g, ' ').slice(0, 120) || '(tool call)';
        return h('div', { class: 'card' }, h('div', { class: 'muted', text: `${e.message.role} · ${new Date(e.timestamp).toLocaleTimeString()}` }), h('div', { text: txt }),
          h('div', { class: 'row' },
            h('button', { text: 'Fork here', onclick: async () => { if (await call({ type: 'fork', entryId: e.id })) toast('Forked from this message'); } }),
            e.message.role === 'user' ? h('button', { text: 'Rewind', title: 'Move the conversation back to before this message', onclick: async () => {
              const r = await call({ type: 'navigate_tree', entryId: e.id }); if (r?.editorText) { input.value = r.editorText; autosize(); input.focus(); } } }) : null));
      }));
  } else if (tab === 'settings') renderSettings(body, st);
}
function toggleRow(label, on, cmdType, key) {
  const cb = h('input', { type: 'checkbox', checked: !!on, onchange: (e) => call({ type: cmdType, enabled: e.target.checked }) });
  return h('label', { class: 'toggle' }, h('span', { text: label }), cb);
}
function selectRow(label, val, opts, cmdType, field) {
  return h('div', { class: 'field' }, h('label', { text: label }),
    h('select', { onchange: (e) => call({ type: cmdType, [field]: e.target.value }) }, ...opts.map((o) => h('option', { value: o, text: o, selected: o === val }))));
}
function renderSettings(body, st) {
  body.replaceChildren(
    h('div', { class: 'card' }, h('strong', { text: 'Session' }),
      h('div', { class: 'muted', text: st.sessionId || '' }),
      h('div', { class: 'row' },
        h('button', { text: 'Rename', onclick: () => renameTask() }),
        h('button', { text: 'New session', onclick: () => call({ type: 'new_session' }) }),
        h('button', { text: 'Compact', onclick: () => call({ type: 'compact' }) }))),
    h('div', { class: 'card' }, h('strong', { text: 'Behaviour' }),
      toggleRow('Auto-compaction', st.autoCompactionEnabled, 'set_auto_compaction'),
      st.autoRetryEnabled !== undefined ? toggleRow('Auto-retry', st.autoRetryEnabled, 'set_auto_retry') : toggleRow('Auto-retry', true, 'set_auto_retry'),
      st.fastModeEnabled !== undefined ? toggleRow('Fast mode', st.fastModeEnabled, 'set_fast_mode') : null,
      st.slowModeSupported ? toggleRow('Slow mode', st.slowModeEnabled, 'set_slow_mode') : null,
      selectRow('Steering mode', st.steeringMode, ['one-at-a-time', 'all'], 'set_steering_mode', 'mode'),
      selectRow('Follow-up mode', st.followUpMode, ['one-at-a-time', 'all'], 'set_follow_up_mode', 'mode'),
      selectRow('Interrupt mode', st.interruptMode, ['immediate', 'wait'], 'set_interrupt_mode', 'mode')),
    h('div', { class: 'card' }, h('strong', { text: 'Everything else' }),
      h('div', { class: 'row' }, h('button', { text: 'All omp settings…', onclick: settingsPage }), h('button', { text: 'Models & roles…', onclick: modelsPage }), h('button', { text: 'Launch options…', onclick: launchOptionsModal }),
        h('button', { text: 'Files & config…', onclick: () => filesPage() }), h('button', { text: 'Raw RPC…', onclick: rawRpcModal }), h('button', { text: 'Full TUI', onclick: switchMode }))),
    h('div', { class: 'card' }, h('strong', { text: 'Accounts' }), h('button', { text: 'Manage provider logins…', onclick: accountsModal })),
    h('div', { class: 'card' }, h('strong', { text: 'Slash commands' }),
      h('div', { class: 'muted', text: 'Type / in the composer to autocomplete. Available: ' + (S.snap.commands || []).map((c) => '/' + c.name).join(' ') })));
}

// ---------------------------------------------------------------- modals & menus
function modal(content) {
  const box = $('#modalBox'); box.replaceChildren(...content); $('#modal').hidden = false;
}
function closeModal() { $('#modal').hidden = true; }
$('#modal').addEventListener('mousedown', (e) => { if (e.target.id === 'modal') closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') { closeModal(); $('#menu').hidden = true; } });
document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu') && !e.target.closest('#moreBtn')) $('#menu').hidden = true; });



async function sessionsModal() {
  modal([h('h3', { text: 'Past omp sessions' }), h('div', { class: 'muted', text: 'Loading…' })]);
  let d; try { d = await http('GET', '/api/sessions'); } catch (e) { return toast(e.message, 'error'); }
  modal([h('h3', { text: 'Past omp sessions' }), h('div', { class: 'muted', text: 'Adopt any session omp has stored on this machine (including ones started from the terminal) as a persistent task.' }),
    h('div', { class: 'list' }, ...d.sessions.map((s) => h('div', { class: 'item', onclick: async () => {
      if (!s.cwd) return toast('Session has no recorded directory', 'error');
      try { const { task } = await http('POST', '/api/tasks', { name: s.title || undefined, cwd: s.cwd, resume: s.file }); closeModal(); selectTask(task.id); } catch (e) { toast(e.message, 'error'); } } },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { text: s.title || '(untitled)' }), h('div', { class: 'muted mono', text: s.cwd || s.file })),
      h('span', { class: 'muted', text: s.adopted ? 'tracked' : relTime(s.mtime) })))),
    h('div', { class: 'actions' }, h('button', { text: 'Close', onclick: closeModal }))]);
}
async function modelModal() {
  modal([h('h3', { text: 'Choose model' }), h('div', { class: 'muted', text: 'Loading models…' })]);
  const d = await call({ type: 'get_available_models' });
  if (!d) return closeModal();
  const models = d.models || [];
  const q = h('input', { type: 'text', placeholder: 'Filter…', style: 'width:100%' });
  const list = h('div', { class: 'list' });
  const draw = () => {
    const f = q.value.toLowerCase();
    list.replaceChildren(...models.filter((m) => `${m.provider}/${m.id} ${m.name}`.toLowerCase().includes(f)).map((m) => h('div', { class: 'item', onclick: async () => { if (await call({ type: 'set_model', provider: m.provider, modelId: m.id })) closeModal(); } },
      h('div', { style: 'flex:1;min-width:0' }, h('div', { text: m.name || m.id }), h('div', { class: 'muted mono', text: `${m.provider}/${m.id}` })),
      h('span', { class: 'muted', text: `${m.reasoning ? '🧠 ' : ''}${m.contextWindow ? Math.round(m.contextWindow / 1000) + 'k' : ''}` }))));
  };
  q.oninput = draw; draw();
  modal([h('h3', { text: 'Choose model' }), q, list, h('div', { class: 'actions' }, h('button', { text: 'Close', onclick: closeModal }))]);
  q.focus();
}
async function accountsModal() {
  const d = await call({ type: 'get_login_providers' });
  if (!d) return;
  const provs = d.providers || (Array.isArray(d) ? d : []);
  modal([h('h3', { text: 'Provider logins' }), h('div', { class: 'muted', text: 'OAuth logins run on the server. A link will appear to open in your browser.' }),
    h('div', { class: 'list' }, ...provs.map((p) => { const id = p.id || p.providerId || p; return h('div', { class: 'item' },
      h('span', { style: 'flex:1', text: p.name || id }),
      h('button', { text: 'Login', onclick: async () => { closeModal(); toast('Starting login…'); const r = await call({ type: 'login', providerId: id }); if (r) toast('Logged in to ' + (p.name || id)); } }),
      h('button', { text: 'Logout', onclick: async () => {
        const a = await call({ type: 'get_logout_accounts', providerId: id }); const acc = a?.accounts || [];
        if (!acc.length) return toast('No stored credentials for ' + (p.name || id), 'warning');
        for (const x of acc) if (confirm(`Remove ${x.label || x.credentialId}${x.detail ? ' (' + x.detail + ')' : ''}?`)) await call({ type: 'logout', providerId: id, credentialId: x.credentialId });
      } })); })),
    h('div', { class: 'actions' }, h('button', { text: 'Close', onclick: closeModal }))]);
}
async function renameTask() {
  const t = S.snap?.task; if (!t) return;
  const n = prompt('Task name', t.name); if (!n) return;
  await http('PATCH', `/api/tasks/${t.id}`, { name: n });
  call({ type: 'set_session_name', name: n }, true);
}
function menu(items, anchor) {
  const m = $('#menu');
  m.replaceChildren(...items.map((i) => i === '-' ? h('hr') : h('button', { text: i[0], onclick: () => { m.hidden = true; i[1](); } })));
  const r = anchor.getBoundingClientRect();
  m.hidden = false;
  m.style.top = r.bottom + 4 + 'px';
  m.style.left = Math.max(8, Math.min(r.right - 210, innerWidth - 220)) + 'px';
}
$('#moreBtn').onclick = (e) => {
  if (S.curTerm) { menu([['Close terminal', () => closeTerm(S.curTerm)], ['Open files…', () => filesPage()]], e.currentTarget); return; }
  const t = S.snap?.task; if (!t) return;
  const stopped = t.status === 'stopped' || t.status === 'error';
  const tui = t.mode === 'tui';
  menu([
    tui ? ['Back to web GUI', switchMode] : ['Open full omp TUI', switchMode],
    ...(tui ? [] : [
      ['Compact context', () => call({ type: 'compact' })],
      ['Hand off to fresh session', () => call({ type: 'handoff' }).then((r) => r && toast('Handoff complete'))],
      ['New session', () => call({ type: 'new_session' })],
      ['Export transcript (HTML)', async () => { try { const r = await http('POST', `/api/tasks/${t.id}/export`); window.open(r.url, '_blank'); } catch (x) { toast(x.message, 'error'); } }],
      ['Refresh from omp', () => wsSend({ t: 'attach', taskId: S.cur })],
      ['Raw RPC command…', rawRpcModal]]),
    ['Rename task…', renameTask],
    ['Launch options…', launchOptionsModal],
    ['Move to project…', () => moveToProjectModal(t)],
    ['Agents…', () => agentsPage()],
    ['Files & config…', () => filesPage()],
    '-',
    stopped ? ['Start task', () => http('POST', `/api/tasks/${t.id}/start`)] : ['Stop task (keeps session)', () => http('POST', `/api/tasks/${t.id}/stop`)],
    ['Restart task', restartTask],
    ['Remove task…', async () => { if (confirm(`Remove "${t.name}" from ohmypi-web? The omp session file stays on disk.`)) { await http('DELETE', `/api/tasks/${t.id}`); S.cur = null; S.snap = null; renderAll(); } }],
  ], e.currentTarget);
};
$('#modelBtn').onclick = modelModal;
$('#newTaskBtn').onclick = () => newTaskModal();
$('#newProjectBtn').onclick = () => newProjectModal();
$('#modeBtn').onclick = switchMode;
$('#newTermBtn').onclick = () => newTermModal();
$('#settingsBtn').onclick = settingsPage;
$('#modelsBtn').onclick = modelsPage;
$('#agentsBtn').onclick = () => agentsPage();
$('#cmdsBtn').onclick = () => commandsPage();
$('#filesBtn').onclick = () => filesPage();
initTermKeys();
initDock();
$('#emptyNew').onclick = () => newTaskModal();
$('#sessionsBtn').onclick = sessionsModal;
$('#menuBtn').onclick = () => document.body.classList.toggle('nav-open');
$('#scrim').onclick = () => document.body.classList.remove('nav-open');

// ---------------------------------------------------------------- orchestration
function renderAll() {
  const task = S.snap?.task;
  const has = !!S.cur;
  const tuiTask = has && task?.mode === 'tui';
  const showTerm = !!S.curTerm || tuiTask;
  const termId = S.curTerm || (tuiTask ? task.termId : null);
  $('#chat').hidden = showTerm;
  $('#termView').hidden = !showTerm;
  const projView = !has && !S.curTerm && !!projById(S.curProject);
  $('#empty').hidden = has || projView; $('#projectView').hidden = !projView; $('#composer').hidden = !has; T().hidden = !has;
  if (projView) renderProjectView();
  renderTasks(); renderTerms(); renderHeader();
  if (showTerm) {
    $('#dock').hidden = true;
    if (termId) mountTerm(termId);
    else { unmountTerm(); $('#termHost').replaceChildren(h('div', { class: 'pad muted', text: 'The terminal is not running.' })); }
  } else {
    unmountTerm();
    renderTranscript(); renderTray(); renderQueue(); renderWidgets(); renderComposerState(); renderDock();
    $('#panel').hidden = !(has && store.get('panel', false));
    renderPanel();
    if (has) input.focus({ preventScroll: true });
  }
}
document.addEventListener('visibilitychange', () => { if (!document.hidden && S.cur) { S.seen[S.cur] = Date.now(); store.set('seen', S.seen); renderTasks(); } });
setInterval(() => { if (S.tasks.length) renderTasks(); }, 30000);
boot();
