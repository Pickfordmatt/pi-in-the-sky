'use strict';
// Subagent dock: compact list of subagents beside the orchestrator chat; click one to read its chat.
// Uses helpers from app.js at call time (renderMessage, h, call, toast, S, cards, store).

const SUB = {
  subs: new Map(), // id -> {id, agent, status, progress, messages, cards, ...}
  sel: null,
  open: null, // null = auto (open when subagents exist), true/false = user choice
  wide: false,
  pick: false,
  view: 'agents', // 'agents' | 'files'
};

function subLoad(list) {
  SUB.subs = new Map();
  for (const x of list || []) SUB.subs.set(x.id, { ...x, messages: x.messages || [], cards: new Map() });
  if (!SUB.subs.has(SUB.sel)) SUB.sel = null;
  subAutoSelect();
}
function subReset() { SUB.subs = new Map(); SUB.sel = null; SUB.open = SUB.view === 'files' && SUB.open ? true : null; SUB.pick = false; fvReset(); }

function subAutoSelect() {
  const cur = SUB.subs.get(SUB.sel);
  if (cur && SUB.pick) return;
  const all = [...SUB.subs.values()].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
  const running = all.filter((x) => x.status === 'running');
  if (!cur || (cur.status !== 'running' && running.length)) SUB.sel = (running[0] || all[0])?.id ?? null;
}

function subOnEvent(ev) {
  if (ev.type === 'ww_subagent') {
    const prev = SUB.subs.get(ev.sub.id);
    SUB.subs.set(ev.sub.id, { messages: [], cards: new Map(), ...prev, ...ev.sub });
    subAutoSelect();
    renderDockSoon();
  } else if (ev.type === 'ww_sub_messages') {
    const s = SUB.subs.get(ev.id);
    if (!s) return;
    if (ev.reset) { s.messages = []; s.cards = new Map(); }
    s.messages.push(...ev.messages);
    if (SUB.sel === ev.id) { if (ev.reset) renderSubChat(); else appendSubChat(s, ev.messages); }
  }
}

let dockTimer = null;
function renderDockSoon() { if (dockTimer) return; dockTimer = setTimeout(() => { dockTimer = null; renderDock(); }, 150); }

const subRunning = () => [...SUB.subs.values()].filter((x) => x.status === 'running').length;

function dockVisible() {
  if (!S.snap || S.snap.task.mode === 'tui') return false;
  if (SUB.open !== null) return SUB.open;
  if (isPhone()) return false;                          // on a phone the dock covers the chat, so only open it on request
  return SUB.view === 'agents' && SUB.subs.size > 0;   // auto-open only for live subagents
}

function renderSubButton() {
  const b = $('#subBtn'); if (!b) return;
  const n = SUB.subs.size, r = subRunning();
  b.hidden = n === 0;
  b.replaceChildren(h('i', { class: 'codicon codicon-hubot' }), ' ' + (r || n), r ? h('span', { class: 'sub-word', text: ' running' }) : null);
  const vis = dockVisible();
  b.classList.toggle('on', vis && SUB.view === 'agents');
  $('#filesPanelBtn')?.classList.toggle('on', vis && SUB.view === 'files');
}

// red / amber / green: working = amber, done = green, failed or stopped = red
const subDot = (s) => ({ running: 'amber', pending: 'amber', completed: 'green', failed: 'red', aborted: 'red' }[s] || 'amber');
const subStateLabel = (s) => ({ running: 'Working', pending: 'Pending', completed: 'Done', failed: 'Failed', aborted: 'Stopped' }[s] || s);
const subTitle = (s) => s.id || s.agent;
const fmtTok = (n) => (n == null ? '–' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n));

/** One short line describing what the subagent was asked to do. */
function subBlurb(s) {
  let t = s.description || s.assignment || s.task || '';
  t = t.replace(/Complete assignment thoroughly:?/i, '').replace(/[#*`_>]/g, ' ').replace(/\bTarget\b:?/i, '').replace(/\s+/g, ' ').trim();
  const m = t.match(/^(.{20,110}?)(?:[.!?](?:\s|$)|$)/);
  t = (m ? m[1] : t.slice(0, 110)).trim();
  return t.length > 110 ? t.slice(0, 107) + '…' : t;
}

function renderDock() {
  const dock = $('#dock');
  const show = dockVisible();
  dock.hidden = !show;
  dock.classList.toggle('wide', SUB.wide);
  renderSubButton();
  if (!show) return;
  const r = subRunning();
  $('#dockTitle').textContent = SUB.subs.size ? `Agents ${r ? r + ' running' : SUB.subs.size}` : 'Agents';
  $('#dockTabAgents').classList.toggle('active', SUB.view === 'agents');
  $('#dockTabFiles').classList.toggle('active', SUB.view === 'files');
  $('#dockTabAgents').classList.toggle('live', r > 0 && SUB.view !== 'agents');
  $('#agentView').hidden = SUB.view !== 'agents';
  $('#fileView').hidden = SUB.view !== 'files';
  if (SUB.view === 'agents') {
    if (!SUB.subs.size) { $('#agentView').classList.add('picked'); $('#subList').replaceChildren(); $('#subDetail').replaceChildren(h('div', { class: 'fv-hint' }, h('i', { class: 'codicon codicon-hubot' }), h('div', { text: 'No subagents in this session yet. When omp delegates work with its task tool, each subagent appears here with its live status and chat.' }))); return; }
    renderSubList();
    renderSubDetail();
  } else if (FV.root !== S.snap.task.cwd || !$('#fvList')) fvShow();
}

function dockSetView(view, toggle) {
  if (toggle && dockVisible() && SUB.view === view) { SUB.open = false; renderDock(); return; }
  SUB.view = view;
  store.set('dockView', view);
  SUB.open = true;
  if (isPhone()) $('#panel').hidden = true;   // one overlay at a time on phones
  renderDock();
}

function renderSubList() {
  const box = $('#subList'); if (!box) return;
  const order = { running: 0, pending: 0 };
  const subs = [...SUB.subs.values()].sort((a, b) => (order[a.status] ?? 1) - (order[b.status] ?? 1) || (a.index ?? 0) - (b.index ?? 0));
  box.replaceChildren(...subs.map((s) => h('div', { class: 'subitem' + (s.id === SUB.sel ? ' sel' : ''), title: `${subTitle(s)} — ${subStateLabel(s.status)}`,
    onclick: () => { SUB.sel = s.id; SUB.pick = true; renderSubList(); renderSubDetail(); } },
    h('span', { class: 'rag ' + subDot(s.status) }),
    h('div', { class: 'subtext' }, h('div', { class: 'subname ell', text: subTitle(s) }), h('div', { class: 'subblurb ell', text: subBlurb(s) })))));
}

function renderSubDetail() {
  const box = $('#subDetail'); if (!box) return;
  const s = SUB.subs.get(SUB.sel);
  // Phones show the list or one subagent's chat, not both: "picked" switches to the chat.
  $('#agentView')?.classList.toggle('picked', !!(s && SUB.pick));
  if (!s) { box.replaceChildren(h('div', { class: 'muted pad', text: 'Select a subagent' })); return; }
  const p = s.progress || {};
  const ctxPct = p.contextTokens != null && p.contextWindow ? Math.round((p.contextTokens / p.contextWindow) * 100) : null;
  const stats = [subStateLabel(s.status), ctxPct != null ? `ctx ${ctxPct}%` : null, p.tokens != null ? `${fmtTok(p.tokens)} tok` : null, p.toolCount != null ? `${p.toolCount} tools` : null, p.resolvedModel].filter(Boolean).join(' · ');
  const now = s.status === 'running' ? (p.currentTool ? `⏵ ${p.currentTool} ${p.currentToolArgs || ''}` : p.lastIntent || '') : '';
  const steerIn = h('input', { type: 'text', placeholder: 'Steer this subagent…', onkeydown: (e) => { if (e.key === 'Enter') go(); } });
  const go = async () => { const m = steerIn.value.trim(); if (!m) return; steerIn.value = ''; const r = await call({ type: 'steer_subagent', subagentId: s.id, message: m }); if (r) toast('Sent to ' + subTitle(s)); };
  box.replaceChildren(
    h('div', { class: 'subhead' },
      h('div', { class: 'row' },
        h('button', { class: 'icon phone-only', title: 'All subagents', onclick: () => { SUB.pick = false; renderSubList(); renderSubDetail(); } }, h('i', { class: 'codicon codicon-arrow-left' })),
        h('span', { class: 'rag ' + subDot(s.status) }), h('strong', { class: 'grow ell', text: subTitle(s) }),
        s.agent ? h('button', { class: 'icon', title: `Open the "${s.agent}" agent definition`, onclick: () => { AG.q = s.agent; agentsPage(); } }, h('i', { class: 'codicon codicon-organization' })) : null,
        s.status === 'running' ? h('button', { class: 'danger sm', text: 'Kill', onclick: () => call({ type: 'cancel_subagent', subagentId: s.id }) }) : null),
      h('div', { class: 'muted ell', title: stats, text: stats }),
      now ? h('div', { class: 'mono ell subnow', title: now, text: now }) : null,
      ctxPct != null ? h('div', { class: 'bar ctx', title: `context ${fmtTok(p.contextTokens)} / ${fmtTok(p.contextWindow)}` }, h('div', { style: `width:${Math.min(100, ctxPct)}%` })) : null),
    h('div', { id: 'subChat', class: 'subchat' }),
    s.status === 'running' ? h('div', { class: 'row substeer' }, steerIn, h('button', { class: 'primary', text: 'Steer', onclick: go })) : null);
  renderSubChat();
}

function subRender(s, m, index) {
  const saved = cards;
  cards = s.cards;
  try {
    if (index === 0 && m.role === 'user') {
      const txt = typeof m.content === 'string' ? m.content : (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('\n');
      return h('details', { class: 'msg note' }, h('summary', { text: 'Full assignment' }), h('div', { style: 'white-space:pre-wrap', text: txt }));
    }
    return renderMessage(m);
  } finally { cards = saved; }
}
function renderSubChat() {
  const chat = $('#subChat'); const s = SUB.subs.get(SUB.sel);
  if (!chat || !s) return;
  s.cards = new Map();
  chat.replaceChildren();
  s.messages.forEach((m, i) => { const el = subRender(s, m, i); if (el) chat.append(el); });
  chat.scrollTop = chat.scrollHeight;
}
function appendSubChat(s, msgs) {
  const chat = $('#subChat'); if (!chat) return;
  const stick = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  const start = s.messages.length - msgs.length;
  msgs.forEach((m, i) => { const el = subRender(s, m, start + i); if (el) chat.append(el); });
  if (stick) chat.scrollTop = chat.scrollHeight;
}

function initDock() {
  SUB.wide = store.get('dockWide', false);
  $('#subBtn').onclick = () => dockSetView('agents', true);
  $('#filesPanelBtn').onclick = () => dockSetView('files', true);
  $('#dockTabs').addEventListener('click', (e) => { const b = e.target.closest('button[data-view]'); if (b) dockSetView(b.dataset.view); });
  $('#dockClose').onclick = () => { SUB.open = false; renderDock(); };
  $('#dockWide').onclick = () => { SUB.wide = !SUB.wide; store.set('dockWide', SUB.wide); renderDock(); };
  initFileView();
}
