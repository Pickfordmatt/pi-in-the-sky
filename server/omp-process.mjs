// Thin wrapper around one `omp --mode rpc-ui` child process.
// Speaks omp's JSONL RPC protocol (v2 when available, including rpc_chunk reassembly).
import { spawn, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';

export class OmpProcess extends EventEmitter {
  constructor({ bin, args, cwd, env }) {
    super();
    this.bin = bin;
    this.args = args;
    this.cwd = cwd;
    this.env = env;
    this.child = null;
    this.pending = new Map(); // id -> {resolve,reject,timer}
    this.seq = 0;
    this.buf = '';
    this.chunks = null;
    this.exited = false;
    this.stderrTail = [];
    this.protocol = 1;
  }

  start() {
    this.child = spawn(this.bin, this.args, {
      cwd: this.cwd,
      env: this.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32', // own process group so kill() reaps omp's children too
    });
    this.pid = this.child.pid;
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (d) => this.#onData(d));
    this.child.stderr.on('data', (d) => {
      for (const line of String(d).split(/\r?\n/)) if (line) this.stderrTail.push(line);
      if (this.stderrTail.length > 200) this.stderrTail.splice(0, this.stderrTail.length - 200);
    });
    this.child.stdin.on('error', () => {});
    this.child.on('error', (err) => {
      this.stderrTail.push(`spawn error: ${err.message}`);
      this.#finish(-1);
    });
    this.child.on('exit', (code, signal) => this.#finish(code ?? (signal ? -2 : 0)));
  }

  #finish(code) {
    if (this.exited) return;
    this.exited = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error('omp process exited'));
    }
    this.pending.clear();
    this.emit('exit', code);
  }

  #onData(d) {
    this.buf += d;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        this.stderrTail.push(`non-JSON stdout: ${line.slice(0, 200)}`);
        continue;
      }
      this.#route(frame);
    }
  }

  #route(frame) {
    if (frame.type === 'rpc_chunk') {
      const c = this.chunks;
      if (!c || c.chunkId !== frame.chunkId) {
        if (frame.index !== 0) { this.chunks = null; return; }
        this.chunks = { chunkId: frame.chunkId, count: frame.count, next: 0, parts: [], byteLength: frame.byteLength };
      }
      const cur = this.chunks;
      if (frame.index !== cur.next) { this.chunks = null; return; }
      cur.parts.push(Buffer.from(frame.data, 'base64'));
      cur.next++;
      if (cur.next === cur.count) {
        this.chunks = null;
        try {
          this.#route(JSON.parse(Buffer.concat(cur.parts).toString('utf8')));
        } catch (e) {
          this.stderrTail.push(`chunk decode failed: ${e.message}`);
        }
      }
      return;
    }
    if (frame.type === 'ready') {
      this.ready = frame;
      if ((frame.supportedProtocolVersions || []).includes(2)) {
        this.call({ type: 'negotiate_protocol', protocolVersion: 2 }, 10000)
          .then((r) => { if (r.success) this.protocol = 2; })
          .catch(() => {})
          .finally(() => this.emit('frame', frame));
        return;
      }
      this.emit('frame', frame);
      return;
    }
    if (frame.type === 'response' && frame.id != null && this.pending.has(frame.id)) {
      const p = this.pending.get(frame.id);
      this.pending.delete(frame.id);
      clearTimeout(p.timer);
      p.resolve(frame);
      return;
    }
    this.emit('frame', frame);
  }

  send(obj) {
    if (this.exited || !this.child?.stdin.writable) return false;
    this.child.stdin.write(JSON.stringify(obj) + '\n');
    return true;
  }

  /** Send a command and resolve with the raw response frame (success true/false). */
  call(cmd, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      const id = `s${++this.seq}`;
      const timer = timeoutMs
        ? setTimeout(() => {
            this.pending.delete(id);
            reject(new Error(`omp command timed out: ${cmd.type}`));
          }, timeoutMs)
        : null;
      this.pending.set(id, { resolve, reject, timer });
      if (!this.send({ ...cmd, id })) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new Error('omp process is not running'));
      }
    });
  }

  /** Graceful stop: close stdin, then kill the process tree if it lingers. */
  async stop(graceMs = 8000) {
    if (this.exited) return;
    const done = new Promise((r) => this.once('exit', r));
    try { this.child.stdin.end(); } catch {}
    const t = setTimeout(() => this.kill(), graceMs);
    await done;
    clearTimeout(t);
  }

  kill() {
    if (this.exited || !this.pid) return;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(this.pid), '/T', '/F'], { windowsHide: true });
    } else {
      try { process.kill(-this.pid, 'SIGKILL'); } catch { try { process.kill(this.pid, 'SIGKILL'); } catch {} }
    }
  }
}
