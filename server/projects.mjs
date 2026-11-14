// Projects: named folders that group tasks, terminals, files and agents. Stored in <data>/projects.json.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';

const COLORS = ['#4daafc', '#73c991', '#cca700', '#c586c0', '#f48771', '#4ec9b0', '#d7ba7d', '#9cdcfe'];
const norm = (p) => {
  const r = path.resolve(p || '').replace(/[\\/]+$/, '');
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

/** Current git branch by reading .git/HEAD (no git binary needed); null when not a repo. */
function gitBranch(dir) {
  try {
    let gitDir = path.join(dir, '.git');
    const st = fs.statSync(gitDir);
    if (st.isFile()) { // worktree / submodule: "gitdir: <path>"
      const m = fs.readFileSync(gitDir, 'utf8').match(/gitdir:\s*(.+)/);
      if (!m) return null;
      gitDir = path.resolve(dir, m[1].trim());
    }
    const head = fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8').trim();
    const ref = head.match(/^ref:\s*refs\/heads\/(.+)$/);
    return ref ? ref[1] : head.slice(0, 7);
  } catch { return null; }
}

export class ProjectStore extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.file = path.join(dataDir, 'projects.json');
    this.items = [];
    try { this.items = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch {}
  }

  #save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.items, null, 2));
    fs.renameSync(tmp, this.file);
    this.emit('change');
  }

  get(id) { return this.items.find((p) => p.id === id) || null; }

  list() {
    return this.items.map((p) => {
      let exists = false;
      try { exists = fs.statSync(p.path).isDirectory(); } catch {}
      return { ...p, exists, branch: exists ? gitBranch(p.path) : null };
    });
  }

  /** Project whose folder contains `cwd` (deepest match wins). */
  match(cwd) {
    if (!cwd) return null;
    const c = norm(cwd);
    let best = null;
    for (const p of this.items) {
      const r = norm(p.path);
      if ((c === r || c.startsWith(r + path.sep)) && (!best || r.length > norm(best.path).length)) best = p;
    }
    return best?.id || null;
  }

  async create({ name, path: dir, mode = 'existing', repoUrl, color, defaults }) {
    if (!dir || !String(dir).trim()) throw new Error('Choose a folder');
    dir = path.resolve(String(dir).trim());
    if (mode === 'clone') {
      const url = String(repoUrl || '').trim();
      if (!url || url.startsWith('-') || /\s/.test(url)) throw new Error('Enter a valid repository URL');
      if (fs.existsSync(dir) && fs.readdirSync(dir).length) throw new Error('The target folder already exists and is not empty');
      fs.mkdirSync(path.dirname(dir), { recursive: true });
      await new Promise((resolve, reject) => {
        let err = '';
        const child = spawn('git', ['clone', '--', url, dir], { windowsHide: true, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } });
        const t = setTimeout(() => { child.kill(); reject(new Error('git clone timed out after 15 minutes')); }, 15 * 60 * 1000);
        child.stderr.on('data', (d) => { err += d; if (err.length > 20000) err = err.slice(-20000); });
        child.on('error', (e) => { clearTimeout(t); reject(new Error('git is not available: ' + e.message)); });
        child.on('close', (code) => { clearTimeout(t); code === 0 ? resolve() : reject(new Error((err.trim().split('\n').slice(-3).join(' ') || `git clone failed (${code})`))); });
      });
      if (!name) name = path.basename(dir).replace(/\.git$/, '');
    } else if (mode === 'create') {
      fs.mkdirSync(dir, { recursive: true });
    } else {
      let ok = false;
      try { ok = fs.statSync(dir).isDirectory(); } catch {}
      if (!ok) throw new Error(`Folder not found: ${dir}`);
    }
    if (this.items.some((p) => norm(p.path) === norm(dir))) throw new Error('A project already uses this folder');
    const p = {
      id: crypto.randomBytes(5).toString('hex'),
      name: String(name || path.basename(dir) || 'project').trim(),
      path: dir,
      color: color || COLORS[this.items.length % COLORS.length],
      defaults: defaults && typeof defaults === 'object' ? defaults : {},
      createdAt: Date.now(),
    };
    this.items.push(p);
    this.#save();
    return p;
  }

  update(id, patch) {
    const p = this.get(id);
    if (!p) throw new Error('No such project');
    if (typeof patch.name === 'string' && patch.name.trim()) p.name = patch.name.trim();
    if (typeof patch.color === 'string') p.color = patch.color;
    if (patch.defaults && typeof patch.defaults === 'object') p.defaults = patch.defaults;
    if (typeof patch.path === 'string' && patch.path.trim()) {
      const dir = path.resolve(patch.path.trim());
      let ok = false;
      try { ok = fs.statSync(dir).isDirectory(); } catch {}
      if (!ok) throw new Error(`Folder not found: ${dir}`);
      if (this.items.some((x) => x.id !== id && norm(x.path) === norm(dir))) throw new Error('A project already uses this folder');
      p.path = dir;
    }
    this.#save();
    return p;
  }

  remove(id) {
    const before = this.items.length;
    this.items = this.items.filter((p) => p.id !== id);
    if (this.items.length !== before) this.#save();
  }
}
