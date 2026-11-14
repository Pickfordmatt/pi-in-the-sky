'use strict';
// Projects: folders that group tasks in the sidebar, with a project home page.
// Uses helpers from app.js / ui.js / pages.js / agents.js at call time.

const PROJ_COLORS = ['#4daafc', '#73c991', '#cca700', '#c586c0', '#f48771', '#4ec9b0', '#d7ba7d', '#9cdcfe'];
const projById = (id) => (S.projects || []).find((p) => p.id === id) || null;
const projCollapsed = () => store.get('projCollapsed', {});
const baseName = (p) => String(p || '').split(/[\\/]/).filter(Boolean).pop() || '';
const pathJoin = (a, b) => String(a).replace(/[\\/]+$/, '') + (S.config?.sep || '/') + b;

function onProjects(list) {
  const first = !S.projectsLoaded;
  S.projects = list;
  S.projectsLoaded = true;
  if (S.curProject && !projById(S.curProject)) S.curProject = null;
  if (S.pendingProject && projById(S.pendingProject)) { const id = S.pendingProject; S.pendingProject = null; selectProject(id); return; }
  if (first && !S.cur && !S.pendingSelect) {
    const last = store.get('lastProject', null);
    if (last && projById(last)) { selectProject(last); return; }
  }
  renderTasks();
  if (S.curProject && !S.cur && !S.curTerm) { renderHeader(); renderProjectView(); }
}

function toggleProject(id) {
  const c = projCollapsed();
  c[id] = !c[id];
  store.set('projCollapsed', c);
  renderTasks();
}

function selectProject(id) {
  if (S.cur || S.curTerm) wsSend({ t: 'detach' });
  subReset();
  S.curProject = id; S.cur = null; S.curTerm = null; S.snap = null; S.ui.clear();
  store.set('lastProject', id);
  store.set('last', null);
  document.body.classList.remove('nav-open');
  renderAll();
}

// ---------------------------------------------------------------- sidebar
function taskRow(t, nested) {
  const unread = t.id !== S.cur && t.lastDoneAt > (S.seen[t.id] || 0);
  return h('div', { class: 'task' + (nested ? ' nested' : '') + (t.id === S.cur ? ' sel' : ''), onclick: () => selectTask(t.id) },
    h('div', { class: 't1' },
      h('span', { class: 'dot ' + t.status, title: t.status }),
      h('span', { class: 'name', text: t.name }),
      unread ? h('span', { class: 'unread', text: 'new' }) : null,
      h('span', { class: 'muted', text: relTime(t.lastActivity) })),
    h('div', { class: 'pv', text: t.status === 'needs_input' ? '⚠ waiting for your approval / answer' : t.preview || taskWhere(t) }));
}

/** Inside a project, show the task's subfolder (or its state) instead of repeating the project path. */
function taskWhere(t) {
  const p = projById(t.projectId);
  if (!p) return t.cwd;
  const root = p.path.replace(/[\/]+$/, '');
  const rel = t.cwd.length > root.length && t.cwd.toLowerCase().startsWith(root.toLowerCase()) ? t.cwd.slice(root.length + 1) : '';
  return rel ? '↳ ' + rel : t.mode === 'tui' ? 'terminal UI' : t.status;
}

function projectHeader(p, tasks, collapsed) {
  const attention = tasks.some((t) => t.status === 'needs_input') ? 'needs_input' : tasks.some((t) => t.status === 'busy' || t.status === 'starting') ? 'busy' : null;
  const sel = S.curProject === p.id && !S.cur && !S.curTerm;
  return h('div', { class: 'proj' + (sel ? ' sel' : ''), title: p.path, onclick: () => selectProject(p.id) },
    h('button', { class: 'proj-chev', title: collapsed ? 'Expand' : 'Collapse', onclick: (e) => { e.stopPropagation(); toggleProject(p.id); } },
      h('i', { class: 'codicon codicon-chevron-' + (collapsed ? 'right' : 'down') })),
    h('i', { class: 'codicon codicon-' + (p.exists === false ? 'warning' : collapsed ? 'folder' : 'folder-opened'), style: `color:${p.exists === false ? 'var(--warn)' : p.color}` }),
    h('span', { class: 'proj-name ell', text: p.name }),
    attention ? h('span', { class: 'dot ' + attention, title: attention === 'needs_input' ? 'A task needs your input' : 'A task is working' }) : null,
    p.branch ? h('span', { class: 'proj-branch ell', title: 'git branch' }, h('i', { class: 'codicon codicon-git-branch' }), p.branch) : null,
    h('span', { class: 'proj-count', text: tasks.length || '' }),
    h('button', { class: 'proj-add', title: `New task in ${p.name}`, onclick: (e) => { e.stopPropagation(); newTaskModal({ projectId: p.id }); } }, h('i', { class: 'codicon codicon-add' })));
}

function renderSidebarTasks() {
  const box = $('#taskList'); if (!box) return;
  const col = projCollapsed();
  const kids = [];
  const used = new Set();
  for (const p of S.projects || []) {
    const tasks = S.tasks.filter((t) => t.projectId === p.id);
    tasks.forEach((t) => used.add(t.id));
    // keep the selected task visible even inside a collapsed project
    const collapsed = !!col[p.id] && !tasks.some((t) => t.id === S.cur);
    kids.push(projectHeader(p, tasks, collapsed));
    if (!collapsed) {
      if (tasks.length) kids.push(...tasks.map((t) => taskRow(t, true)));
      else kids.push(h('div', { class: 'proj-empty', onclick: () => newTaskModal({ projectId: p.id }) }, h('i', { class: 'codicon codicon-add' }), 'New task'));
    }
  }
  const other = S.tasks.filter((t) => !used.has(t.id));
  if (other.length) {
    if ((S.projects || []).length) {
      const collapsed = !!col.__other && !other.some((t) => t.id === S.cur);
      kids.push(h('div', { class: 'proj other', onclick: () => toggleProject('__other') },
        h('button', { class: 'proj-chev' }, h('i', { class: 'codicon codicon-chevron-' + (collapsed ? 'right' : 'down') })),
        h('i', { class: 'codicon codicon-inbox', style: 'color:var(--muted)' }), h('span', { class: 'proj-name', text: 'Other tasks' }), h('span', { class: 'proj-count', text: other.length })));
      if (!collapsed) kids.push(...other.map((t) => taskRow(t, true)));
    } else kids.push(...other.map((t) => taskRow(t, false)));
  }
  if (!(S.projects || []).length) {
    kids.push(h('div', { class: 'proj-hint' }, h('i', { class: 'codicon codicon-folder-library' }),
      h('div', {}, 'Group tasks by folder with ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); newProjectModal(); }, text: 'a project' }), '.')));
  }
  box.replaceChildren(...kids);
}

// ---------------------------------------------------------------- project home
async function renderProjectView() {
  const box = $('#projectView');
  const p = projById(S.curProject);
  if (!box || !p) return;
  const tasks = S.tasks.filter((t) => t.projectId === p.id);
  const act = (icon, label, fn, primary, title) => h('button', { class: primary ? 'primary' : '', title: title || label, onclick: fn }, h('i', { class: 'codicon codicon-' + icon }), h('span', { text: label }));
  const sessBox = h('div', { class: 'pv-list' }, h('div', { class: 'muted pad', text: 'Looking for past omp sessions in this folder…' }));
  box.replaceChildren(
    h('div', { class: 'pv-wrap' },
      h('div', { class: 'pv-head' },
        h('div', { class: 'pv-tile', style: `background:${p.color}` }, h('i', { class: 'codicon codicon-folder-opened' })),
        h('div', { class: 'grow' },
          h('h1', { text: p.name }),
          h('div', { class: 'pv-sub' }, h('span', { class: 'mono', text: p.path }),
            p.branch ? h('span', { class: 'chip' }, h('i', { class: 'codicon codicon-git-branch' }), ' ' + p.branch) : null,
            p.exists === false ? h('span', { class: 'tag warn', text: 'folder missing' }) : null)),
        h('button', { class: 'icon', title: 'Project settings', onclick: () => projectSettingsModal(p) }, h('i', { class: 'codicon codicon-settings-gear' }))),
      h('div', { class: 'pv-actions' },
        act('add', 'New task', () => newTaskModal({ projectId: p.id }), true),
        act('terminal', 'Full omp TUI', () => quickTask(p, 'tui'), false, 'Start a task in the full omp terminal UI'),
        act('terminal-bash', 'Shell', () => projectShell(p), false, 'Open a shell in this folder'),
        act('files', 'Files', () => filesPage(p.path)),
        act('organization', 'Agents', () => { AG.cwd = p.path; agentsPage(); }, false, 'Project agents in .omp/agents'),
        act('book', 'AGENTS.md', () => openProjectFile(p, 'AGENTS.md', `# ${p.name}\n\nInstructions for omp when working in this project.\n`), false, 'Project instructions omp loads automatically')),
      h('section', {},
        h('h2', {}, `Tasks`, h('span', { class: 'muted', text: ` ${tasks.length}` })),
        tasks.length ? h('div', { class: 'pv-list' }, ...tasks.map((t) => h('div', { class: 'pv-row', onclick: () => selectTask(t.id) },
          h('span', { class: 'dot ' + t.status }), h('div', { class: 'grow' }, h('div', { class: 'pv-name', text: t.name }), h('div', { class: 'muted ell', text: t.preview || (t.cwd !== p.path ? t.cwd : t.status) })),
          t.mode === 'tui' ? h('span', { class: 'tag', text: 'TUI' }) : null, h('span', { class: 'muted', text: relTime(t.lastActivity) }))))
          : h('div', { class: 'pv-empty' }, 'No tasks yet. ', h('a', { href: '#', onclick: (e) => { e.preventDefault(); newTaskModal({ projectId: p.id }); }, text: 'Start one' }), ' — it keeps running on the server even when you close the browser.')),
      h('section', {}, h('h2', { text: 'Past omp sessions here' }), h('div', { class: 'muted hint', text: 'Sessions omp saved for this folder (including ones started in a terminal). Resume one as a persistent task.' }), sessBox)));
  // past sessions inside the project folder
  try {
    const { sessions } = await http('GET', '/api/sessions');
    if (S.curProject !== p.id) return;
    const root = p.path.replace(/[\\/]+$/, '').toLowerCase();
    const mine = sessions.filter((s) => s.cwd && (s.cwd.toLowerCase() === root || s.cwd.toLowerCase().startsWith(root + (S.config?.sep || '/'))));
    sessBox.replaceChildren(...(mine.length ? mine.slice(0, 30).map((s) => h('div', { class: 'pv-row' },
      h('i', { class: 'codicon codicon-history', style: 'color:var(--muted)' }),
      h('div', { class: 'grow' }, h('div', { class: 'pv-name ell', text: s.title || '(untitled session)' }), h('div', { class: 'muted ell mono', text: s.cwd })),
      h('span', { class: 'muted', text: relTime(s.mtime) }),
      s.adopted ? h('span', { class: 'tag', text: 'open' }) : h('button', { text: 'Resume', onclick: async () => {
        try { const { task } = await http('POST', '/api/tasks', { name: s.title || undefined, cwd: s.cwd, resume: s.file, projectId: p.id }); selectTask(task.id); } catch (e) { toast(e.message, 'error'); }
      } }))) : [h('div', { class: 'muted pad', text: 'No saved omp sessions for this folder yet.' })]));
  } catch (e) { sessBox.replaceChildren(h('div', { class: 'err pad', text: e.message })); }
}

async function quickTask(p, mode) {
  try {
    const { task } = await http('POST', '/api/tasks', { cwd: p.path, projectId: p.id, mode, name: mode === 'tui' ? `${p.name} TUI` : undefined, launch: p.defaults?.launch || {} });
    selectTask(task.id);
  } catch (e) { toast(e.message, 'error'); }
}
async function projectShell(p) {
  if (!S.config.terminals) return toast('Terminal support is not available on this server', 'error');
  try { const { term } = await http('POST', '/api/terms', { kind: 'shell', cwd: p.path, title: `${p.name} shell` }); selectTerm(term.id); } catch (e) { toast(e.message, 'error'); }
}
async function openProjectFile(p, rel, template) {
  const f = pathJoin(p.path, rel);
  try { await http('GET', '/api/file?path=' + encodeURIComponent(f)); }
  catch { try { await http('PUT', '/api/file', { path: f, content: template }); toast(`Created ${rel}`); } catch (e) { return toast(e.message, 'error'); } }
  filesPage(f);
}

// ---------------------------------------------------------------- dialogs
function colorPicker(value, onPick) {
  const wrap = h('div', { class: 'swatches' });
  const draw = (v) => wrap.replaceChildren(...PROJ_COLORS.map((c) => h('button', { class: 'swatch' + (c === v ? ' on' : ''), style: `background:${c}`, title: c, onclick: (e) => { e.preventDefault(); onPick(c); draw(c); } })));
  draw(value);
  return wrap;
}

function newProjectModal(draft = {}) {
  const d = { mode: 'existing', path: '', name: '', repoUrl: '', parent: store.get('cwd', S.config?.home || ''), color: PROJ_COLORS[(S.projects || []).length % PROJ_COLORS.length], ...draft };
  const err = h('div', { class: 'err' });
  const status = h('div', { class: 'muted' });
  const nameIn = h('input', { type: 'text', value: d.name, placeholder: 'defaults to the folder name', oninput: (e) => { d.name = e.target.value; } });
  const targetOf = () => d.mode === 'clone' ? pathJoin(d.parent || '', (d.repoUrl.split(/[\\/:]/).filter(Boolean).pop() || '').replace(/\.git$/, '') || 'repo') : d.path;
  const preview = h('div', { class: 'muted mono hint' });
  const updatePreview = () => { preview.textContent = d.mode === 'clone' ? `→ ${targetOf()}` : ''; nameIn.placeholder = baseName(targetOf()) || 'defaults to the folder name'; };
  const field = (l, el, hint) => h('div', { class: 'field' }, h('label', { text: l }), el, hint ? h('div', { class: 'muted hint', text: hint }) : null);
  const pathRow = (key, ph) => {
    const i = h('input', { type: 'text', value: d[key], placeholder: ph, oninput: (e) => { d[key] = e.target.value; updatePreview(); } });
    i.style.flex = '1';
    return h('div', { class: 'row', style: 'display:flex;gap:6px' }, i, h('button', { text: 'Browse…', onclick: () => browseDir(d[key] || S.config?.home, (picked) => newProjectModal({ ...d, [key]: picked, name: nameIn.value }), () => newProjectModal({ ...d, name: nameIn.value })) }));
  };
  const seg = h('div', { class: 'seg' }, ...[['existing', 'Existing folder'], ['create', 'New folder'], ['clone', 'Clone git repo']].map(([v, l]) =>
    h('button', { class: d.mode === v ? 'on' : '', onclick: () => newProjectModal({ ...d, mode: v, name: nameIn.value }), text: l })));
  const body = d.mode === 'clone'
    ? [field('Repository URL', h('input', { type: 'text', value: d.repoUrl, placeholder: 'https://github.com/owner/repo.git or git@host:owner/repo.git', oninput: (e) => { d.repoUrl = e.target.value.trim(); updatePreview(); } }), 'Cloned on the server with its git credentials.'),
       field('Clone into folder', pathRow('parent', 'parent folder on the server')), preview]
    : [field(d.mode === 'create' ? 'New folder path' : 'Folder', pathRow('path', d.mode === 'create' ? 'e.g. /home/me/code/new-app' : 'absolute path on the server'), d.mode === 'create' ? 'Created (with parents) if it does not exist.' : null)];
  const create = h('button', { class: 'primary' }, h('i', { class: 'codicon codicon-add' }), h('span', { text: d.mode === 'clone' ? 'Clone & create' : 'Create project' }));
  create.onclick = async () => {
    err.textContent = ''; create.disabled = true;
    if (d.mode === 'clone') status.replaceChildren(h('i', { class: 'codicon codicon-loading codicon-modifier-spin' }), ' Cloning… large repositories can take a while.');
    try {
      const { project } = await http('POST', '/api/projects', { mode: d.mode, path: targetOf(), repoUrl: d.repoUrl, name: nameIn.value.trim() || undefined, color: d.color });
      if (d.mode !== 'clone') store.set('cwd', project.path);
      closeModal();
      toast(`Project ${project.name} created`);
      if (projById(project.id)) selectProject(project.id); else S.pendingProject = project.id;
    } catch (e) { err.textContent = e.message; status.textContent = ''; create.disabled = false; }
  };
  modal([h('h3', { text: 'New project' }),
    h('div', { class: 'muted', text: 'A project maps a folder on the server. Tasks started in it (or anywhere inside it) are grouped under it in the sidebar.' }),
    h('div', { class: 'formgrid' }, seg, ...body, h('div', { class: 'row2' }, field('Name', nameIn), field('Colour', colorPicker(d.color, (c) => { d.color = c; })))), status, err,
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }), create)]);
  updatePreview();
}

function projectSettingsModal(p, draft) {
  const d = { name: p.name, path: p.path, color: p.color, ...draft };
  const err = h('div', { class: 'err' });
  const nameIn = h('input', { type: 'text', value: d.name, oninput: (e) => { d.name = e.target.value; } });
  const pathIn = h('input', { type: 'text', value: d.path, oninput: (e) => { d.path = e.target.value; } });
  pathIn.style.flex = '1';
  const lf = launchForm(p.defaults?.launch || {}, {});
  modal([h('h3', { text: `Project settings — ${p.name}` }),
    h('div', { class: 'formgrid' },
      h('div', { class: 'row2' }, h('div', { class: 'field' }, h('label', { text: 'Name' }), nameIn), h('div', { class: 'field' }, h('label', { text: 'Colour' }), colorPicker(d.color, (c) => { d.color = c; }))),
      h('div', { class: 'field' }, h('label', { text: 'Folder' }), h('div', { class: 'row', style: 'display:flex;gap:6px' }, pathIn,
        h('button', { text: 'Browse…', onclick: () => browseDir(pathIn.value, (picked) => projectSettingsModal(p, { ...d, name: nameIn.value, path: picked }), () => projectSettingsModal(p, { ...d, name: nameIn.value })) }))),
      h('div', { class: 'field' }, h('label', { text: 'Default launch options for new tasks in this project' }), lf.el), err),
    h('div', { class: 'actions' },
      h('button', { class: 'danger', text: 'Remove project', title: 'Removes the grouping only: tasks, files and sessions are untouched', onclick: async () => {
        if (!confirm(`Remove project "${p.name}"?\n\nOnly the grouping is removed. Tasks keep running and no files are deleted.`)) return;
        await http('DELETE', `/api/projects/${p.id}`).catch((e) => toast(e.message, 'error'));
        closeModal(); S.curProject = null; renderAll();
      } }),
      h('span', { class: 'grow' }),
      h('button', { text: 'Cancel', onclick: closeModal }),
      h('button', { class: 'primary', text: 'Save', onclick: async () => {
        try { await http('PATCH', `/api/projects/${p.id}`, { name: nameIn.value, path: pathIn.value, color: d.color, defaults: { ...(p.defaults || {}), launch: lf.get() } }); closeModal(); toast('Project saved'); }
        catch (e) { err.textContent = e.message; }
      } }))]);
}

function moveToProjectModal(t) {
  const cur = t.projectId;
  const pick = async (projectId) => { try { await http('PATCH', `/api/tasks/${t.id}`, { projectId }); closeModal(); toast('Task moved'); } catch (e) { toast(e.message, 'error'); } };
  modal([h('h3', { text: `Move "${t.name}" to…` }),
    h('div', { class: 'list' },
      ...(S.projects || []).map((p) => h('div', { class: 'item' + (p.id === cur ? ' sel' : ''), onclick: () => pick(p.id) },
        h('i', { class: 'codicon codicon-folder', style: `color:${p.color}` }), h('div', { class: 'grow' }, h('div', { text: p.name }), h('div', { class: 'muted mono ell', text: p.path })))),
      h('div', { class: 'item', onclick: () => pick(null) }, h('i', { class: 'codicon codicon-wand' }), h('div', { class: 'grow' }, h('div', { text: 'Automatic' }), h('div', { class: 'muted', text: 'Group by the project whose folder contains the task' })))),
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }))]);
}
