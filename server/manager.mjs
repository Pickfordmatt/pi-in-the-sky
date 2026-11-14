import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Task } from './task.mjs';

const LAUNCH_STR = ['model', 'smol', 'slow', 'plan', 'thinking', 'approvalMode', 'tools', 'profile', 'systemPrompt', 'appendSystemPrompt', 'planYoloInto', 'prewalkInto', 'maxCost', 'warnCost', 'maxTime', 'serviceTier', 'sessionDir', 'models', 'skills', 'prewalk'];
const LAUNCH_BOOL = ['autoApprove', 'noTools', 'noLsp', 'noPty', 'noSkills', 'noRules', 'noExtensions', 'noContextFiles', 'advisor', 'planYolo', 'allowHome'];
const LAUNCH_LIST = ['addDirs', 'configOverlays', 'hooks', 'extensions', 'extraArgs'];
export function sanitizeLaunch(l = {}) {
  const o = {};
  for (const k of LAUNCH_STR) if (typeof l[k] === 'string' && l[k].trim()) o[k] = l[k].trim();
  for (const k of LAUNCH_BOOL) if (l[k] === true) o[k] = true;
  for (const k of LAUNCH_LIST) if (Array.isArray(l[k])) o[k] = l[k].filter((x) => typeof x === 'string' && x.trim()).map((x) => x.trim());
  return o;
}

export class TaskManager extends EventEmitter {
  constructor({ dataDir, bin, terms, projects }) {
    super();
    this.dataDir = dataDir;
    this.bin = bin;
    this.terms = terms;
    this.projects = projects;
    this.file = path.join(dataDir, 'tasks.json');
    this.tasks = new Map();
    this.shuttingDown = false;
    this.saveTimer = null;
    this.listTimer = null;
  }

  #ctx() {
    const mgr = this;
    return {
      bin: this.bin,
      dataDir: this.dataDir,
      terms: this.terms,
      latestSession: (cwd, since) => this.latestSession(cwd, since),
      persist: () => this.#save(),
      get shuttingDown() { return mgr.shuttingDown; },
    };
  }

  load() {
    let list = [];
    try { list = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
    for (const meta of list) this.#register(new Task(meta, this.#ctx()));
  }

  /** Resume everything that was running when the server last went down. */
  async resumeAll() {
    for (const t of this.tasks.values()) {
      if (t.meta.desired === 'running') t.start({ restore: true });
    }
  }

  #register(task) {
    this.tasks.set(task.id, task);
    task.on('summary', () => this.#scheduleList());
    task.on('event', (ev) => this.emit('task-event', task.id, ev));
    task.on('snapshot', () => this.emit('task-snapshot', task.id));
  }

  #scheduleList() {
    if (this.listTimer) return;
    this.listTimer = setTimeout(() => {
      this.listTimer = null;
      this.emit('list');
    }, 100);
  }

  #save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 200);
  }

  saveNow() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      const tmp = this.file + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify([...this.tasks.values()].map((t) => t.meta), null, 2));
      fs.renameSync(tmp, this.file);
    } catch (e) {
      console.error('failed to save tasks.json:', e.message);
    }
  }

  /** Explicit project if it still exists, otherwise the project whose folder contains the task's cwd. */
  projectOf(t) {
    const pid = t.meta.projectId;
    if (pid && this.projects?.get(pid)) return pid;
    return this.projects?.match(t.meta.cwd) || null;
  }

  list() {
    return [...this.tasks.values()]
      .map((t) => ({ ...t.summary(), projectId: this.projectOf(t) }))
      .sort((a, b) => b.lastActivity - a.lastActivity);
  }

  get(id) { return this.tasks.get(id); }

  async create({ name, cwd, launch, mode, model, thinking, approvalMode, prompt, resume, extraArgs, env, projectId }) {
    if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
      throw new Error(`Working directory not found: ${cwd}`);
    }
    const now = Date.now();
    const meta = {
      id: crypto.randomBytes(6).toString('hex'),
      name: (name || path.basename(cwd) || 'task').trim(),
      userNamed: !!name,
      cwd: path.resolve(cwd),
      mode: mode === 'tui' ? 'tui' : 'gui',
      projectId: projectId && this.projects?.get(projectId) ? projectId : null,
      launch: sanitizeLaunch(launch || { model, thinking, approvalMode, extraArgs }),
      env: env && typeof env === 'object' ? env : undefined,
      sessionFile: resume || null,
      sessionId: null,
      desired: 'running',
      createdAt: now,
      updatedAt: now,
      initialPrompt: prompt || undefined,
    };
    const task = new Task(meta, this.#ctx());
    this.#register(task);
    this.#save();
    await task.start({ restore: false });
    this.emit('list');
    return task;
  }

  /** Newest omp session recorded for this directory, modified at/after `since`. */
  latestSession(cwd, since = 0) {
    const norm = (p) => path.resolve(p || '').replace(/[\/]+$/, '').toLowerCase();
    const want = norm(cwd);
    return this.listSessions(60).find((s) => s.cwd && norm(s.cwd) === want && s.mtime >= since) || null;
  }

  async remove(id) {
    const t = this.tasks.get(id);
    if (!t) return;
    await t.stop().catch(() => {});
    this.tasks.delete(id);
    this.#save();
    this.emit('list');
  }

  /** Past omp sessions on disk (so they can be adopted as tasks). */
  listSessions(limit = 200) {
    const root = path.join(os.homedir(), '.omp', 'agent', 'sessions');
    const out = [];
    let dirs = [];
    try { dirs = fs.readdirSync(root); } catch { return out; }
    for (const d of dirs) {
      const dir = path.join(root, d);
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { continue; }
      for (const f of files) {
        const file = path.join(dir, f);
        try {
          const st = fs.statSync(file);
          out.push({ file, mtime: st.mtimeMs, size: st.size });
        } catch {}
      }
    }
    out.sort((a, b) => b.mtime - a.mtime);
    return out.slice(0, limit).map((s) => {
      let title = null, cwd = null, id = null;
      try {
        const fd = fs.openSync(s.file, 'r');
        const buf = Buffer.alloc(4096);
        const n = fs.readSync(fd, buf, 0, 4096, 0);
        fs.closeSync(fd);
        for (const line of buf.slice(0, n).toString('utf8').split('\n').slice(0, 3)) {
          try {
            const o = JSON.parse(line);
            if (o.type === 'title') title = o.title;
            if (o.type === 'session') { cwd = o.cwd; id = o.id; title = title || o.title; }
          } catch {}
        }
      } catch {}
      const adopted = [...this.tasks.values()].some((t) => t.meta.sessionFile === s.file);
      return { ...s, title, cwd, id, adopted };
    });
  }

  async shutdown() {
    this.shuttingDown = true;
    this.saveNow();
    await Promise.all([...this.tasks.values()].map((t) => t.dispose().catch(() => {})));
  }
}
