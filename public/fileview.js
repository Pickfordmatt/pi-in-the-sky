'use strict';
// Right-panel file viewer for the current task's folder: browse, preview, download, drag-and-drop upload.
// Uses helpers from app.js at call time (h, $, http, toast, md, S, input, autosize, filesPage).

const FV = { root: null, dir: null, entries: [], parent: null, sel: null, uploads: [], loading: false };

const fmtSize = (n) => (n == null ? '' : n < 1024 ? `${n} B` : n < 1048576 ? `${(n / 1024).toFixed(1)} KB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MB` : `${(n / 1073741824).toFixed(2)} GB`);
const fmtWhen = (t) => { if (!t) return ''; const d = new Date(t), now = new Date(); return d.toDateString() === now.toDateString() ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : d.toLocaleDateString(); };
const sepOf = () => S.config?.sep || '/';
const joinP = (a, b) => a.replace(/[\\/]+$/, '') + sepOf() + b;
const IMG_EXT = /\.(png|jpe?g|gif|webp|bmp|ico|svg)$/i;
const LANG_BY_EXT = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin', cs: 'csharp', cpp: 'cpp', cc: 'cpp', c: 'c', h: 'c', hpp: 'cpp', php: 'php', sh: 'bash', bash: 'bash', zsh: 'bash', ps1: 'powershell', json: 'json', yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', xml: 'xml', html: 'xml', css: 'css', scss: 'scss', sql: 'sql', swift: 'swift', lua: 'lua', dockerfile: 'dockerfile', makefile: 'makefile', diff: 'diff', patch: 'diff' };

function fvIcon(e) {
  if (e.dir) return h('i', { class: 'codicon codicon-folder', style: 'color:#dcb67a' });
  const n = e.name.toLowerCase();
  const icon = IMG_EXT.test(n) ? 'file-media' : /\.(md|txt|rst)$/.test(n) ? 'markdown' : /\.(zip|tar|gz|tgz|7z|rar)$/.test(n) ? 'file-zip' : /\.(pdf)$/.test(n) ? 'file-pdf' : /\.(json|ya?ml|toml|ini|env)$/.test(n) ? 'json' : /\.[a-z]+$/.test(n) ? 'file-code' : 'file';
  return h('i', { class: 'codicon codicon-' + icon, style: 'color:var(--muted)' });
}

function fvReset() { FV.root = null; FV.dir = null; FV.entries = []; FV.sel = null; }

/** Called when the Files view becomes visible (or the task changes). */
async function fvShow() {
  const cwd = S.snap?.task?.cwd;
  if (!cwd) return;
  if (FV.root !== cwd) { FV.root = cwd; FV.dir = cwd; FV.sel = null; }
  fvRenderShell();
  await fvLoad(FV.dir);
}

async function fvLoad(dir) {
  FV.loading = true;
  try {
    const d = await http('GET', '/api/files?path=' + encodeURIComponent(dir));
    FV.dir = d.path; FV.parent = d.parent; FV.entries = d.entries;
  } catch (e) { toast(e.message, 'error'); }
  FV.loading = false;
  fvRenderCrumbs(); fvRenderList();
}

function fvRenderShell() {
  const box = $('#fileView'); if (!box) return;
  const up = h('input', { type: 'file', multiple: true, hidden: true, onchange: (e) => { fvUploadFiles([...e.target.files].map((f) => ({ file: f, rel: f.name }))); e.target.value = ''; } });
  box.replaceChildren(
    h('div', { class: 'fv-bar' },
      h('div', { class: 'fv-crumbs', id: 'fvCrumbs' }),
      h('button', { class: 'icon', title: 'Up one folder', onclick: () => FV.parent && fvLoad(FV.parent) }, h('i', { class: 'codicon codicon-arrow-up' })),
      h('button', { class: 'icon', title: 'Refresh', onclick: () => fvLoad(FV.dir) }, h('i', { class: 'codicon codicon-refresh' })),
      h('button', { class: 'icon', title: 'Upload files', onclick: () => up.click() }, h('i', { class: 'codicon codicon-cloud-upload' })), up),
    h('div', { class: 'fv-list', id: 'fvList' }),
    h('div', { class: 'fv-uploads', id: 'fvUploads' }),
    h('div', { class: 'fv-preview', id: 'fvPreview' }),
    h('div', { class: 'fv-drop', id: 'fvDrop', hidden: true }, h('i', { class: 'codicon codicon-cloud-upload' }), h('div', { id: 'fvDropText', text: 'Drop to upload' })));
  fvRenderPreview();
  fvRenderUploads();
}

function fvRel(p) {
  if (!FV.root || !p) return p || '';
  const r = FV.root.replace(/[\\/]+$/, '');
  return p === r ? '' : p.startsWith(r) ? p.slice(r.length + 1) : p;
}

function fvRenderCrumbs() {
  const box = $('#fvCrumbs'); if (!box) return;
  const inside = FV.dir && FV.root && (FV.dir === FV.root || FV.dir.startsWith(FV.root.replace(/[\\/]+$/, '') + sepOf()));
  const kids = [h('button', { class: 'crumb', title: FV.root, onclick: () => fvLoad(FV.root) }, h('i', { class: 'codicon codicon-root-folder' }), h('span', { text: FV.root ? FV.root.split(/[\\/]/).filter(Boolean).pop() : '' }))];
  if (inside) {
    let acc = FV.root.replace(/[\\/]+$/, '');
    for (const seg of fvRel(FV.dir).split(/[\\/]/).filter(Boolean)) {
      acc = joinP(acc, seg);
      const target = acc;
      kids.push(h('span', { class: 'sep', text: '›' }), h('button', { class: 'crumb', onclick: () => fvLoad(target), text: seg }));
    }
  } else kids.push(h('span', { class: 'sep', text: '›' }), h('span', { class: 'crumb out mono', title: FV.dir, text: FV.dir }));
  box.replaceChildren(...kids);
}

function fvRenderList() {
  const box = $('#fvList'); if (!box) return;
  if (!FV.entries.length) { box.replaceChildren(h('div', { class: 'muted pad', text: FV.loading ? 'Loading…' : 'Empty folder. Drop files here to upload.' })); return; }
  box.replaceChildren(...FV.entries.map((e) => {
    const full = joinP(FV.dir, e.name);
    return h('div', { class: 'fv-row' + (FV.sel === full ? ' sel' : '') + (e.name.startsWith('.') ? ' dim' : ''), title: full,
      onclick: () => (e.dir ? fvLoad(full) : fvOpen(full, e)) },
      fvIcon(e), h('span', { class: 'fv-name ell', text: e.name }),
      h('span', { class: 'fv-meta', text: e.dir ? '' : fmtSize(e.size) }),
      h('span', { class: 'fv-meta when', text: fmtWhen(e.mtime) }),
      !e.dir ? h('a', { class: 'fv-dl', title: 'Download', href: '/api/file?raw=1&download=1&path=' + encodeURIComponent(full), download: e.name, onclick: (ev) => ev.stopPropagation() }, h('i', { class: 'codicon codicon-cloud-download' })) : h('span', { class: 'fv-dl' }));
  }));
}

async function fvOpen(file, entry) {
  FV.sel = file;
  FV.preview = { file, entry, loading: true };
  fvRenderList(); fvRenderPreview();
  if (IMG_EXT.test(file)) { FV.preview = { file, entry, image: true }; fvRenderPreview(); return; }
  try {
    const d = await http('GET', '/api/file?path=' + encodeURIComponent(file));
    if (FV.sel !== file) return;
    FV.preview = { file, entry, ...d };
  } catch (e) { FV.preview = { file, entry, error: e.message }; }
  fvRenderPreview();
}

function fvRenderPreview() {
  const box = $('#fvPreview'); if (!box) return;
  const P = FV.preview;
  if (!P || !FV.sel) { box.replaceChildren(h('div', { class: 'fv-hint' }, h('i', { class: 'codicon codicon-file' }), h('div', { text: 'Select a file to preview it. Drag files or folders onto this panel to upload them here.' }))); return; }
  const name = P.file.split(/[\\/]/).pop();
  const dl = '/api/file?raw=1&download=1&path=' + encodeURIComponent(P.file);
  const actions = h('div', { class: 'fv-actions' },
    h('a', { class: 'btnlike', href: dl, download: name, title: 'Download' }, h('i', { class: 'codicon codicon-cloud-download' }), h('span', { text: 'Download' })),
    h('button', { title: 'Open in the editor', onclick: () => filesPage(P.file) }, h('i', { class: 'codicon codicon-edit' }), h('span', { text: 'Edit' })),
    h('button', { class: 'icon', title: 'Insert the path into the chat message', onclick: () => { const rel = fvRel(P.file) || P.file; input.value = (input.value ? input.value.replace(/\s*$/, ' ') : '') + rel + ' '; autosize(); input.focus(); } }, h('i', { class: 'codicon codicon-mention' })),
    h('button', { class: 'icon', title: 'Copy full path', onclick: () => { navigator.clipboard?.writeText(P.file); toast('Path copied'); } }, h('i', { class: 'codicon codicon-copy' })));
  let body;
  if (P.loading) body = h('div', { class: 'muted pad', text: 'Loading…' });
  else if (P.error) body = h('div', { class: 'err pad', text: P.error });
  else if (P.image) body = h('div', { class: 'fv-img' }, h('img', { src: '/api/file?raw=1&path=' + encodeURIComponent(P.file), alt: name }));
  else if (P.binary || P.tooLarge) body = h('div', { class: 'fv-hint' }, h('i', { class: 'codicon codicon-file-binary' }), h('div', { text: `${P.binary ? 'Binary file' : 'Large file'} (${fmtSize(P.size)}): no preview. Use Download.` }));
  else if (/\.md$/i.test(name)) body = h('div', { class: 'fv-md' }, md(P.content));
  else {
    const ext = (name.includes('.') ? name.split('.').pop() : name).toLowerCase();
    const lang = LANG_BY_EXT[ext];
    const code = h('code', { class: lang ? 'language-' + lang : '' });
    code.textContent = P.content;
    if (window.hljs && lang && hljs.getLanguage(lang) && P.content.length < 300000) { try { hljs.highlightElement(code); } catch {} }
    const lines = P.content.split('\n').length;
    body = h('div', { class: 'fv-code' }, h('pre', { class: 'fv-gutter', text: Array.from({ length: Math.min(lines, 20000) }, (_, i) => i + 1).join('\n') }), h('pre', { class: 'fv-src' }, code));
  }
  box.replaceChildren(
    h('div', { class: 'fv-phead' }, P.entry ? fvIcon(P.entry) : null, h('div', { class: 'grow' }, h('div', { class: 'fv-pname ell', text: name }), h('div', { class: 'muted ell', text: [fmtSize(P.size ?? P.entry?.size), P.entry?.mtime ? new Date(P.entry.mtime).toLocaleString() : ''].filter(Boolean).join(' · ') })), actions),
    body);
}

// ---------------------------------------------------------------- uploads
function fvRenderUploads() {
  const box = $('#fvUploads'); if (!box) return;
  const live = FV.uploads.slice(-6);
  box.hidden = !live.length;
  box.replaceChildren(...live.map((u) => h('div', { class: 'fv-up ' + u.state },
    h('i', { class: 'codicon codicon-' + (u.state === 'done' ? 'check' : u.state === 'error' ? 'error' : 'cloud-upload') }),
    h('span', { class: 'ell grow', text: u.rel }),
    h('span', { class: 'fv-meta', text: u.state === 'error' ? u.error : u.state === 'done' ? fmtSize(u.size) : `${Math.round(u.pct)}%` }),
    h('div', { class: 'fv-upbar' }, h('div', { style: `width:${u.state === 'done' ? 100 : u.pct}%` })))));
}

function fvSend(target, rel, file, overwrite) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload?dir=${encodeURIComponent(target)}&name=${encodeURIComponent(rel)}${overwrite ? '&overwrite=1' : ''}`);
    xhr.setRequestHeader('content-type', 'application/octet-stream');
    xhr.upload.onprogress = (e) => { if (e.lengthComputable) { const u = FV.uploads.find((x) => x.rel === rel && x.state === 'up'); if (u) { u.pct = (e.loaded / e.total) * 100; fvRenderUploads(); } } };
    xhr.onload = () => { let j = {}; try { j = JSON.parse(xhr.responseText); } catch {} resolve({ status: xhr.status, body: j }); };
    xhr.onerror = () => resolve({ status: 0, body: { error: 'Network error' } });
    xhr.send(file);
  });
}

async function fvUploadFiles(items) {
  if (!items.length || !FV.dir) return;
  const target = FV.dir;
  let overwriteAll = null;
  for (const { file, rel } of items) {
    const u = { rel, state: 'up', pct: 0, size: file.size };
    FV.uploads.push(u); fvRenderUploads();
    let r = await fvSend(target, rel, file, overwriteAll === true);
    if (r.status === 409) {
      if (overwriteAll === null) overwriteAll = confirm(`"${rel}" already exists in this folder.\n\nOverwrite existing files in this upload?`);
      if (overwriteAll) r = await fvSend(target, rel, file, true);
      else { u.state = 'error'; u.error = 'skipped (exists)'; fvRenderUploads(); continue; }
    }
    if (r.status === 201) { u.state = 'done'; u.size = r.body.size; } else { u.state = 'error'; u.error = r.body.error || `HTTP ${r.status}`; }
    fvRenderUploads();
  }
  const ok = items.length - FV.uploads.slice(-items.length).filter((u) => u.state === 'error').length;
  toast(`Uploaded ${ok} of ${items.length} file${items.length === 1 ? '' : 's'} to ${fvRel(target) || target.split(/[\\/]/).pop()}`, ok === items.length ? 'info' : 'warning');
  if (FV.dir === target) fvLoad(target);
  setTimeout(() => { FV.uploads = FV.uploads.filter((u) => u.state === 'up'); fvRenderUploads(); }, 6000);
}

/** Expand dropped items, including whole folders (webkitGetAsEntry), into {file, rel} pairs. */
async function fvCollect(dt) {
  const out = [];
  const walk = (entry, prefix) => new Promise((resolve) => {
    if (entry.isFile) entry.file((f) => { out.push({ file: f, rel: prefix + f.name }); resolve(); }, () => resolve());
    else if (entry.isDirectory) {
      const reader = entry.createReader();
      const batch = () => reader.readEntries(async (ents) => {
        if (!ents.length) return resolve();
        for (const e of ents) await walk(e, prefix + entry.name + '/');
        batch();
      }, () => resolve());
      batch();
    } else resolve();
  });
  const entries = [...(dt.items || [])].map((i) => (i.webkitGetAsEntry ? i.webkitGetAsEntry() : null)).filter(Boolean);
  if (entries.length) for (const e of entries) await walk(e, '');
  else for (const f of dt.files || []) out.push({ file: f, rel: f.name });
  return out;
}

function initFileView() {
  const box = $('#fileView');
  let depth = 0;
  const isFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
  box.addEventListener('dragenter', (e) => { if (!isFiles(e)) return; e.preventDefault(); depth++; const d = $('#fvDrop'); if (d) { d.hidden = false; $('#fvDropText').textContent = `Drop to upload to ${fvRel(FV.dir) || FV.dir?.split(/[\\/]/).pop() || 'this folder'}`; } });
  box.addEventListener('dragover', (e) => { if (!isFiles(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
  box.addEventListener('dragleave', (e) => { if (!isFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) { const d = $('#fvDrop'); if (d) d.hidden = true; } });
  box.addEventListener('drop', async (e) => {
    if (!isFiles(e)) return;
    e.preventDefault(); e.stopPropagation(); depth = 0;
    const d = $('#fvDrop'); if (d) d.hidden = true;
    fvUploadFiles(await fvCollect(e.dataTransfer));
  });
}
