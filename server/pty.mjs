// Persistent pseudo-terminals. They keep running (and keep a scrollback buffer) when no browser is attached.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

// Prefer the prebuilt binding (no compiler needed on Linux); fall back to node-pty; terminals are optional.
let pty = null;
let ptyError = null;
for (const name of ['@homebridge/node-pty-prebuilt-multiarch', 'node-pty']) {
  try { const m = await import(name); pty = m.default || m; ptyError = null; break; } catch (e) { ptyError = e; }
}
export const ptyAvailable = () => !!pty;
export const ptyProblem = () => (ptyError ? ptyError.message : null);

const MAX_BUFFER = 2 * 1024 * 1024;

export function resolveBin(name) {
  if (!name) return name;
  const win = process.platform === 'win32';
  const exts = win ? (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').concat(['']) : [''];
  const tryFile = (f) => { try { return fs.statSync(f).isFile() ? f : null; } catch { return null; } };
  if (path.isAbsolute(name) || name.includes('/') || name.includes('\\')) return tryFile(name) || name;
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    for (const e of exts) { const f = tryFile(path.join(dir, name + e.toLowerCase())) || tryFile(path.join(dir, name + e)); if (f) return f; }
  }
  return name;
}

export function defaultShell() {
  if (process.platform === 'win32') {
    const pw = resolveBin('pwsh');
    return pw !== 'pwsh' ? pw : resolveBin('powershell');
  }
  return process.env.SHELL || '/bin/bash';
}

export class Term extends EventEmitter {
  constructor({ id, title, cwd, file, args = [], env = {}, taskId = null, cols = 120, rows = 32 }) {
    super();
    Object.assign(this, { id, title, cwd, file, args, taskId, cols, rows });
    this.env = env;
    this.buffer = '';
    this.exited = false;
    this.exitCode = null;
    this.createdAt = Date.now();
  }

  start() {
    if (!pty) throw new Error('Terminal support unavailable: install @homebridge/node-pty-prebuilt-multiarch (or build node-pty). ' + (ptyError?.message || ''));
    this.p = pty.spawn(resolveBin(this.file), this.args, {
      name: 'xterm-256color',
      cols: this.cols,
      rows: this.rows,
      cwd: this.cwd,
      env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...this.env },
    });
    this.pid = this.p.pid;
    this.p.onData((d) => {
      this.buffer += d;
      if (this.buffer.length > MAX_BUFFER) this.buffer = this.buffer.slice(this.buffer.length - MAX_BUFFER * 0.75);
      this.emit('data', d);
    });
    this.p.onExit(({ exitCode }) => {
      this.exited = true;
      this.exitCode = exitCode;
      this.emit('exit', exitCode);
    });
  }

  write(d) { if (!this.exited) try { this.p.write(d); } catch {} }
  resize(c, r) {
    if (this.exited || !(c > 1 && r > 1)) return;
    this.cols = c; this.rows = r;
    try { this.p.resize(c, r); } catch {}
  }
  kill() { if (!this.exited) try { this.p.kill(); } catch {} }
  info() {
    return { id: this.id, title: this.title, cwd: this.cwd, taskId: this.taskId, exited: this.exited, exitCode: this.exitCode, createdAt: this.createdAt, cmd: [this.file, ...this.args].join(' ') };
  }
}

export class TermManager extends EventEmitter {
  constructor() { super(); this.terms = new Map(); }

  create(opts) {
    const t = new Term({ id: crypto.randomBytes(5).toString('hex'), ...opts });
    this.terms.set(t.id, t);
    t.on('data', (d) => this.emit('data', t.id, d));
    t.on('exit', (c) => { this.emit('exit', t.id, c); this.emit('list'); });
    t.start();
    this.emit('list');
    return t;
  }
  get(id) { return this.terms.get(id); }
  /** Standalone terminals only (task TUIs are shown through their task). */
  list() { return [...this.terms.values()].filter((t) => !t.taskId).map((t) => t.info()); }
  remove(id) {
    const t = this.terms.get(id);
    if (!t) return;
    t.kill();
    this.terms.delete(id);
    this.emit('list');
  }
  killAll() { for (const t of this.terms.values()) t.kill(); }
}
