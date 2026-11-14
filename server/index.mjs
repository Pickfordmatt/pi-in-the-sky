#!/usr/bin/env node
// ohmypi-web: HTTP + WebSocket front end for oh-my-pi. Each task is a real omp RPC process.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { WebSocketServer } from 'ws';
import { TaskManager, sanitizeLaunch } from './manager.mjs';
import { TermManager, defaultShell, ptyAvailable, ptyProblem, resolveBin } from './pty.mjs';
import { OmpCli } from './omp-cli.mjs';
import { AgentManager } from './agents.mjs';
import { ProjectStore } from './projects.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const HOST = process.env.OHMYPI_WEB_HOST || '127.0.0.1';
const PORT = Number(process.env.OHMYPI_WEB_PORT || process.env.PORT || 7878);
const DATA = process.env.OHMYPI_WEB_DATA || path.join(os.homedir(), '.ohmypi-web');
const OMP_BIN = process.env.OMP_BIN || 'omp';
// Default folder for new tasks, terminals and the file browser (the container image sets /workspace).
const WORKSPACE = process.env.OHMYPI_WEB_WORKSPACE && fs.existsSync(process.env.OHMYPI_WEB_WORKSPACE) ? process.env.OHMYPI_WEB_WORKSPACE : os.homedir();
const MAX_BODY = 25 * 1024 * 1024;
const MAX_UPLOAD = Number(process.env.OHMYPI_WEB_MAX_UPLOAD_MB || 1024) * 1024 * 1024;

fs.mkdirSync(path.join(DATA, 'exports'), { recursive: true });

// ---- auth -------------------------------------------------------------------
function loadToken() {
  if (process.env.OHMYPI_WEB_TOKEN) return process.env.OHMYPI_WEB_TOKEN;
  const f = path.join(DATA, 'token');
  try { return fs.readFileSync(f, 'utf8').trim(); } catch {}
  const t = crypto.randomBytes(24).toString('hex');
  fs.writeFileSync(f, t + '\n', { mode: 0o600 });
  return t;
}
const TOKEN = loadToken();
const COOKIE = 'ohmypi_web';
const cookieValue = crypto.createHmac('sha256', TOKEN).update('session-v1').digest('hex');
const safeEq = (a, b) => {
  const x = Buffer.from(String(a)), y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
function parseCookies(h = '') {
  const o = {};
  for (const p of h.split(';')) { const i = p.indexOf('='); if (i > 0) o[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim()); }
  return o;
}
function authed(req) {
  const c = parseCookies(req.headers.cookie)[COOKIE];
  if (c && safeEq(c, cookieValue)) return true;
  const a = req.headers.authorization;
  if (a?.startsWith('Bearer ') && safeEq(a.slice(7), TOKEN)) return true;
  return false;
}
const failures = new Map(); // ip -> {n, until}
function throttled(ip) {
  const f = failures.get(ip);
  return f && f.until > Date.now() && f.n >= 8;
}
function noteFailure(ip) {
  const f = failures.get(ip) || { n: 0, until: 0 };
  f.n++; f.until = Date.now() + 5 * 60 * 1000;
  failures.set(ip, f);
}

// ---- tasks ------------------------------------------------------------------
const terms = new TermManager();
const cli = new OmpCli({ bin: OMP_BIN, dataDir: DATA });
const agents = new AgentManager({ cli, dataDir: DATA });
const projects = new ProjectStore({ dataDir: DATA });
const mgr = new TaskManager({ dataDir: DATA, bin: resolveBin(OMP_BIN), terms, projects });
mgr.load();

// ---- HTTP -------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon', '.map': 'application/json',
  '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.pdf': 'application/pdf',
};
const VENDOR = {
  '/vendor/marked.js': path.join(ROOT, 'node_modules/marked/lib/marked.umd.js'),
  '/vendor/xterm.js': path.join(ROOT, 'node_modules/@xterm/xterm/lib/xterm.js'),
  '/vendor/xterm.css': path.join(ROOT, 'node_modules/@xterm/xterm/css/xterm.css'),
  '/vendor/xterm-fit.js': path.join(ROOT, 'node_modules/@xterm/addon-fit/lib/addon-fit.js'),
  '/vendor/xterm-links.js': path.join(ROOT, 'node_modules/@xterm/addon-web-links/lib/addon-web-links.js'),
  '/vendor/hljs.js': path.join(ROOT, 'node_modules/@highlightjs/cdn-assets/highlight.min.js'),
  '/vendor/codicon.css': path.join(ROOT, 'node_modules/@vscode/codicons/dist/codicon.css'),
  '/vendor/codicon.ttf': path.join(ROOT, 'node_modules/@vscode/codicons/dist/codicon.ttf'),
  '/vendor/fonts/inter.woff2': path.join(ROOT, 'node_modules/@fontsource-variable/inter/files/inter-latin-wght-normal.woff2'),
  '/vendor/fonts/inter-ext.woff2': path.join(ROOT, 'node_modules/@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2'),
  '/vendor/fonts/jbmono.woff2': path.join(ROOT, 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2'),
  '/vendor/fonts/jbmono-italic.woff2': path.join(ROOT, 'node_modules/@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-italic.woff2'),
  '/vendor/purify.js': path.join(ROOT, 'node_modules/dompurify/dist/purify.min.js'),
};

function json(res, code, obj) {
  const b = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(b);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let n = 0; const parts = [];
    req.on('data', (d) => { n += d.length; if (n > MAX_BODY) { reject(new Error('body too large')); req.destroy(); } else parts.push(d); });
    req.on('end', () => { try { resolve(parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
function serveFile(res, file, { download = false } = {}) {
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end('not found'); return; }
    const headers = { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream', 'cache-control': /\.(woff2|ttf)$/.test(file) ? 'public, max-age=31536000, immutable' : 'no-cache', 'content-length': st.size, 'x-content-type-options': 'nosniff' };
    if (download) {
      const name = path.basename(file);
      headers['content-disposition'] = `attachment; filename="${name.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(name)}`;
      headers['content-type'] = 'application/octet-stream';
    } else if (/\.(html?|svg|xml|xhtml)$/i.test(file) && !file.startsWith(PUBLIC)) {
      // never render user files as active content on our origin
      headers['content-type'] = 'text/plain; charset=utf-8';
    }
    res.writeHead(200, headers);
    fs.createReadStream(file).pipe(res);
  });
}

function safeIsDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }

function drives() {
  if (process.platform !== 'win32') return ['/'];
  const out = [];
  for (let c = 65; c <= 90; c++) { const d = String.fromCharCode(c) + ':\\'; try { if (fs.existsSync(d)) out.push(d); } catch {} }
  return out;
}

async function api(req, res, url) {
  const p = url.pathname;
  const m = req.method;
  const ip = req.socket.remoteAddress;

  if (p === '/api/login' && m === 'POST') {
    if (throttled(ip)) return json(res, 429, { error: 'Too many attempts. Try again later.' });
    const body = await readBody(req).catch(() => ({}));
    if (!body.token || !safeEq(body.token, TOKEN)) { noteFailure(ip); return json(res, 401, { error: 'Invalid token' }); }
    failures.delete(ip);
    const secure = req.headers['x-forwarded-proto'] === 'https' || req.socket.encrypted ? '; Secure' : '';
    res.setHeader('set-cookie', `${COOKIE}=${cookieValue}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${60 * 60 * 24 * 90}${secure}`);
    return json(res, 200, { ok: true });
  }
  if (p === '/api/logout' && m === 'POST') {
    res.setHeader('set-cookie', `${COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`);
    return json(res, 200, { ok: true });
  }
  if (!authed(req)) return json(res, 401, { error: 'unauthorized' });
  // CSRF: state-changing requests must be same-origin
  if (m !== 'GET' && req.headers.origin && new URL(req.headers.origin).host !== req.headers.host) {
    return json(res, 403, { error: 'cross-origin request refused' });
  }

  if (p === '/api/config' && m === 'GET') {
    let version = null;
    try { version = spawnSync(OMP_BIN, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim() || null; } catch {}
    return json(res, 200, { home: WORKSPACE, sep: path.sep, platform: process.platform, ompVersion: version, drives: drives(), terminals: ptyAvailable(), terminalProblem: ptyProblem(), shell: defaultShell() });
  }
  if (p === '/api/tasks' && m === 'GET') return json(res, 200, { tasks: mgr.list() });
  if (p === '/api/tasks' && m === 'POST') {
    const body = await readBody(req);
    try {
      const t = await mgr.create(body);
      return json(res, 201, { task: t.summary() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  let mt = p.match(/^\/api\/tasks\/([a-f0-9]+)(?:\/(\w+))?$/);
  if (mt) {
    const task = mgr.get(mt[1]);
    if (!task) return json(res, 404, { error: 'no such task' });
    const act = mt[2];
    if (!act && m === 'DELETE') { await mgr.remove(task.id); return json(res, 200, { ok: true }); }
    if (!act && m === 'PATCH') {
      const b = await readBody(req);
      if (typeof b.name === 'string' && b.name.trim()) { task.meta.name = b.name.trim(); task.meta.userNamed = true; }
      if (b.launch && typeof b.launch === 'object') task.meta.launch = sanitizeLaunch(b.launch);
      if ('projectId' in b) task.meta.projectId = b.projectId && projects.get(b.projectId) ? b.projectId : null;
      mgr.saveNow(); mgr.emit('list');
      return json(res, 200, { task: task.summary() });
    }
    if (act === 'mode' && m === 'POST') {
      const b = await readBody(req);
      try { await task.switchMode(b.mode); return json(res, 200, { task: task.summary() }); } catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (act === 'start' && m === 'POST') { await task.start({ restore: false }); return json(res, 200, { task: task.summary() }); }
    if (act === 'stop' && m === 'POST') { await task.stop(); return json(res, 200, { task: task.summary() }); }
    if (act === 'export' && m === 'POST') {
      const name = `${task.id}-${Date.now()}.html`;
      const out = path.join(DATA, 'exports', name);
      const r = await task.rpc({ type: 'export_html', outputPath: out });
      if (!r.success) return json(res, 400, { error: r.error || 'export failed' });
      return json(res, 200, { url: `/api/exports/${name}` });
    }
  }
  mt = p.match(/^\/api\/exports\/([\w.-]+\.html)$/);
  if (mt && m === 'GET') return serveFile(res, path.join(DATA, 'exports', mt[1]));

  // ---- settings (driven by `omp config`) ----
  if (p === '/api/settings' && m === 'GET') {
    try { return json(res, 200, await cli.settings()); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (p === '/api/settings' && m === 'PUT') {
    const b = await readBody(req);
    try { return json(res, 200, await cli.setSetting(b.key, b.value, b.type)); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  mt = p.match(/^\/api\/settings\/([\w.-]+)$/);
  if (mt && m === 'DELETE') {
    try { return json(res, 200, await cli.resetSetting(mt[1])); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/omp/paths' && m === 'GET') {
    const { configFile, agentDir } = await cli.paths();
    return json(res, 200, { configFile, agentDir, home: os.homedir() });
  }

  // ---- projects ----
  if (p === '/api/projects' && m === 'GET') return json(res, 200, { projects: projects.list() });
  if (p === '/api/projects' && m === 'POST') {
    const b = await readBody(req);
    try { return json(res, 201, { project: await projects.create(b) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  mt = p.match(/^\/api\/projects\/([a-f0-9]+)$/);
  if (mt && m === 'PATCH') {
    const b = await readBody(req);
    try { return json(res, 200, { project: projects.update(mt[1], b) }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (mt && m === 'DELETE') {
    projects.remove(mt[1]);
    for (const t of mgr.tasks.values()) if (t.meta.projectId === mt[1]) t.meta.projectId = null;
    mgr.saveNow();
    return json(res, 200, { ok: true });
  }

  // ---- task agents (omp agent files + task.* agent settings) ----
  if (p === '/api/agents' && m === 'GET') {
    try { return json(res, 200, await agents.list(url.searchParams.get('cwd') || '')); } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (p === '/api/agents' && m === 'PUT') {
    const b = await readBody(req);
    try { return json(res, 200, await agents.save(b)); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/agents' && m === 'DELETE') {
    try { return json(res, 200, await agents.remove(url.searchParams.get('file') || '', url.searchParams.get('cwd') || '')); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/agents/override' && m === 'POST') {
    const b = await readBody(req);
    try { await agents.setOverride(b.name, b.kind, b.value); return json(res, 200, { ok: true }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/agents/generate' && m === 'POST') {
    const b = await readBody(req);
    if (!b.description || !String(b.description).trim()) return json(res, 400, { error: 'Describe the agent first' });
    try { return json(res, 200, await agents.generate(b)); } catch (e) { return json(res, 500, { error: e.message }); }
  }

  // ---- models ----
  if (p === '/api/omp/models' && m === 'GET') {
    try {
      const kind = url.searchParams.get('kind');
      return json(res, 200, await cli.json(['models', '--json', ...(kind ? ['--kind', kind] : [])], { timeoutMs: 90000 }));
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  if (p === '/api/omp/models/refresh' && m === 'POST') {
    const r = await cli.run(['models', 'refresh'], { timeoutMs: 180000 });
    return json(res, r.code === 0 ? 200 : 500, { output: (r.stdout + r.stderr).trim() });
  }

  // ---- omp subcommands ----
  if (p === '/api/omp/commands' && m === 'GET') return json(res, 200, { commands: await cli.commands() });
  if (p === '/api/omp/help' && m === 'GET') {
    try { return json(res, 200, { help: await cli.help(url.searchParams.get('cmd') || '') }); } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/omp/run' && m === 'POST') {
    const b = await readBody(req);
    if (!Array.isArray(b.args) || b.args.some((a) => typeof a !== 'string')) return json(res, 400, { error: 'args must be a string array' });
    const r = await cli.run(b.args, { cwd: b.cwd && fs.existsSync(b.cwd) ? b.cwd : undefined, timeoutMs: Math.min(Number(b.timeoutMs) || 120000, 600000), input: b.input });
    return json(res, 200, r);
  }

  // ---- terminals ----
  if (p === '/api/terms' && m === 'GET') return json(res, 200, { terms: terms.list() });
  if (p === '/api/terms' && m === 'POST') {
    const b = await readBody(req);
    if (!ptyAvailable()) return json(res, 400, { error: 'Terminal support unavailable: ' + (ptyProblem() || 'no PTY binding') });
    const cwd = b.cwd && fs.existsSync(b.cwd) ? b.cwd : WORKSPACE;
    let file, args, title;
    if (b.kind === 'omp') { file = resolveBin(OMP_BIN); args = Array.isArray(b.args) ? b.args.filter((a) => typeof a === 'string') : []; title = b.title || ['omp', ...args].join(' '); }
    else { file = defaultShell(); args = []; title = b.title || 'shell'; }
    try {
      const t = terms.create({ title, cwd, file, args, cols: b.cols, rows: b.rows });
      return json(res, 201, { term: t.info() });
    } catch (e) { return json(res, 500, { error: e.message }); }
  }
  mt = p.match(/^\/api\/terms\/([a-f0-9]+)$/);
  if (mt && m === 'DELETE') { terms.remove(mt[1]); return json(res, 200, { ok: true }); }

  // ---- files (full-trust: same access level as the terminal) ----
  if (p === '/api/files' && m === 'GET') {
    const dir = path.resolve(url.searchParams.get('path') || os.homedir());
    try {
      const ents = fs.readdirSync(dir, { withFileTypes: true }).slice(0, 5000).map((e) => {
        const full = path.join(dir, e.name);
        const isDir = e.isDirectory() || (e.isSymbolicLink() && safeIsDir(full));
        let size = null, mtime = null;
        try { const st = fs.statSync(full); size = isDir ? null : st.size; mtime = st.mtimeMs; } catch {}
        return { name: e.name, dir: isDir, size, mtime };
      });
      ents.sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
      const parent = path.dirname(dir);
      return json(res, 200, { path: dir, parent: parent === dir ? null : parent, entries: ents });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/file' && m === 'GET') {
    const f = path.resolve(url.searchParams.get('path') || '');
    try {
      const st = fs.statSync(f);
      if (!st.isFile()) return json(res, 400, { error: 'not a file' });
      if (url.searchParams.get('raw')) return serveFile(res, f, { download: !!url.searchParams.get('download') });
      if (st.size > 2 * 1024 * 1024) return json(res, 200, { path: f, size: st.size, tooLarge: true });
      const buf = fs.readFileSync(f);
      if (buf.subarray(0, 8000).includes(0)) return json(res, 200, { path: f, size: st.size, binary: true });
      return json(res, 200, { path: f, size: st.size, mtime: st.mtimeMs, content: buf.toString('utf8') });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  if (p === '/api/upload' && m === 'POST') {
    const dir = path.resolve(url.searchParams.get('dir') || '');
    const rel = String(url.searchParams.get('name') || '').replace(/\\/g, '/');
    const parts = rel.split('/').filter(Boolean);
    const BAD = process.platform === 'win32' ? /[<>:"|?*\x00-\x1f]/ : /\x00/; // Linux filenames may contain almost anything
    if (!parts.length || parts.some((x) => x === '.' || x === '..' || BAD.test(x))) return json(res, 400, { error: 'Invalid file name' });
    if (!safeIsDir(dir)) return json(res, 400, { error: 'Target folder does not exist' });
    const dest = path.join(dir, ...parts);
    if (!dest.startsWith(dir + path.sep)) return json(res, 400, { error: 'Invalid file name' });
    const declared = Number(req.headers['content-length'] || 0);
    if (declared > MAX_UPLOAD) return json(res, 413, { error: `File exceeds the ${MAX_UPLOAD / 1048576} MB upload limit` });
    if (fs.existsSync(dest) && url.searchParams.get('overwrite') !== '1') return json(res, 409, { error: 'exists', path: dest });
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const tmp = dest + `.upload-${process.pid}-${Date.now()}`;
    const out = fs.createWriteStream(tmp);
    let bytes = 0, failed = false;
    const fail = (code, msg) => { if (failed) return; failed = true; out.destroy(); fs.rm(tmp, { force: true }, () => {}); if (!res.headersSent) json(res, code, { error: msg }); };
    req.on('data', (chunk) => { bytes += chunk.length; if (bytes > MAX_UPLOAD) { fail(413, 'Upload too large'); req.destroy(); } });
    req.on('aborted', () => fail(400, 'Upload aborted'));
    out.on('error', (e) => fail(500, e.message));
    out.on('finish', () => {
      if (failed) return;
      try { fs.renameSync(tmp, dest); return json(res, 201, { path: dest, size: bytes }); } catch (e) { fail(500, e.message); }
    });
    req.pipe(out);
    return;
  }
  if (p === '/api/file' && m === 'PUT') {
    const b = await readBody(req);
    const f = path.resolve(String(b.path || ''));
    try {
      if (b.expectMtime && fs.existsSync(f) && Math.abs(fs.statSync(f).mtimeMs - b.expectMtime) > 1) return json(res, 409, { error: 'File changed on disk since you opened it' });
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, String(b.content ?? ''), 'utf8');
      return json(res, 200, { ok: true, mtime: fs.statSync(f).mtimeMs });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }

  if (p === '/api/sessions' && m === 'GET') return json(res, 200, { sessions: mgr.listSessions() });
  if (p === '/api/fs' && m === 'GET') {
    let dir = url.searchParams.get('path') || os.homedir();
    dir = path.resolve(dir);
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
        .map((e) => e.name).sort((a, b) => a.localeCompare(b));
      const parent = path.dirname(dir);
      return json(res, 200, { path: dir, parent: parent === dir ? null : parent, entries, drives: drives() });
    } catch (e) { return json(res, 400, { error: e.message }); }
  }
  return json(res, 404, { error: 'not found' });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    if (VENDOR[url.pathname]) return serveFile(res, VENDOR[url.pathname]);
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const file = path.normalize(path.join(PUBLIC, rel));
    if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
    return serveFile(res, file);
  } catch (e) {
    if (!res.headersSent) json(res, 500, { error: e.message });
  }
});

// ---- WebSocket ----------------------------------------------------------------
const wss = new WebSocketServer({ noServer: true, maxPayload: 40 * 1024 * 1024 });
const clients = new Set(); // {ws, taskId}

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, 'http://x');
  const origin = req.headers.origin;
  if (url.pathname !== '/ws' || !authed(req) || (origin && new URL(origin).host !== req.headers.host)) {
    socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

const send = (ws, obj) => { if (ws.readyState === 1) ws.send(JSON.stringify(obj)); };

wss.on('connection', (ws) => {
  const c = { ws, taskId: null, termId: null, alive: true };
  clients.add(c);
  ws.on('pong', () => { c.alive = true; });
  send(ws, { t: 'tasks', tasks: mgr.list() });
  send(ws, { t: 'terms', terms: terms.list() });
  send(ws, { t: 'projects', projects: projects.list() });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.t === 'attach') {
      c.taskId = msg.taskId;
      const task = mgr.get(msg.taskId);
      if (!task) return send(ws, { t: 'error', error: 'no such task' });
      if (!task.alive && task.meta.desired !== 'stopped' && task.status !== 'starting') task.start({ restore: false });
      send(ws, { t: 'snapshot', ...task.snapshot() });
    } else if (msg.t === 'detach') {
      c.taskId = null;
    } else if (msg.t === 'rpc') {
      const task = mgr.get(c.taskId);
      if (!task) return send(ws, { t: 'response', reqId: msg.reqId, response: { success: false, error: 'No task selected' } });
      try {
        const r = await task.rpc(msg.cmd);
        send(ws, { t: 'response', reqId: msg.reqId, response: r });
      } catch (e) {
        send(ws, { t: 'response', reqId: msg.reqId, response: { success: false, error: e.message } });
      }
    } else if (msg.t === 'term-attach') {
      const term = terms.get(msg.id);
      if (!term) return send(ws, { t: 'term-gone', id: msg.id });
      c.termId = msg.id;
      if (msg.cols && msg.rows) term.resize(msg.cols, msg.rows);
      send(ws, { t: 'term-replay', id: term.id, data: term.buffer, exited: term.exited, exitCode: term.exitCode });
    } else if (msg.t === 'term-detach') {
      c.termId = null;
    } else if (msg.t === 'term-input') {
      terms.get(msg.id)?.write(String(msg.data ?? ''));
    } else if (msg.t === 'term-resize') {
      terms.get(msg.id)?.resize(msg.cols, msg.rows);
    } else if (msg.t === 'ui') {
      mgr.get(c.taskId)?.answerUi(msg.response);
    }
  });
  ws.on('close', () => clients.delete(c));
  ws.on('error', () => clients.delete(c));
});

projects.on('change', () => {
  const list = projects.list();
  for (const c of clients) send(c.ws, { t: 'projects', projects: list });
  mgr.emit('list'); // task -> project mapping may have changed
});
mgr.on('list', () => {
  const tasks = mgr.list();
  for (const c of clients) send(c.ws, { t: 'tasks', tasks });
});
terms.on('data', (id, data) => { for (const c of clients) if (c.termId === id) send(c.ws, { t: 'term-data', id, data }); });
terms.on('exit', (id, code) => { for (const c of clients) if (c.termId === id) send(c.ws, { t: 'term-exit', id, code }); });
terms.on('list', () => { const list = terms.list(); for (const c of clients) send(c.ws, { t: 'terms', terms: list }); });
mgr.on('task-event', (id, ev) => {
  for (const c of clients) if (c.taskId === id) send(c.ws, { t: 'event', ev });
});
mgr.on('task-snapshot', (id) => {
  const task = mgr.get(id);
  if (!task) return;
  const snap = { t: 'snapshot', ...task.snapshot() };
  for (const c of clients) if (c.taskId === id) send(c.ws, snap);
});

setInterval(() => {
  for (const c of clients) {
    if (!c.alive) { c.ws.terminate(); clients.delete(c); continue; }
    c.alive = false;
    try { c.ws.ping(); } catch {}
  }
}, 25000);

// ---- boot -------------------------------------------------------------------
server.listen(PORT, HOST, () => {
  const shown = HOST === '0.0.0.0' || HOST === '::' ? 'localhost' : HOST;
  console.log(`\n  🥧✈️  Co-π-lot (ohmypi-web) is cleared for take-off on http://${HOST}:${PORT}`);
  console.log(`  data dir : ${DATA}`);
  console.log(`  omp      : ${OMP_BIN}`);
  console.log(`  login    : http://${shown}:${PORT}/#token=${TOKEN}\n`);
  if (HOST !== '127.0.0.1' && HOST !== 'localhost' && HOST !== '::1') {
    console.log('  WARNING: listening on a non-loopback address. Anyone with the token can run commands as you.');
    console.log('           Put this behind HTTPS (reverse proxy, Tailscale, SSH tunnel).\n');
  }
  mgr.resumeAll();
});

let closing = false;
async function shutdown() {
  if (closing) return;
  closing = true;
  console.log('shutting down, stopping omp processes (tasks resume on next start)…');
  await mgr.shutdown();
  terms.killAll();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
