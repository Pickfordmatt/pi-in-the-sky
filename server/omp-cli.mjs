// Helpers that drive the omp CLI itself (config, models, subcommands) so the UI always matches the installed omp.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveBin } from './pty.mjs';

export class OmpCli {
  constructor({ bin, dataDir }) {
    this.bin = resolveBin(bin);
    this.dataDir = dataDir;
    this.enumCache = null;
    this.enumPromise = null;
    this.versionCache = null;
  }

  run(args, { cwd, timeoutMs = 120000, input, env } = {}) {
    return new Promise((resolve) => {
      let out = '', err = '', done = false;
      const MAX = 8 * 1024 * 1024;
      let child;
      try {
        child = spawn(this.bin, args, { cwd: cwd || undefined, env: { ...process.env, NO_COLOR: '1', ...env }, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      } catch (e) { return resolve({ code: -1, stdout: '', stderr: e.message }); }
      const finish = (code) => { if (done) return; done = true; clearTimeout(t); resolve({ code, stdout: out, stderr: err }); };
      const t = setTimeout(() => { err += `\n[timed out after ${timeoutMs / 1000}s]`; try { child.kill(); } catch {} finish(-2); }, timeoutMs);
      child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
      child.stdout.on('data', (d) => { if (out.length < MAX) out += d; });
      child.stderr.on('data', (d) => { if (err.length < MAX) err += d; });
      child.on('error', (e) => { err += e.message; finish(-1); });
      child.on('close', (c) => finish(c ?? 0));
      child.stdin.on('error', () => {});
      child.stdin.end(input || '');
    });
  }

  async version() {
    if (!this.versionCache) this.versionCache = (await this.run(['--version'], { timeoutMs: 15000 })).stdout.trim() || 'unknown';
    return this.versionCache;
  }

  async json(args, opts) {
    const r = await this.run(args, opts);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || `omp exited ${r.code}`).trim());
    try { return JSON.parse(r.stdout); } catch { throw new Error('omp returned non-JSON output: ' + r.stdout.slice(0, 200)); }
  }

  // ---- settings ---------------------------------------------------------
  async #enumOptions(keys, version) {
    const file = path.join(this.dataDir, `enum-options-${version.replace(/[^\w.-]/g, '_')}.json`);
    let cache = {};
    try { cache = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
    const todo = keys.filter((k) => !(k in cache));
    let i = 0;
    const worker = async () => {
      while (i < todo.length) {
        const k = todo[i++];
        const r = await this.run(['config', 'set', k, '__ohmypi_probe__'], { timeoutMs: 20000 });
        const m = (r.stderr + r.stdout).match(/Valid values:\s*(.+)/);
        cache[k] = m ? m[1].split(',').map((s) => s.trim()).filter(Boolean) : null;
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
    if (todo.length) { try { fs.writeFileSync(file, JSON.stringify(cache)); } catch {} }
    return cache;
  }

  /**
   * omp's own settings layout. The plain `omp config list` groups keys under `[tab]` headers in display
   * order (the same tabs as the TUI settings panel) and prints enum choices as `(a|b|c)`; --json has neither.
   */
  async #layout(version) {
    if (this.layoutCache?.version === version) return this.layoutCache.map;
    const r = await this.run(['config', 'list'], { timeoutMs: 30000 });
    const map = {};
    let tab = 'general', order = 0;
    for (const raw of r.stdout.replace(/\x1b\[[0-9;]*m/g, '').split(/\r?\n/)) {
      const t = raw.match(/^\[([\w-]+)\]\s*$/);
      if (t) { tab = t[1]; continue; }
      const m = raw.match(/^\s+([\w.-]+) = .*\(([^()]*)\)\s*$/);
      if (m) map[m[1]] = { tab, order: order++, choices: m[2].includes('|') ? m[2].split('|').map((s) => s.trim()).filter(Boolean) : null };
    }
    if (order) this.layoutCache = { version, map };
    return map;
  }

  /** Every setting omp knows, with live values, enum options, omp's tab and "modified" markers. */
  async settings() {
    const version = await this.version();
    const [all, layout] = await Promise.all([this.json(['config', 'list', '--json']), this.#layout(version).catch(() => ({}))]);
    let global = {};
    try { global = await this.json(['config', 'list', '--json', '--scope', 'global']); } catch {}
    // Enum choices usually come from the layout; only probe the ones it didn't list.
    const enumKeys = Object.keys(all).filter((k) => all[k].type === 'enum' && !layout[k]?.choices);
    if (!enumKeys.length) { this.enumCache ||= {}; this.enumVersion = version; }
    if (!this.enumCache || this.enumVersion !== version) {
      if (!this.enumPromise) {
        this.enumPromise = this.#enumOptions(enumKeys, version).then((c) => { this.enumCache = c; this.enumVersion = version; }).finally(() => { this.enumPromise = null; });
      }
      // Don't block the first paint on probing ~100 enum keys; UI polls until ready.
    }
    const items = Object.entries(all).map(([key, v]) => ({
      key, type: v.type, value: v.value, description: v.description || '',
      options: (v.type === 'enum' && layout[key]?.choices) || this.enumCache?.[key] || undefined,
      tab: layout[key]?.tab || 'general', order: layout[key]?.order ?? 1e6,
      redacted: v.redacted || undefined,
      modified: Object.prototype.hasOwnProperty.call(global, key),
    }));
    items.sort((a, b) => a.order - b.order);
    return { version, items, optionsReady: !!this.enumCache };
  }

  async setSetting(key, value, type) {
    if (!/^[\w.-]+$/.test(key)) throw new Error('bad key');
    let v;
    if (type === 'array' || type === 'record') v = typeof value === 'string' ? value : JSON.stringify(value);
    else v = String(value);
    const r = await this.run(['config', 'set', key, v], { timeoutMs: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).replace(/\x1b\[[0-9;]*m/g, '').trim());
    return this.json(['config', 'get', key, '--json']).catch(() => ({}));
  }

  async resetSetting(key) {
    if (!/^[\w.-]+$/.test(key)) throw new Error('bad key');
    const r = await this.run(['config', 'reset', key], { timeoutMs: 30000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
    return this.json(['config', 'get', key, '--json']).catch(() => ({}));
  }

  /** omp's agent directory (what `omp config path` prints) and the config.yml inside it. */
  async paths() {
    if (!this.pathsCache) {
      const out = (await this.run(['config', 'path'])).stdout.trim();
      let agentDir = out, configFile = path.join(out, 'config.yml');
      try { if (fs.statSync(out).isFile()) { agentDir = path.dirname(out); configFile = out; } } catch {}
      if (!fs.existsSync(configFile) && fs.existsSync(path.join(agentDir, 'config.yaml'))) configFile = path.join(agentDir, 'config.yaml');
      this.pathsCache = { agentDir, configFile };
    }
    return this.pathsCache;
  }

  async configPath() { return (await this.paths()).configFile; }

  // ---- subcommands ------------------------------------------------------
  async commands() {
    const r = await this.run(['--help'], { timeoutMs: 20000 });
    const out = [];
    let inCmds = false;
    for (const line of r.stdout.split(/\r?\n/)) {
      if (/^COMMANDS/.test(line)) { inCmds = true; continue; }
      if (inCmds) {
        if (/^\S/.test(line)) break;
        const m = line.match(/^\s{2}(\S+)\s{2,}(.+)$/);
        if (m) out.push({ name: m[1], description: m[2] });
      }
    }
    return out;
  }

  async help(sub) {
    if (sub && !/^[\w-]+$/.test(sub)) throw new Error('bad command');
    const r = await this.run(sub ? [sub, '--help'] : ['--help'], { timeoutMs: 20000 });
    return (r.stdout || r.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  }
}
