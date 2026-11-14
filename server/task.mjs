// A Task = one long-lived omp RPC process + a server-side mirror of its live state.
// The mirror lets any browser attach/detach at will while omp keeps working.
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { OmpProcess } from './omp-process.mjs';
import { ptyAvailable } from './pty.mjs';

const VALUE_FLAGS = {
  model: '--model', smol: '--smol', slow: '--slow', plan: '--plan', thinking: '--thinking', approvalMode: '--approval-mode',
  tools: '--tools', profile: '--profile', systemPrompt: '--system-prompt', appendSystemPrompt: '--append-system-prompt',
  planYoloInto: '--plan-yolo-into', prewalkInto: '--prewalk-into', maxCost: '--max-cost', warnCost: '--warn-cost',
  maxTime: '--max-time', serviceTier: '--service-tier', sessionDir: '--session-dir', models: '--models', skills: '--skills',
};
const BOOL_FLAGS = {
  autoApprove: '--auto-approve', noTools: '--no-tools', noLsp: '--no-lsp', noPty: '--no-pty', noSkills: '--no-skills',
  noRules: '--no-rules', noExtensions: '--no-extensions', noContextFiles: '--no-context-files', advisor: '--advisor',
  planYolo: '--plan-yolo', allowHome: '--allow-home',
};
const LIST_FLAGS = { addDirs: '--add-dir', configOverlays: '--config', hooks: '--hook', extensions: '-e' };
// Flags that only make sense for the first start of a session (a resumed session keeps its own model/thinking).
const NEW_SESSION_ONLY = new Set(['model', 'thinking']);

export function buildLaunchArgs(l = {}, { hasSession }) {
  const a = [];
  for (const [k, f] of Object.entries(VALUE_FLAGS)) {
    const v = l[k];
    if (v === undefined || v === null || v === '') continue;
    if (hasSession && NEW_SESSION_ONLY.has(k)) continue;
    a.push(f, String(v));
  }
  for (const [k, f] of Object.entries(BOOL_FLAGS)) if (l[k] === true) a.push(f);
  if (l.prewalk === 'on') a.push('--prewalk'); else if (l.prewalk === 'off') a.push('--no-prewalk');
  for (const [k, f] of Object.entries(LIST_FLAGS)) for (const v of l[k] || []) if (v) a.push(f, String(v));
  if (Array.isArray(l.extraArgs)) a.push(...l.extraArgs.filter((x) => typeof x === 'string'));
  return a;
}

function migrateLaunch(meta) {
  if (meta.launch) return;
  meta.launch = {
    model: meta.model || undefined, thinking: meta.thinking || undefined, approvalMode: meta.approvalMode || undefined,
    extraArgs: meta.extraArgs || [],
  };
}

const MAX_TEXT = 30000;
const DIALOG_METHODS = new Set(['select', 'confirm', 'input', 'editor', 'ask']);
// Commands that rewrite the transcript; reload history after they succeed.
const HISTORY_COMMANDS = new Set([
  'new_session', 'switch_session', 'open_session', 'branch', 'fork', 'navigate_tree', 'compact', 'handoff',
]);

function clip(s) {
  return typeof s === 'string' && s.length > MAX_TEXT
    ? s.slice(0, MAX_TEXT) + `\n… [${s.length - MAX_TEXT} more characters truncated by ohmypi-web]`
    : s;
}

/** Trim oversized tool output so snapshots stay light. */
export function sanitizeMessage(m) {
  if (!m || typeof m !== 'object') return m;
  if (Array.isArray(m.content) && (m.role === 'toolResult' || m.role === 'bashExecution')) {
    return { ...m, content: m.content.map((c) => (c?.type === 'text' ? { ...c, text: clip(c.text) } : c)) };
  }
  if (typeof m.output === 'string') return { ...m, output: clip(m.output) };
  return m;
}

function sanitizeResult(r) {
  if (r && Array.isArray(r.content)) {
    return { ...r, content: r.content.map((c) => (c?.type === 'text' ? { ...c, text: clip(c.text) } : c)) };
  }
  return r;
}

function slimModel(m) {
  if (!m) return m;
  const { provider, id, name, reasoning, contextWindow, input, thinking } = m;
  return { provider, id, name, reasoning, contextWindow, input, thinking };
}

export class Task extends EventEmitter {
  constructor(meta, ctx) {
    super();
    this.meta = meta; // persisted fields
    migrateLaunch(meta);
    meta.mode = meta.mode || 'gui';
    this.term = null;
    this.switching = false;
    this.outputs = [];
    this.ctx = ctx; // { bin, dataDir, persist() }
    this.proc = null;
    this.status = 'stopped'; // starting | idle | busy | needs_input | stopped | error
    this.state = null;
    this.transcript = [];
    this.live = this.#freshLive();
    this.commands = [];
    this.intentionalStop = false;
    this.restarts = [];
    this.lastActivity = meta.updatedAt || meta.createdAt;
    this.lastDoneAt = 0;
    this.preview = '';
    this.stats = null;
    this.#stateTimer = null;
    this.#histTimer = null;
    this.slashIds = new Set();
  }
  #stateTimer;
  #histTimer;

  #freshLive() {
    return { busy: false, streaming: null, tools: new Map(), ui: new Map(), status: {}, widgets: {}, subagents: new Map() };
  }

  get id() { return this.meta.id; }
  get rpcAlive() { return !!this.proc && !this.proc.exited; }
  get alive() { return this.meta.mode === 'tui' ? !!(this.term && !this.term.exited) : this.rpcAlive; }

  summary() {
    return {
      id: this.meta.id,
      name: this.meta.name,
      cwd: this.meta.cwd,
      status: this.status,
      desired: this.meta.desired,
      model: this.state?.model ? `${this.state.model.provider}/${this.state.model.id}` : this.meta.model || null,
      createdAt: this.meta.createdAt,
      lastActivity: this.lastActivity,
      lastDoneAt: this.lastDoneAt,
      preview: this.preview,
      pendingUi: this.live.ui.size,
      lastError: this.meta.lastError || null,
      mode: this.meta.mode,
      termId: this.term?.id || null,
    };
  }

  snapshot() {
    return {
      task: this.summary(),
      outputs: this.outputs,
      launch: this.meta.launch,
      state: this.state,
      transcript: this.transcript,
      commands: this.commands,
      stats: this.stats,
      live: {
        busy: this.live.busy,
        streaming: this.live.streaming,
        tools: [...this.live.tools.values()],
        ui: [...this.live.ui.values()],
        status: this.live.status,
        widgets: this.live.widgets,
        subagents: [...this.live.subagents.values()].map((x) => ({ ...this.#subSummary(x), messages: x.messages.slice(-150) })),
      },
      stderr: this.status === 'error' || this.status === 'stopped' ? this.proc?.stderrTail.slice(-30) || this.lastStderr || [] : undefined,
    };
  }

  #setStatus() {
    let s;
    if (this.meta.mode === 'tui') s = this.term && !this.term.exited ? 'tui' : this.status === 'error' ? 'error' : this.status === 'starting' ? 'starting' : 'stopped';
    else if (!this.rpcAlive) s = this.status === 'error' ? 'error' : this.status === 'starting' ? 'starting' : 'stopped';
    else if (!this.ready) s = 'starting';
    else if (this.live.ui.size) s = 'needs_input';
    else if (this.live.busy || this.state?.isStreaming || this.state?.isCompacting) s = 'busy';
    else s = 'idle';
    if (s !== this.status) {
      this.status = s;
    }
    this.emit('summary');
  }

  // ---- lifecycle ---------------------------------------------------------

  buildArgs({ rpc }) {
    const m = this.meta;
    const args = rpc ? ['--mode', 'rpc-ui', '--cwd', m.cwd] : ['--cwd', m.cwd];
    const file = m.sessionFile && fs.existsSync(m.sessionFile) ? m.sessionFile : null;
    if (file) args.push('--resume', file);
    args.push(...buildLaunchArgs(m.launch, { hasSession: !!file }));
    return args;
  }

  async start({ restore = false } = {}) {
    if (this.alive) return;
    if (this.meta.mode === 'tui') return this.#startTui();
    this.meta.desired = 'running';
    this.intentionalStop = false;
    this.continueAfterInit = restore && !!this.meta.wasBusy;
    this.ready = false;
    this.state = null;
    this.live = this.#freshLive();
    this.status = 'starting';
    this.ctx.persist();
    const env = { ...process.env, ...(this.meta.env || {}) };
    if (!fs.existsSync(this.meta.cwd)) {
      this.#fail(`Working directory does not exist: ${this.meta.cwd}`);
      return;
    }
    const proc = new OmpProcess({ bin: this.ctx.bin, args: this.buildArgs({ rpc: true }), cwd: this.meta.cwd, env });
    this.proc = proc;
    proc.on('frame', (f) => this.#onFrame(f, proc));
    proc.on('exit', (code) => this.#onExit(code, proc));
    try {
      proc.start();
    } catch (e) {
      this.#fail(e.message);
      return;
    }
    this.#setStatus();
    this.emit('snapshot');
  }

  #startTui() {
    this.meta.desired = 'running';
    this.intentionalStop = false;
    this.ctx.persist();
    if (!ptyAvailable()) return this.#fail('Terminal support is unavailable on this server (no PTY binding installed).');
    if (!fs.existsSync(this.meta.cwd)) return this.#fail(`Working directory does not exist: ${this.meta.cwd}`);
    this.tuiStartedAt = Date.now();
    try {
      const term = this.ctx.terms.create({ title: this.meta.name, cwd: this.meta.cwd, file: this.ctx.bin, args: this.buildArgs({ rpc: false }), env: this.meta.env || {}, taskId: this.id });
      this.term = term;
      term.on('exit', () => this.#onTermExit(term));
      this.status = 'tui';
      this.meta.lastError = null;
    } catch (e) { return this.#fail(e.message); }
    this.emit('summary');
    this.emit('snapshot');
  }

  #adoptLatestSession() {
    const s = this.ctx.latestSession?.(this.meta.cwd, (this.tuiStartedAt || 0) - 2000);
    if (s) { this.meta.sessionFile = s.file; this.meta.sessionId = s.id || this.meta.sessionId; this.ctx.persist(); }
  }

  #onTermExit(term) {
    if (term !== this.term) return;
    this.term = null;
    this.#adoptLatestSession();
    if (this.switching || this.ctx.shuttingDown) return;
    // The user quit the TUI (/exit): go back to the GUI, stopped.
    this.meta.mode = 'gui';
    this.meta.desired = 'stopped';
    this.status = 'stopped';
    this.ctx.persist();
    this.emit('summary');
    this.emit('snapshot');
  }

  /** Switch between the rich GUI (omp RPC) and the full omp terminal UI. They never run at once: omp sessions are single-owner. */
  async switchMode(mode) {
    if (!['gui', 'tui'].includes(mode)) throw new Error('bad mode');
    if (mode === this.meta.mode && this.alive) return;
    this.switching = true;
    try {
      if (this.rpcAlive) {
        if (this.live.busy) {
          await this.proc.call({ type: 'abort' }, 8000).catch(() => {});
          for (let i = 0; i < 20 && this.live.busy; i++) await new Promise((r) => setTimeout(r, 250));
        }
        this.intentionalStop = true;
        await this.proc.stop();
      }
      if (this.term && !this.term.exited) {
        const t = this.term;
        const gone = new Promise((r) => t.once('exit', r));
        t.kill();
        await Promise.race([gone, new Promise((r) => setTimeout(r, 4000))]);
      }
      this.#adoptLatestSession();
      this.term = null;
      this.meta.mode = mode;
      this.meta.wasBusy = false;
      this.intentionalStop = false;
      this.ctx.persist();
    } finally { this.switching = false; }
    await this.start({ restore: false });
  }

  #fail(msg) {
    this.meta.lastError = msg;
    this.status = 'error';
    this.ctx.persist();
    this.emit('summary');
    this.emit('snapshot');
  }

  async stop() {
    this.meta.desired = 'stopped';
    this.meta.wasBusy = false;
    this.intentionalStop = true;
    this.ctx.persist();
    if (this.term && !this.term.exited) { this.switching = true; this.term.kill(); this.#adoptLatestSession(); this.switching = false; this.term = null; }
    if (this.rpcAlive) await this.proc.stop();
    this.#setStatus();
  }

  #onExit(code, proc) {
    if (proc !== this.proc) return;
    this.lastStderr = proc.stderrTail.slice(-30);
    this.ready = false;
    this.live.busy = false;
    this.live.streaming = null;
    this.live.tools.clear();
    this.live.ui.clear();
    clearInterval(this.subTimer); this.subTimer = null;
    for (const sub of this.live.subagents.values()) if (sub.status === 'running') sub.status = 'aborted';
    if (this.intentionalStop || this.meta.desired !== 'running' || this.ctx.shuttingDown) {
      this.status = 'stopped';
    } else {
      // crashed or killed from outside: restart with --restore a few times
      const now = Date.now();
      this.restarts = this.restarts.filter((t) => now - t < 10 * 60 * 1000);
      if (this.restarts.length < 4 && !this.ctx.shuttingDown) {
        this.restarts.push(now);
        this.status = 'starting';
        this.emit('summary');
        setTimeout(() => !this.ctx.shuttingDown && this.start({ restore: true }), 1500);
        return;
      }
      this.status = 'error';
      this.meta.lastError = `omp exited with code ${code}`;
      this.ctx.persist();
    }
    this.emit('summary');
    this.emit('snapshot');
  }

  async #init(proc) {
    try {
      await this.refreshState();
      await this.loadHistory();
      const c = await proc.call({ type: 'get_available_commands' }, 15000).catch(() => null);
      if (c?.success) this.commands = c.data.commands || [];
      await proc.call({ type: 'set_subagent_subscription', level: 'progress' }, 15000).catch(() => {});
      this.#seedSubagents();
      this.ready = true;
      this.meta.lastError = null;
      this.#setStatus();
      this.emit('snapshot');
      if (this.continueAfterInit) {
        this.continueAfterInit = false;
        this.rpc({ type: 'prompt', message: 'The ohmypi-web server restarted while you were working. Check the state of the work so far and continue where you left off; if it was already finished, say so briefly.' }).catch(() => {});
      } else if (this.meta.initialPrompt) {
        const text = this.meta.initialPrompt;
        delete this.meta.initialPrompt;
        this.ctx.persist();
        this.rpc({ type: 'prompt', message: text }).catch(() => {});
      }
    } catch (e) {
      this.#fail(`init failed: ${e.message}`);
    }
  }

  // ---- state mirror ------------------------------------------------------

  async refreshState() {
    if (!this.rpcAlive) return;
    const r = await this.proc.call({ type: 'get_state' }, 20000);
    if (!r.success) return;
    const d = r.data;
    const { systemPrompt, ...rest } = d;
    this.state = { ...rest, model: slimModel(d.model) };
    if (d.sessionFile && (d.sessionFile !== this.meta.sessionFile || d.sessionId !== this.meta.sessionId)) {
      this.meta.sessionFile = d.sessionFile;
      this.meta.sessionId = d.sessionId;
      this.ctx.persist();
    }
    if (d.sessionName && d.sessionName !== this.meta.sessionName) {
      this.meta.sessionName = d.sessionName;
      if (!this.meta.userNamed) this.meta.name = d.sessionName;
      this.ctx.persist();
    }
    this.emit('event', { type: 'ww_state', state: this.state });
    this.#setStatus();
  }

  #scheduleState() {
    clearTimeout(this.#stateTimer);
    this.#stateTimer = setTimeout(async () => {
      await this.refreshState().catch(() => {});
      this.fetchStats();
      if (this.state && !this.live.busy && !this.state.isStreaming && this.state.messageCount != null &&
          this.state.messageCount !== this.transcript.length) {
        this.#scheduleHistory();
      }
    }, 200);
  }

  async fetchStats() {
    if (!this.rpcAlive) return;
    const r = await this.proc.call({ type: 'get_session_stats' }, 20000).catch(() => null);
    if (r?.success) {
      this.stats = r.data;
      this.emit('event', { type: 'ww_stats', stats: r.data });
    }
  }

  #scheduleHistory() {
    clearTimeout(this.#histTimer);
    this.#histTimer = setTimeout(() => this.loadHistory().then(() => this.emit('snapshot')).catch(() => {}), 250);
  }

  async loadHistory() {
    if (!this.rpcAlive) return;
    let messages = [];
    let ok = false;
    if (this.proc.protocol >= 2) {
      let cursor;
      try {
        for (let guard = 0; guard < 500; guard++) {
          const r = await this.proc.call({ type: 'get_messages_page', cursor, limit: 200 }, 60000);
          if (!r.success) { ok = false; break; }
          messages.push(...r.data.messages);
          ok = true;
          if (!r.data.nextCursor) break;
          cursor = r.data.nextCursor;
        }
      } catch { ok = false; }
    }
    if (!ok) {
      const r = await this.proc.call({ type: 'get_messages' }, 60000).catch(() => null);
      messages = r?.success ? r.data.messages || [] : [];
    }
    this.transcript = messages.map(sanitizeMessage);
    this.#updatePreview();
  }

  #updatePreview() {
    for (let i = this.transcript.length - 1; i >= 0; i--) {
      const m = this.transcript[i];
      if (m.role === 'assistant') {
        const t = (m.content || []).filter((c) => c.type === 'text').map((c) => c.text).join(' ').trim();
        if (t) { this.preview = t.slice(0, 140); return; }
      }
    }
  }

  // ---- frame handling ----------------------------------------------------

  #onFrame(f, proc) {
    if (proc !== this.proc) return;
    const bump = () => { this.lastActivity = Date.now(); };
    switch (f.type) {
      case 'ready':
        this.#init(proc);
        return;
      case 'available_commands_update':
        this.commands = f.commands || [];
        this.emit('event', { type: 'ww_commands', commands: this.commands });
        return;
      case 'extension_ui_request': {
        const m = f.method;
        if (DIALOG_METHODS.has(m)) {
          this.live.ui.set(f.id, f);
          bump();
          this.#setStatus();
          this.emit('event', f);
        } else if (m === 'cancel') {
          this.live.ui.delete(f.targetId);
          this.#setStatus();
          this.emit('event', { type: 'ww_ui_resolved', id: f.targetId });
        } else if (m === 'setStatus') {
          if (f.statusText == null) delete this.live.status[f.statusKey]; else this.live.status[f.statusKey] = f.statusText;
          this.emit('event', { type: 'ww_status', status: this.live.status });
        } else if (m === 'setWidget') {
          if (Array.isArray(f.widgetLines) && f.widgetLines.length) this.live.widgets[f.widgetKey] = f.widgetLines;
          else delete this.live.widgets[f.widgetKey];
          this.emit('event', { type: 'ww_widgets', widgets: this.live.widgets });
        } else {
          this.emit('event', f); // notify, open_url, set_editor_text, setTitle
        }
        return;
      }
      case 'agent_start':
        if (!this.meta.wasBusy) { this.meta.wasBusy = true; this.ctx.persist(); }
        this.live.busy = true; bump(); this.#setStatus();
        this.emit('event', f);
        return;
      case 'agent_end': {
        const { messages, ...rest } = f;
        if (f.yielded !== false) { this.live.busy = false; if (this.meta.wasBusy) { this.meta.wasBusy = false; this.ctx.persist(); } }
        bump();
        this.lastDoneAt = Date.now();
        this.#setStatus();
        this.emit('event', rest);
        this.#scheduleState();
        return;
      }
      case 'message_start':
        if (f.message?.role === 'assistant') this.live.streaming = f.message;
        this.emit('event', { type: 'message_start', message: f.message });
        return;
      case 'message_update':
        this.live.streaming = f.message;
        this.emit('event', { type: 'message_update', message: f.message });
        return;
      case 'message_end': {
        const m = sanitizeMessage(f.message);
        this.transcript.push(m);
        if (m.role === 'assistant') {
          this.live.streaming = null;
          this.#updatePreview();
        }
        bump();
        this.emit('event', { type: 'message_end', message: m });
        return;
      }
      case 'tool_execution_start': {
        const t = { toolCallId: f.toolCallId, toolName: f.toolName, args: f.args, intent: f.intent, partial: null };
        this.live.tools.set(f.toolCallId, t);
        this.emit('event', f);
        return;
      }
      case 'tool_execution_update': {
        const t = this.live.tools.get(f.toolCallId);
        const partial = sanitizeResult(f.partialResult);
        if (t) t.partial = partial;
        this.emit('event', { ...f, partialResult: partial });
        return;
      }
      case 'tool_execution_end':
        this.live.tools.delete(f.toolCallId);
        this.emit('event', { ...f, result: sanitizeResult(f.result) });
        return;
      case 'prompt_result':
        if (f.id && this.slashIds.delete(f.id)) { this.#scheduleState(); this.#scheduleHistory(); }
        this.emit('event', f);
        return;
      case 'session_settled':
        this.#scheduleState();
        this.emit('event', f);
        return;
      case 'subagent_lifecycle': {
        const p = f.payload || {};
        if (!p.id) return;
        const status = p.status === 'started' ? 'running' : p.status;
        const sub = this.#upsertSub(p.id, { agent: p.agent, index: p.index, description: p.description, sessionFile: p.sessionFile, parentToolCallId: p.parentToolCallId, detached: p.detached, status });
        this.#subChanged(sub);
        if (status !== 'running') { this.#fetchSubMessages(sub); setTimeout(() => this.#fetchSubMessages(sub), 700); }
        return;
      }
      case 'subagent_progress': {
        const p = f.payload || {};
        const pr = p.progress || {};
        const id = pr.id;
        if (!id) return;
        const sub = this.#upsertSub(id, { agent: p.agent, index: p.index, task: p.task, assignment: p.assignment, sessionFile: p.sessionFile, parentToolCallId: p.parentToolCallId, detached: p.detached, status: pr.status === 'pending' ? 'running' : pr.status, progress: pr });
        this.#subChanged(sub);
        return;
      }
      case 'manual_compaction_end':
      case 'auto_compaction_end':
        this.#scheduleHistory();
        this.#scheduleState();
        this.emit('event', f);
        return;
      case 'model_changed':
      case 'thinking_level_changed':
      case 'session_info_update':
      case 'config_update':
        this.#scheduleState();
        this.emit('event', f);
        return;
      case 'command_output':
        this.outputs.push({ ts: Date.now(), text: f.text });
        if (this.outputs.length > 40) this.outputs.shift();
        bump();
        this.emit('event', { type: 'command_output', text: f.text, ts: Date.now() });
        return;
      default:
        this.emit('event', f);
    }
  }

  // ---- subagents -----------------------------------------------------------

  #upsertSub(id, patch) {
    let sub = this.live.subagents.get(id);
    if (!sub) { sub = { id, messages: [], nextByte: 0, status: 'running', startedAt: Date.now() }; this.live.subagents.set(id, sub); }
    for (const [k, v] of Object.entries(patch)) if (v !== undefined) sub[k] = v;
    sub.lastUpdate = Date.now();
    this.#ensureSubTimer();
    return sub;
  }

  #subSummary(sub) {
    const { messages, nextByte, fetching, ...rest } = sub;
    if (rest.progress) {
      const pr = rest.progress;
      rest.progress = { ...pr, recentTools: (pr.recentTools || []).slice(-8), recentOutput: (pr.recentOutput || []).slice(-6) };
    }
    return rest;
  }

  #subChanged(sub) {
    this.lastActivity = Date.now();
    this.emit('event', { type: 'ww_subagent', sub: this.#subSummary(sub) });
  }

  async #fetchSubMessages(sub) {
    if (!this.rpcAlive || sub.fetching) return;
    sub.fetching = true;
    try {
      const r = await this.proc.call({ type: 'get_subagent_messages', subagentId: sub.id, fromByte: sub.nextByte || 0 }, 20000);
      if (!r.success) return;
      const d = r.data || {};
      const fresh = (d.messages || []).map(sanitizeMessage);
      if (d.reset) sub.messages = [];
      sub.nextByte = d.nextByte ?? sub.nextByte;
      if (d.sessionFile && !sub.sessionFile) sub.sessionFile = d.sessionFile;
      if (fresh.length || d.reset) {
        sub.messages.push(...fresh);
        if (sub.messages.length > 400) sub.messages.splice(0, sub.messages.length - 400);
        this.emit('event', { type: 'ww_sub_messages', id: sub.id, messages: fresh, reset: !!d.reset });
      }
    } catch {} finally { sub.fetching = false; }
  }

  #ensureSubTimer() {
    if (this.subTimer) return;
    this.subTimer = setInterval(() => {
      const running = [...this.live.subagents.values()].filter((x) => x.status === 'running');
      if (!this.rpcAlive || !running.length) { clearInterval(this.subTimer); this.subTimer = null; return; }
      for (const sub of running) this.#fetchSubMessages(sub);
    }, 1200);
  }

  async #seedSubagents() {
    const r = await this.proc.call({ type: 'get_subagents' }, 15000).catch(() => null);
    if (!r?.success) return;
    for (const a of r.data.subagents || []) {
      const sub = this.#upsertSub(a.id, { agent: a.agent, index: a.index, description: a.description, task: a.task, assignment: a.assignment, sessionFile: a.sessionFile, parentToolCallId: a.parentToolCallId, status: a.status === 'pending' ? 'running' : a.status, progress: a.progress });
      this.#fetchSubMessages(sub);
    }
  }

  // ---- commands from clients --------------------------------------------

  /** Forward any omp RPC command; returns the raw response frame. */
  async rpc(cmd) {
    if (!this.rpcAlive) throw new Error('Task is not running — start it first.');
    if (cmd.type === 'prompt' && typeof cmd.message === 'string' && cmd.message.startsWith('/')) {
      // builtin slash commands can change session state without an agent turn
      cmd = { ...cmd };
    }
    const noTimeout = ['prompt', 'abort_and_prompt', 'bash', 'compact', 'handoff', 'login', 'navigate_tree', 'btw'];
    const r = await this.proc.call(cmd, noTimeout.includes(cmd.type) ? 0 : 120000);
    if (r.success) {
      if (HISTORY_COMMANDS.has(cmd.type)) {
        if (cmd.type !== 'compact') this.live.subagents.clear();
        await this.loadHistory().catch(() => {});
        await this.refreshState().catch(() => {});
        this.emit('snapshot');
      } else if (cmd.type === 'prompt' && cmd.message?.startsWith('/')) {
        this.#scheduleState();
        this.#scheduleHistory();
      } else if (/^(set_|cycle_|goal)/.test(cmd.type) || cmd.type === 'abort') {
        this.#scheduleState();
      } else if (cmd.type === 'bash') {
        this.#scheduleHistory();
        this.#scheduleState();
      }
      if (cmd.type === 'set_session_name' && cmd.name) {
        this.meta.name = cmd.name;
        this.meta.userNamed = true;
        this.ctx.persist();
        this.emit('summary');
      }
    }
    return r;
  }

  answerUi(resp) {
    if (!this.rpcAlive || !resp?.id) return;
    if (!this.live.ui.has(resp.id)) return;
    this.proc.send({ ...resp, type: 'extension_ui_response' });
    this.live.ui.delete(resp.id);
    this.#setStatus();
    this.emit('event', { type: 'ww_ui_resolved', id: resp.id });
  }

  async dispose() {
    clearTimeout(this.#stateTimer);
    clearTimeout(this.#histTimer);
    if (this.term && !this.term.exited) this.term.kill();
    if (this.rpcAlive) await this.proc.stop(10000);
  }
}
