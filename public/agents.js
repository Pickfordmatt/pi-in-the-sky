'use strict';
// Agent builder & manager for omp task agents (bundled, user ~/.omp/agent/agents, project .omp/agents).
// Uses helpers from app.js / pages.js at call time: h, $, http, toast, modal, closeModal, page, closePage, md, store, S, call, selectTask, wsSend.

const AG = {
  data: null,        // response of GET /api/agents
  cwd: '',
  filter: 'all',
  q: '',
  sel: null,         // selected file path (or 'draft')
  draft: null,       // working copy being edited
  draftMeta: null,   // { source, file, readOnly }
  dirty: false,
  rawEdit: null,     // pending edits typed in the Source tab
  tab: 'definition',
  models: null,
};

const ROLE_ALIASES = ['@default', '@smol', '@slow', '@plan', '@advisor', '@commit', '@vision'];
const THINKING = ['', 'off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'auto'];
const SRC_LABEL = { project: 'Project', user: 'User', bundled: 'Bundled' };

const AGENT_TEMPLATES = [
  { id: 'blank', title: 'Blank agent', desc: 'Start from nothing.', a: { name: 'my-agent', description: '', toolsMode: 'default', model: '', systemPrompt: '' } },
  { id: 'researcher', title: 'Read-only researcher', desc: 'Explores the codebase and the web, never edits.', a: {
    name: 'researcher', description: 'Read-only researcher: maps code, traces behaviour and gathers references, then returns a compressed briefing.',
    toolsMode: 'custom', tools: ['read', 'find', 'grep', 'glob', 'ast_grep', 'lsp', 'web_search'], model: '@smol', thinkingLevel: 'medium',
    systemPrompt: '# Role\nYou are a read-only research agent. You never modify files.\n\n# How to work\n- Start broad (find/glob), then narrow (grep, ast_grep, lsp).\n- Read only what you need; cite file:line for every claim.\n- Use web_search only for external APIs or libraries.\n\n# Return\nA concise briefing: key findings, relevant files with line ranges, open questions.\n' } },
  { id: 'reviewer', title: 'Code reviewer', desc: 'Reviews a change and returns prioritised findings.', a: {
    name: 'code-reviewer', description: 'Reviews a diff or set of files for correctness, security and maintainability; returns prioritised findings.',
    toolsMode: 'custom', tools: ['read', 'find', 'grep', 'glob', 'bash', 'lsp', 'ast_grep'], model: '@slow', thinkingLevel: 'high', spawnsMode: 'custom', spawns: ['scout'],
    systemPrompt: '# Role\nYou review code changes like a senior engineer.\n\n# How to work\n- Establish what changed (git diff via bash) and why.\n- Check correctness first, then security, then maintainability.\n- Verify suspicions by reading the surrounding code; do not guess.\n\n# Constraints\n- Do not edit files.\n- Only report issues you can point to with file:line evidence.\n\n# Return\nFindings ordered P0 (blocker) to P3 (nit), each with file:line, the problem, and a concrete fix. End with a one-line verdict.\n' } },
  { id: 'implementer', title: 'Implementer', desc: 'Makes focused code changes and verifies them.', a: {
    name: 'implementer', description: 'Implements a well-scoped code change end to end, runs the relevant checks, and reports what changed.',
    toolsMode: 'default', model: '@default', thinkingLevel: 'medium',
    systemPrompt: '# Role\nYou implement one well-scoped change.\n\n# How to work\n1. Read the code you will touch and its callers.\n2. Make the smallest correct change that matches local conventions.\n3. Run the project\'s type-check/tests for the touched area and fix failures you caused.\n\n# Constraints\n- Stay inside the assignment; note unrelated problems instead of fixing them.\n\n# Return\nFiles changed, what and why, and the exact checks you ran with their results.\n' } },
  { id: 'tester', title: 'Test writer', desc: 'Adds or repairs tests for a given area.', a: {
    name: 'test-writer', description: 'Writes or repairs automated tests for a specified module, matching the project\'s existing test style.',
    toolsMode: 'custom', tools: ['read', 'write', 'edit', 'find', 'grep', 'glob', 'bash', 'lsp'], model: '@default', thinkingLevel: 'medium',
    systemPrompt: '# Role\nYou write high-value automated tests.\n\n# How to work\n- Find the existing test framework, helpers and naming conventions first.\n- Cover behaviour and edge cases, not implementation details.\n- Run the new tests and make them pass without weakening assertions.\n\n# Return\nTests added (file and names), what each verifies, and the test command output.\n' } },
  { id: 'docs', title: 'Docs writer', desc: 'Writes clear developer documentation.', a: {
    name: 'docs-writer', description: 'Writes or updates developer documentation (README, guides, API docs) based on the actual code.',
    toolsMode: 'custom', tools: ['read', 'write', 'edit', 'find', 'grep', 'glob'], model: '@smol', thinkingLevel: 'low',
    systemPrompt: '# Role\nYou write accurate, concise developer documentation.\n\n# How to work\n- Derive every statement from the code; read before you write.\n- Prefer short sections, runnable examples and tables over prose.\n\n# Return\nThe files you changed and a summary of what readers can now find.\n' } },
];

const blankAgent = () => ({ name: '', description: '', toolsMode: 'default', tools: [], spawnsMode: 'none', spawns: [], model: '', thinkingLevel: '', blocking: false, structured: false, autoloadSkills: [], readSummarize: true, prewalk: '', advisor: '', output: '', systemPrompt: '' });

// ---------------------------------------------------------------- data
async function agLoad(selectFile) {
  try {
    AG.data = await http('GET', '/api/agents?cwd=' + encodeURIComponent(AG.cwd || ''));
  } catch (e) { toast(e.message, 'error'); return; }
  if (selectFile) {
    const a = AG.data.agents.find((x) => x.file === selectFile);
    if (a) agOpen(a, true);
  } else if (AG.sel && AG.sel !== 'draft') {
    const a = AG.data.agents.find((x) => x.file === AG.sel);
    if (a && !AG.dirty) agOpen(a, true);
  }
  agRenderList();
  if (!AG.sel) agRenderEmpty();
}

function agConfirmLeave() { return !AG.dirty || confirm('Discard unsaved changes to this agent?'); }

function agOpen(a, force) {
  if (!force && !agConfirmLeave()) return;
  AG.sel = a.file;
  AG.draft = { ...blankAgent(), ...JSON.parse(JSON.stringify(a)) };
  AG.draftMeta = { source: a.source, file: a.file, readOnly: a.source === 'bundled', shadowedBy: a.shadowedBy, error: a.error };
  AG.dirty = false;
  AG.rawEdit = null;
  agRenderList();
  agRenderEditor();
}

function agNewDraft(fields, scope = 'user', note) {
  if (!agConfirmLeave()) return;
  AG.sel = 'draft';
  AG.draft = { ...blankAgent(), ...JSON.parse(JSON.stringify(fields)) };
  AG.draftMeta = { source: scope, file: null, readOnly: false, isNew: true, note };
  AG.dirty = true;
  AG.rawEdit = null;
  AG.tab = 'definition';
  agRenderList();
  agRenderEditor();
}

// ---------------------------------------------------------------- page
async function agentsPage() {
  AG.cwd = AG.cwd || S.snap?.task?.cwd || store.get('cwd', S.config?.home || '');
  const cwdIn = h('input', { type: 'text', value: AG.cwd, placeholder: 'project folder (for .omp/agents)', title: 'Project folder whose .omp/agents are shown', onchange: (e) => { AG.cwd = e.target.value.trim(); agLoad(); } });
  page('Agents', h('div', { class: 'agents' },
    h('div', { class: 'ag-left' },
      h('div', { class: 'row' }, h('i', { class: 'codicon codicon-folder', style: 'color:var(--muted)' }), cwdIn),
      h('input', { type: 'search', placeholder: 'Search agents…', value: AG.q, oninput: (e) => { AG.q = e.target.value; agRenderList(); } }),
      h('div', { class: 'chips', id: 'agFilters' }),
      h('div', { id: 'agList', class: 'ag-list' })),
    h('div', { class: 'ag-right', id: 'agEditor' })), {
    actions: [
      h('button', { onclick: agBuilderModal }, h('i', { class: 'codicon codicon-sparkle' }), h('span', { text: 'Build with AI' })),
      h('button', { class: 'primary', onclick: agNewModal }, h('i', { class: 'codicon codicon-add' }), h('span', { text: 'New agent' })),
    ],
  });
  $('#agEditor').replaceChildren(h('div', { class: 'muted pad', text: 'Loading agents from omp…' }));
  await agLoad();
}

function agVisible() {
  const q = AG.q.trim().toLowerCase();
  return (AG.data?.agents || []).filter((a) => (AG.filter === 'all' || a.source === AG.filter) &&
    (!q || `${a.name} ${a.description} ${a.model}`.toLowerCase().includes(q)));
}

function agRenderList() {
  const box = $('#agList'); if (!box || !AG.data) return;
  const counts = { all: AG.data.agents.length };
  for (const a of AG.data.agents) counts[a.source] = (counts[a.source] || 0) + 1;
  $('#agFilters').replaceChildren(...['all', 'project', 'user', 'bundled'].map((f) => h('button', { class: 'chip' + (AG.filter === f ? ' on' : ''), onclick: () => { AG.filter = f; agRenderList(); } },
    `${f === 'all' ? 'All' : SRC_LABEL[f]} ${counts[f] || 0}`)));
  const groups = ['project', 'user', 'bundled'];
  const vis = agVisible();
  const kids = [];
  if (AG.sel === 'draft' && AG.draft) {
    kids.push(h('div', { class: 'ag-item sel' }, h('i', { class: 'codicon codicon-edit' }), h('div', { class: 'grow' },
      h('div', { class: 'ag-name', text: AG.draft.name || '(new agent)' }), h('div', { class: 'ag-desc ell', text: 'Unsaved draft' }))));
  }
  for (const g of groups) {
    const items = vis.filter((a) => a.source === g);
    if (!items.length) continue;
    const dir = g === 'bundled' ? 'built into omp' : AG.data.dirs[g] || '';
    kids.push(h('div', { class: 'ag-group' }, h('span', { text: SRC_LABEL[g] }), h('span', { class: 'muted ell', title: dir, text: dir })));
    for (const a of items) {
      const disabled = AG.data.disabled.includes(a.name);
      const ov = AG.data.overrides.model?.[a.name];
      kids.push(h('div', { class: 'ag-item' + (a.file === AG.sel ? ' sel' : '') + (a.effective ? '' : ' shadow'), onclick: () => agOpen(a) },
        h('i', { class: 'codicon ' + (a.error ? 'codicon-warning' : g === 'bundled' ? 'codicon-package' : 'codicon-hubot'), style: a.error ? 'color:var(--warn)' : '' }),
        h('div', { class: 'grow' },
          h('div', { class: 'ag-name' }, a.name || '(invalid)',
            disabled ? h('span', { class: 'tag off', text: 'disabled' }) : null,
            a.shadowedBy ? h('span', { class: 'tag', text: 'overridden by ' + a.shadowedBy }) : null),
          h('div', { class: 'ag-desc ell', text: a.error || a.description }),
          h('div', { class: 'ag-meta' }, ov ? h('span', { class: 'mono', title: 'model override', text: '⟶ ' + ov }) : a.model ? h('span', { class: 'mono', text: a.model }) : null,
            a.toolsMode === 'custom' ? h('span', { text: `${a.tools.length} tools` }) : a.toolsMode === 'none' ? h('span', { text: 'no tools' }) : null,
            a.spawnsMode !== 'none' ? h('span', { text: a.spawnsMode === 'all' ? 'spawns *' : 'spawns ' + a.spawns.join(',') }) : null))));
    }
  }
  if (!kids.length) kids.push(h('div', { class: 'muted pad', text: 'No agents match.' }));
  box.replaceChildren(...kids);
}

function agRenderEmpty() {
  const ed = $('#agEditor'); if (!ed) return;
  ed.replaceChildren(h('div', { class: 'ag-empty' },
    h('i', { class: 'codicon codicon-organization' }),
    h('h2', { text: 'omp task agents' }),
    h('p', { text: 'Agents are specialists omp\'s orchestrator delegates to with its task tool. Each is a markdown file with YAML frontmatter: a name, a description the orchestrator reads to decide when to delegate, the tools and model it gets, and a system prompt.' }),
    h('ul', {},
      h('li', {}, h('strong', { text: 'Project' }), ' agents (.omp/agents) override ', h('strong', { text: 'user' }), ' agents (~/.omp/agent/agents), which override the ', h('strong', { text: 'bundled' }), ' ones.'),
      h('li', { text: 'Runtime controls (enable/disable, model override, advisor, prewalk, budgets) apply to any agent, bundled ones included, and live in config.yml.' }),
      h('li', { text: 'omp rediscovers agents before every spawn, so changes apply to running tasks immediately.' })),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: agNewModal, text: 'New agent' }), h('button', { onclick: agBuilderModal, text: 'Build with AI' }))));
}

// ---------------------------------------------------------------- editor
function agField(label, ctl, help, span) {
  return h('div', { class: 'field' + (span ? ' span2' : '') }, h('label', { text: label }), ctl, help ? h('div', { class: 'muted hint', text: help }) : null);
}
function agMark() { if (!AG.dirty) { AG.dirty = true; const b = $('#agSaveBtn'); if (b) b.disabled = false; const d = $('#agDirty'); if (d) d.hidden = false; } }

function agRenderEditor() {
  const ed = $('#agEditor'); if (!ed) return;
  const A = AG.draft, M = AG.draftMeta;
  const ro = M.readOnly;
  const tabs = [['definition', 'Definition'], ['prompt', 'System prompt'], ['runtime', 'Runtime'], ['source', 'Source']];
  const banner = [];
  if (ro) banner.push(h('div', { class: 'ag-banner' }, h('i', { class: 'codicon codicon-lock' }), h('span', { class: 'grow', text: 'Bundled agent: read-only. Customize makes an editable copy in your user agents, which then takes precedence. Runtime controls work on bundled agents directly.' }),
    h('button', { class: 'primary', text: 'Customize', onclick: () => agNewDraft({ ...A }, 'user', `Customized copy of bundled "${A.name}"`) })));
  if (M.shadowedBy) banner.push(h('div', { class: 'ag-banner warn' }, h('i', { class: 'codicon codicon-info' }), h('span', { text: `Not in effect: a ${M.shadowedBy} agent with the same name takes precedence.` })));
  if (M.error) banner.push(h('div', { class: 'ag-banner err' }, h('i', { class: 'codicon codicon-error' }), h('span', { text: M.error + ' — omp will skip this file until fixed (see Source).' })));
  if (M.note) banner.push(h('div', { class: 'ag-banner' }, h('i', { class: 'codicon codicon-sparkle' }), h('span', { text: M.note })));

  ed.replaceChildren(
    h('div', { class: 'ag-head' },
      h('i', { class: 'codicon ' + (M.source === 'bundled' ? 'codicon-package' : 'codicon-hubot'), style: 'font-size:22px;color:var(--accent2)' }),
      h('div', { class: 'grow' }, h('div', { class: 'ag-title' }, A.name || 'New agent', h('span', { class: 'tag src', text: SRC_LABEL[M.source] || M.source }), h('span', { id: 'agDirty', class: 'tag warn', text: 'unsaved', hidden: !AG.dirty })),
        h('div', { class: 'muted mono ell', title: M.file || '', text: M.file || 'not saved yet' })),
      !ro ? h('button', { id: 'agSaveBtn', class: 'primary', disabled: !AG.dirty, onclick: agSave }, h('i', { class: 'codicon codicon-save' }), h('span', { text: 'Save' })) : null,
      A.name ? h('button', { title: 'Delegate a job to this agent in a task', onclick: agTryModal }, h('i', { class: 'codicon codicon-play' }), h('span', { text: 'Try it' })) : null,
      h('button', { class: 'icon', title: 'More', onclick: (e) => menu([
        ['Duplicate as new agent', () => agNewDraft({ ...A, name: (A.name || 'agent') + '-copy' }, M.source === 'project' ? 'project' : 'user')],
        ...(M.file ? [['Open file in editor', () => filesPage(M.file)]] : []),
        ...(!ro && M.file ? ['-', ['Delete agent…', agDelete]] : []),
      ], e.currentTarget) }, h('i', { class: 'codicon codicon-ellipsis' }))),
    ...banner,
    h('nav', { class: 'ag-tabs' }, ...tabs.map(([k, l]) => h('button', { class: AG.tab === k ? 'active' : '', onclick: () => { if (AG.tab === 'source' && k !== 'source' && AG.rawEdit != null) { if (!confirm('You have unsaved edits in Source. Discard them?')) return; AG.rawEdit = null; } AG.tab = k; agRenderEditor(); }, text: l }))),
    h('div', { class: 'ag-body', id: 'agBody' }));
  const body = $('#agBody');
  if (AG.tab === 'definition') agDefinitionTab(body, A, ro);
  else if (AG.tab === 'prompt') agPromptTab(body, A, ro);
  else if (AG.tab === 'runtime') agRuntimeTab(body, A);
  else agSourceTab(body, A, M);
}

function agDefinitionTab(body, A, ro) {
  const M = AG.draftMeta;
  const inp = (key, ph) => h('input', { type: 'text', value: A[key] || '', placeholder: ph || '', disabled: ro, oninput: (e) => { A[key] = e.target.value; agMark(); if (key === 'name') { const t = $('.ag-title'); if (t?.firstChild) t.firstChild.textContent = e.target.value || 'New agent'; } } });
  const modelIn = inp('model', '@default, @smol, @slow or provider/model (comma list = fallbacks)');
  modelIn.setAttribute('list', 'agModels');
  const dl = h('datalist', { id: 'agModels' }, ...ROLE_ALIASES.map((r) => h('option', { value: r })), ...(AG.models || []).map((m) => h('option', { value: m })));
  if (!AG.models) agLoadModels();
  const scopeSel = h('select', { disabled: ro, onchange: (e) => { M.source = e.target.value; agMark(); agRenderEditor(); } },
    h('option', { value: 'user', text: 'User (~/.omp/agent/agents)', selected: M.source === 'user' }),
    h('option', { value: 'project', text: `Project (${AG.cwd || 'no folder'}/.omp/agents)`, selected: M.source === 'project' }));

  // tools
  const toolGrid = h('div', { class: 'toolgrid' });
  const drawTools = () => {
    const known = [...new Set([...(AG.data?.tools || []), ...A.tools])];
    toolGrid.replaceChildren(...known.map((t) => h('button', { class: 'chip' + (A.tools.includes(t) ? ' on' : ''), disabled: ro || A.toolsMode !== 'custom',
      onclick: () => { A.tools = A.tools.includes(t) ? A.tools.filter((x) => x !== t) : [...A.tools, t]; agMark(); drawTools(); } }, t)));
  };
  drawTools();
  const toolsMode = h('div', { class: 'seg' }, ...[['default', 'Default toolset'], ['custom', 'Only these'], ['none', 'No tools']].map(([v, l]) =>
    h('button', { class: A.toolsMode === v ? 'on' : '', disabled: ro, onclick: () => { A.toolsMode = v; if (v === 'custom' && !A.tools.length) A.tools = ['read', 'find', 'grep', 'glob']; agMark(); agRenderEditor(); }, text: l })));
  const extraTool = h('input', { type: 'text', placeholder: 'other tool name (extension/MCP) + Enter', disabled: ro || A.toolsMode !== 'custom', onkeydown: (e) => { if (e.key === 'Enter' && e.target.value.trim()) { A.tools = [...new Set([...A.tools, e.target.value.trim()])]; e.target.value = ''; agMark(); drawTools(); } } });

  // spawns
  const others = [...new Set((AG.data?.agents || []).filter((x) => x.name && x.name !== A.name && x.effective).map((x) => x.name))];
  const spawnGrid = h('div', { class: 'toolgrid' }, ...others.map((n) => h('button', { class: 'chip' + (A.spawns.includes(n) ? ' on' : ''), disabled: ro || A.spawnsMode !== 'custom',
    onclick: (e) => { A.spawns = A.spawns.includes(n) ? A.spawns.filter((x) => x !== n) : [...A.spawns, n]; e.currentTarget.classList.toggle('on'); agMark(); } }, n)));
  const spawnsMode = h('div', { class: 'seg' }, ...[['none', 'Cannot delegate'], ['all', 'Any agent (*)'], ['custom', 'Only these']].map(([v, l]) =>
    h('button', { class: A.spawnsMode === v ? 'on' : '', disabled: ro, onclick: () => { A.spawnsMode = v; agMark(); agRenderEditor(); }, text: l })));

  const tri = (key, label, help) => {
    const v = A[key] || '';
    const mode = v === '' ? 'off' : v === 'on' ? 'on' : 'custom';
    const custom = h('input', { type: 'text', value: mode === 'custom' ? v : '', placeholder: key === 'prewalk' ? 'target, e.g. @smol' : 'advisor model, e.g. @slow:high', disabled: ro || mode !== 'custom', oninput: (e) => { A[key] = e.target.value; agMark(); } });
    return agField(label, h('div', { class: 'row' },
      h('select', { disabled: ro, onchange: (e) => { A[key] = e.target.value === 'off' ? '' : e.target.value === 'on' ? 'on' : (custom.value || '@smol'); agMark(); agRenderEditor(); } },
        ...[['off', 'Off'], ['on', 'On (default target)'], ['custom', 'Custom…']].map(([o, l]) => h('option', { value: o, text: l, selected: o === mode }))), custom), help);
  };
  const check = (key, label, help) => h('label', { class: 'toggle' }, h('span', {}, label, help ? h('div', { class: 'muted hint', text: help }) : null),
    h('input', { type: 'checkbox', checked: !!A[key], disabled: ro, onchange: (e) => { A[key] = e.target.checked; agMark(); } }));

  body.replaceChildren(dl, h('div', { class: 'formgrid' },
    h('div', { class: 'row2' }, agField('Name', inp('name', 'kebab-case, e.g. api-reviewer'), 'Used to dispatch the agent; also the file name.'), agField('Scope', scopeSel, 'Project agents override user agents.')),
    agField('Description', h('textarea', { rows: 2, disabled: ro, placeholder: 'When should the orchestrator delegate to this agent? One clear sentence.', oninput: (e) => { A.description = e.target.value; agMark(); } }, A.description || ''), 'The orchestrator reads this to choose agents, so make it specific.', true),
    h('div', { class: 'row2' },
      agField('Model', modelIn, 'Role aliases resolve through Models & roles.'),
      agField('Thinking level', h('select', { disabled: ro, onchange: (e) => { A.thinkingLevel = e.target.value; agMark(); } }, ...THINKING.map((t) => h('option', { value: t, text: t || 'inherit / default', selected: t === (A.thinkingLevel || '') }))))),
    h('div', { class: 'field span2' }, h('label', { text: 'Tools' }), toolsMode, toolGrid, extraTool),
    h('div', { class: 'field span2' }, h('label', { text: 'Delegation (spawns)' }), spawnsMode, A.spawnsMode === 'custom' ? spawnGrid : null),
    h('div', { class: 'row2' }, tri('prewalk', 'Prewalk', 'Switch to a cheaper model at the first edit.'), tri('advisor', 'Advisor', 'A second model reviews every turn of this agent.')),
    h('div', { class: 'ag-checks' },
      check('blocking', 'Blocking', 'Parent always waits for this agent, even with async tasks.'),
      check('structured', 'Structured result', 'Return the output schema via the yield tool.'),
      check('readSummarize', 'Summarize file reads', 'Turn off to give this agent raw file contents.')),
    agField('Autoload skills', h('input', { type: 'text', value: (A.autoloadSkills || []).join(', '), disabled: ro, placeholder: 'comma-separated skill names', oninput: (e) => { A.autoloadSkills = e.target.value.split(',').map((s) => s.trim()).filter(Boolean); agMark(); } }), null, true),
    agField('Output schema (YAML or JSON, optional)', h('textarea', { rows: 6, class: 'mono', disabled: ro, spellcheck: 'false', placeholder: 'properties:\n  summary:\n    type: string\n    metadata:\n      description: What you found', oninput: (e) => { A.output = e.target.value; agMark(); } }, A.output || ''), 'Shape of the result the agent hands back.', true)));
}

function agPromptTab(body, A, ro) {
  const ta = h('textarea', { class: 'ag-prompt mono', spellcheck: 'false', disabled: ro, placeholder: '# Role\nYou are …\n\n# How to work\n- …\n\n# Return\n…', oninput: (e) => { A.systemPrompt = e.target.value; agMark(); } }, A.systemPrompt || '');
  const prev = h('div', { class: 'ag-preview md' });
  let showing = false;
  const toggle = h('button', { onclick: () => { showing = !showing; prev.hidden = !showing; ta.hidden = showing; toggle.textContent = showing ? 'Edit' : 'Preview'; if (showing) prev.replaceChildren(md(A.systemPrompt || '*empty*')); } }, 'Preview');
  prev.hidden = true;
  body.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'muted grow', text: `${(A.systemPrompt || '').length} characters · the agent's system prompt (markdown body of the file)` }), toggle), ta, prev);
  if (!ro) ta.focus();
}

function agRuntimeTab(body, A) {
  if (!A.name) { body.replaceChildren(h('div', { class: 'muted pad', text: 'Name and save the agent first.' })); return; }
  const ov = AG.data.overrides || {};
  const disabled = AG.data.disabled.includes(A.name);
  const set = async (kind, value) => {
    try { await http('POST', '/api/agents/override', { name: A.name, kind, value }); toast(`Saved ${kind} for ${A.name}`); await agLoad(); }
    catch (e) { toast(e.message, 'error'); }
  };
  const row = (kind, label, help, ph) => {
    const cur = ov[kind]?.[A.name];
    const i = h('input', { type: kind === 'budget' ? 'number' : 'text', value: cur ?? '', placeholder: ph || 'not set' });
    return h('div', { class: 'ag-rt' },
      h('div', {}, h('div', { class: 'ag-rt-l', text: label }), h('div', { class: 'muted hint', text: help })),
      h('div', { class: 'row' }, i, h('button', { text: 'Set', onclick: () => set(kind, i.value.trim() === '' ? null : i.value.trim()) }),
        cur != null ? h('button', { class: 'icon', title: 'Clear', onclick: () => set(kind, null) }, h('i', { class: 'codicon codicon-close' })) : null));
  };
  body.replaceChildren(
    h('div', { class: 'muted', text: `Stored in config.yml under task.* for "${A.name}". Applies to whichever definition of this name is in effect, including bundled agents, and takes precedence over the file.` }),
    h('div', { class: 'ag-rt' }, h('div', {}, h('div', { class: 'ag-rt-l', text: 'Enabled' }), h('div', { class: 'muted hint', text: 'Disabled agents cannot be spawned (task.disabledAgents).' })),
      h('input', { type: 'checkbox', 'aria-label': 'Enabled', checked: !disabled, onchange: (e) => set('disabled', !e.target.checked) })),
    row('model', 'Model override', 'task.agentModelOverrides: replaces the frontmatter model.', 'e.g. @slow or openai/gpt-5.4:high'),
    row('prewalk', 'Prewalk override', 'task.agentPrewalk: "on", "off" or a target model.', 'on | off | @smol'),
    row('advisor', 'Advisor override', 'task.agentAdvisor: "on", "off" or an advisor model.', 'on | off | @slow:high'),
    row('serviceTier', 'Service tier', 'task.agentServiceTierOverrides: e.g. inherit, priority, flex.', 'inherit'),
    row('compaction', 'Compaction threshold', 'task.agentCompactionThresholdOverrides: tokens (90000) or percent (80%).', '80%'),
    row('budget', 'Soft request budget', 'task.agentSoftRequestBudget: max requests before the agent is nudged to finish; 0 disables.', '0'));
}

async function agSourceTab(body, A, M) {
  const ta = h('textarea', { class: 'ag-prompt mono', spellcheck: 'false', disabled: M.readOnly, oninput: (e) => { AG.rawEdit = e.target.value; agMark(); } });
  body.replaceChildren(h('div', { class: 'row' }, h('span', { class: 'muted grow', text: M.readOnly ? 'Bundled definition (read-only).' : 'Edit the raw file. Saving here replaces the whole file.' }),
    !M.readOnly ? h('button', { class: 'primary', text: 'Save source', onclick: () => agSave(ta.value) }) : null), ta);
  if (AG.rawEdit != null) ta.value = AG.rawEdit;
  else if (M.file && !AG.dirty) {
    try { ta.value = (await http('GET', '/api/file?path=' + encodeURIComponent(M.file))).content; } catch (e) { ta.value = e.message; }
  } else ta.value = A.__raw || '(unsaved: save first, or the file will be generated from the Definition and System prompt tabs)';
}

async function agSave(raw) {
  const A = AG.draft, M = AG.draftMeta;
  if (M.readOnly) return;
  if (typeof raw !== 'string' && AG.rawEdit != null) raw = AG.rawEdit;
  const body = { scope: M.source === 'project' ? 'project' : 'user', cwd: AG.cwd, originalFile: M.file || undefined };
  if (typeof raw === 'string') body.raw = raw; else body.agent = A;
  try {
    const r = await http('PUT', '/api/agents', body);
    AG.dirty = false;
    AG.rawEdit = null;
    toast(`Saved ${r.agent.name}`);
    await agLoad(r.file);
  } catch (e) { toast(e.message, 'error', 9000); }
}

async function agDelete() {
  const M = AG.draftMeta;
  if (!M.file || !confirm(`Delete agent "${AG.draft.name}"?\n\n${M.file}\n\nA backup copy is kept in ~/.ohmypi-web/agent-trash.`)) return;
  try { await http('DELETE', '/api/agents?file=' + encodeURIComponent(M.file) + '&cwd=' + encodeURIComponent(AG.cwd)); toast('Agent deleted (backup kept)'); AG.sel = null; AG.dirty = false; await agLoad(); agRenderEmpty(); }
  catch (e) { toast(e.message, 'error'); }
}

async function agLoadModels() {
  AG.models = [];
  try { const d = await http('GET', '/api/omp/models'); AG.models = (d.models || []).map((m) => m.selector || `${m.provider}/${m.id}`); } catch {}
  const dl = $('#agModels');
  if (dl) for (const m of AG.models) dl.append(h('option', { value: m }));
}

// ---------------------------------------------------------------- modals
function agNewModal() {
  modal([h('h3', { text: 'New agent' }), h('div', { class: 'muted', text: 'Pick a starting point. You can change everything before saving.' }),
    h('div', { class: 'ag-templates' }, ...AGENT_TEMPLATES.map((t) => h('button', { class: 'ag-tpl', onclick: () => { closeModal(); agNewDraft(t.a, 'user'); } },
      h('strong', { text: t.title }), h('span', { class: 'muted', text: t.desc })))),
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }), h('button', { onclick: () => { closeModal(); agBuilderModal(); } }, h('i', { class: 'codicon codicon-sparkle' }), h('span', { text: 'Build with AI instead' })))]);
}

function agBuilderModal() {
  const desc = h('textarea', { rows: 6, placeholder: 'e.g. "An agent that audits our REST endpoints for missing auth checks and input validation, read-only, returns a table of findings with file:line."' });
  const name = h('input', { type: 'text', placeholder: 'optional, e.g. api-auditor' });
  const scope = h('select', {}, h('option', { value: 'user', text: 'User agents' }), h('option', { value: 'project', text: 'Project agents' }));
  const status = h('div', { class: 'muted' });
  const go = h('button', { class: 'primary' }, h('i', { class: 'codicon codicon-sparkle' }), h('span', { text: 'Draft agent' }));
  go.onclick = async () => {
    if (!desc.value.trim()) return desc.focus();
    go.disabled = true; status.replaceChildren(h('i', { class: 'codicon codicon-loading codicon-modifier-spin' }), ' omp is drafting the agent with your default model… this can take a minute.');
    try {
      const r = await http('POST', '/api/agents/generate', { description: desc.value.trim(), name: name.value.trim() || undefined, tools: AG.data?.tools, models: AG.models || [] });
      closeModal();
      const a = r.agent;
      if (a.error) toast('The draft needs fixing: ' + a.error, 'warning', 9000);
      agNewDraft({ ...a, __raw: r.raw }, scope.value, 'Drafted by omp from your description. Review every field, then Save.');
    } catch (e) { status.textContent = e.message; status.className = 'err'; go.disabled = false; }
  };
  modal([h('h3', {}, h('i', { class: 'codicon codicon-sparkle', style: 'color:var(--accent2);margin-right:8px' }), 'Build an agent with AI'),
    h('div', { class: 'muted', text: 'Describe the specialist you want. omp writes the frontmatter (tools, model, delegation, output) and the system prompt; you review it before anything is saved.' }),
    h('div', { class: 'formgrid' }, agField('What should the agent do?', desc), h('div', { class: 'row2' }, agField('Name', name), agField('Save to', scope)), status),
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }), go)]);
  desc.focus();
}

function agTryModal() {
  const A = AG.draft;
  if (AG.dirty) return toast('Save the agent first', 'warning');
  const running = S.tasks.filter((t) => t.mode !== 'tui' && t.status !== 'stopped' && t.status !== 'error');
  const target = h('select', {}, h('option', { value: '', text: `New task in ${AG.cwd || 'home'}` }), ...running.map((t) => h('option', { value: t.id, text: `Existing: ${t.name}` })));
  const job = h('textarea', { rows: 4, placeholder: `What should ${A.name} do?` });
  modal([h('h3', { text: `Try ${A.name}` }), h('div', { class: 'muted', text: 'Sends a prompt asking the orchestrator to delegate this job to the agent with the task tool. Watch it in the Subagents dock.' }),
    h('div', { class: 'formgrid' }, agField('Job', job), agField('Run in', target)),
    h('div', { class: 'actions' }, h('button', { text: 'Cancel', onclick: closeModal }), h('button', { class: 'primary', text: 'Run', onclick: async () => {
      if (!job.value.trim()) return job.focus();
      const prompt = `Use the task tool to delegate the following to the "${A.name}" agent (agent: "${A.name}"), then report its result.\n\n${job.value.trim()}`;
      closeModal(); closePage();
      try {
        if (target.value) { selectTask(target.value); setTimeout(() => call({ type: 'prompt', message: prompt }), 400); }
        else { const { task } = await http('POST', '/api/tasks', { cwd: AG.cwd, name: `try ${A.name}`, prompt }); selectTask(task.id); }
      } catch (e) { toast(e.message, 'error'); }
    } }))]);
  job.focus();
}
