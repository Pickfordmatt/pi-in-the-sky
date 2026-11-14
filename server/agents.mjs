// omp task-agent manager: reads/writes the same agent files and settings omp uses.
//   project: <cwd>/.omp/agents/*.md   user: <agentDir>/agents/*.md   bundled: `omp agents unpack`
//   runtime overrides: task.agentModelOverrides, task.disabledAgents, task.agentPrewalk, task.agentAdvisor, ...
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';

export const KNOWN_TOOLS = [
  'read', 'write', 'edit', 'ast_edit', 'bash', 'find', 'grep', 'glob', 'ast_grep', 'lsp', 'debug', 'eval',
  'web_search', 'browser', 'github', 'task', 'todo', 'ask', 'wait', 'checkpoint', 'rewind',
  'recall', 'retain', 'reflect', 'learn', 'memory_edit', 'manage_skill', 'security_scan', 'computer', 'generate_image', 'tts', 'ida',
];

// UI field -> frontmatter key (first is the canonical spelling written; the rest are accepted aliases)
const KEYS = {
  name: ['name'], description: ['description'], tools: ['tools'], spawns: ['spawns'], model: ['model'],
  thinkingLevel: ['thinking-level', 'thinkingLevel', 'thinking'], blocking: ['blocking'], structured: ['structured'],
  autoloadSkills: ['autoloadSkills', 'autoload-skills'], readSummarize: ['read-summarize', 'readSummarize'],
  prewalk: ['prewalk'], advisor: ['advisor'], output: ['output'],
};

export const OVERRIDES = {
  model: 'task.agentModelOverrides', prewalk: 'task.agentPrewalk', advisor: 'task.agentAdvisor',
  serviceTier: 'task.agentServiceTierOverrides', compaction: 'task.agentCompactionThresholdOverrides',
  budget: 'task.agentSoftRequestBudget', accountPools: 'task.agentAccountPools',
};

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function splitFrontmatter(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)([\s\S]*)$/);
  if (!m) return { fm: '', body: String(text) };
  return { fm: m[1], body: m[2] };
}

function pick(obj, aliases) { for (const k of aliases) if (obj && Object.prototype.hasOwnProperty.call(obj, k)) return obj[k]; return undefined; }
const csv = (v) => (Array.isArray(v) ? v.map(String) : typeof v === 'string' ? v.split(',') : []).map((s) => s.trim()).filter(Boolean);

/** Parse one agent file into the normalized shape the UI edits. */
export function parseAgentFile(text, file, source) {
  const { fm, body } = splitFrontmatter(text);
  let data = {}, error = null;
  try { data = fm.trim() ? YAML.parse(fm) || {} : {}; } catch (e) { error = 'Frontmatter YAML error: ' + e.message.split('\n')[0]; }
  if (typeof data !== 'object' || Array.isArray(data)) { data = {}; error = error || 'Frontmatter must be a mapping'; }
  const toolsRaw = pick(data, KEYS.tools);
  const spawnsRaw = pick(data, KEYS.spawns);
  const a = {
    name: typeof data.name === 'string' ? data.name.trim() : '',
    description: typeof data.description === 'string' ? data.description.trim() : '',
    toolsMode: toolsRaw === undefined || toolsRaw === null ? 'default' : csv(toolsRaw).length ? 'custom' : 'none',
    tools: csv(toolsRaw),
    spawnsMode: spawnsRaw === undefined ? (csv(toolsRaw).includes('task') ? 'all' : 'none') : (spawnsRaw === '*' || (Array.isArray(spawnsRaw) && spawnsRaw.includes('*')) ? 'all' : csv(spawnsRaw).length ? 'custom' : 'none'),
    spawns: spawnsRaw === '*' ? [] : csv(spawnsRaw).filter((s) => s !== '*'),
    model: Array.isArray(data.model) ? data.model.join(', ') : typeof data.model === 'string' ? data.model : '',
    thinkingLevel: String(pick(data, KEYS.thinkingLevel) ?? ''),
    blocking: data.blocking === true,
    structured: data.structured === true,
    autoloadSkills: csv(pick(data, KEYS.autoloadSkills)),
    readSummarize: pick(data, KEYS.readSummarize) !== false,
    prewalk: data.prewalk === true ? 'on' : typeof data.prewalk === 'string' ? data.prewalk : '',
    advisor: data.advisor === true ? 'on' : typeof data.advisor === 'string' ? data.advisor : '',
    output: data.output !== undefined ? YAML.stringify(data.output).trimEnd() : '',
    systemPrompt: body.replace(/^\r?\n/, ''),
    source, file, error,
  };
  if (!error && !a.name) a.error = 'Missing required "name"';
  else if (!error && !a.description) a.error = 'Missing required "description"';
  else if (!error && ['main', 'sub'].includes(a.name.toLowerCase())) a.error = '"main" and "sub" are reserved names';
  return a;
}

/** Apply edited fields onto existing frontmatter (keeps unknown keys, comments and order). */
export function renderAgentFile(a, originalText) {
  const doc = originalText ? YAML.parseDocument(splitFrontmatter(originalText).fm || '') : new YAML.Document({});
  if (!doc.contents || !YAML.isMap(doc.contents)) doc.contents = doc.createNode({});
  const set = (field, value) => {
    const [canon, ...alts] = KEYS[field];
    for (const k of alts) doc.delete(k);
    if (value === undefined) doc.delete(canon); else doc.set(canon, value);
  };
  set('name', a.name.trim());
  set('description', a.description.trim());
  set('tools', a.toolsMode === 'default' ? undefined : a.toolsMode === 'none' ? doc.createNode([]) : [...new Set(csv(a.tools))].join(', '));
  set('spawns', a.spawnsMode === 'all' ? '*' : a.spawnsMode === 'custom' && csv(a.spawns).length ? [...new Set(csv(a.spawns))].join(', ') : undefined);
  set('model', a.model && a.model.trim() ? a.model.trim() : undefined);
  set('thinkingLevel', a.thinkingLevel || undefined);
  set('blocking', a.blocking ? true : undefined);
  set('structured', a.structured ? true : undefined);
  set('autoloadSkills', csv(a.autoloadSkills).length ? doc.createNode(csv(a.autoloadSkills)) : undefined);
  set('readSummarize', a.readSummarize === false ? false : undefined);
  set('prewalk', a.prewalk === 'on' ? true : a.prewalk ? a.prewalk : undefined);
  set('advisor', a.advisor === 'on' ? true : a.advisor ? a.advisor : undefined);
  if (a.output && a.output.trim()) {
    let out;
    try { out = YAML.parse(a.output); } catch (e) { throw new Error('Output schema is not valid YAML/JSON: ' + e.message.split('\n')[0]); }
    set('output', doc.createNode(out));
  } else set('output', undefined);
  const fm = doc.toString({ lineWidth: 0 }).trimEnd();
  const body = String(a.systemPrompt || '').replace(/^\s*\n/, '');
  return `---\n${fm}\n---\n\n${body.endsWith('\n') ? body : body + '\n'}`;
}

export class AgentManager {
  constructor({ cli, dataDir }) {
    this.cli = cli;
    this.dataDir = dataDir;
    this.agentDir = null;
  }

  async dirs(cwd) {
    if (!this.agentDir) this.agentDir = (await this.cli.paths()).agentDir;
    return {
      user: path.join(this.agentDir, 'agents'),
      project: cwd && fs.existsSync(cwd) ? path.join(path.resolve(cwd), '.omp', 'agents') : null,
    };
  }

  async bundledDir() {
    const v = (await this.cli.version()).replace(/[^\w.-]/g, '_');
    const dir = path.join(this.dataDir, 'bundled-agents', v);
    if (!fs.existsSync(dir) || !fs.readdirSync(dir).some((f) => f.endsWith('.md'))) {
      fs.mkdirSync(dir, { recursive: true });
      await this.cli.run(['agents', 'unpack', '--dir', dir, '--force', '--json'], { timeoutMs: 60000 });
    }
    return dir;
  }

  #readDir(dir, source) {
    if (!dir) return [];
    let files = [];
    try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort(); } catch { return []; }
    return files.map((f) => {
      const file = path.join(dir, f);
      try { return parseAgentFile(fs.readFileSync(file, 'utf8'), file, source); } catch (e) { return { name: f.replace(/\.md$/, ''), source, file, error: e.message }; }
    });
  }

  async list(cwd) {
    const d = await this.dirs(cwd);
    const bdir = await this.bundledDir();
    const project = this.#readDir(d.project, 'project');
    const user = this.#readDir(d.user, 'user');
    const bundled = this.#readDir(bdir, 'bundled');
    // omp precedence: project > user > (extensions/plugins) > bundled, first name wins
    const winner = new Map();
    for (const a of [...project, ...user, ...bundled]) if (a.name && !a.error && !winner.has(a.name)) winner.set(a.name, a);
    const all = [...project, ...user, ...bundled].map((a) => ({
      ...a,
      effective: !!a.name && winner.get(a.name) === a,
      shadowedBy: a.name && winner.get(a.name) && winner.get(a.name) !== a ? winner.get(a.name).source : null,
    }));
    const getRec = async (key) => { try { return (await this.cli.json(['config', 'get', key, '--json'])).value ?? {}; } catch { return {}; } };
    const overrides = {};
    await Promise.all(Object.entries(OVERRIDES).map(async ([k, key]) => { overrides[k] = await getRec(key); }));
    const disabled = await getRec('task.disabledAgents');
    return { dirs: { ...d, bundled: bdir }, agents: all, overrides, disabled: Array.isArray(disabled) ? disabled : [], tools: KNOWN_TOOLS };
  }

  #inside(file, dirs) {
    const f = path.resolve(file);
    return [dirs.user, dirs.project].filter(Boolean).some((d) => f.startsWith(path.resolve(d) + path.sep));
  }

  /** Create or update an agent. Either `agent` (structured fields) or `raw` (whole file) is supplied. */
  async save({ scope, cwd, originalFile, agent, raw }) {
    const d = await this.dirs(cwd);
    const dir = scope === 'project' ? d.project : d.user;
    if (!dir) throw new Error('Project scope needs an existing working directory');
    let original = null;
    if (originalFile) {
      if (!this.#inside(originalFile, d)) throw new Error('Can only edit user or project agents (copy bundled agents first)');
      try { original = fs.readFileSync(originalFile, 'utf8'); } catch {}
    }
    const text = raw != null ? String(raw) : renderAgentFile(agent, original);
    const parsed = parseAgentFile(text, null, scope);
    if (parsed.error) throw new Error(parsed.error);
    if (!SAFE_NAME.test(parsed.name)) throw new Error('Name may only use letters, digits, ".", "_" and "-" (max 64)');
    const file = path.join(dir, parsed.name + '.md');
    if (fs.existsSync(file) && path.resolve(file) !== path.resolve(originalFile || '')) {
      throw new Error(`An agent file named ${parsed.name}.md already exists in ${scope} scope`);
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, text, 'utf8');
    // renamed or moved scope: back up and remove the old file
    if (originalFile && path.resolve(originalFile) !== path.resolve(file) && fs.existsSync(originalFile)) this.#trash(originalFile);
    return { file, agent: parseAgentFile(text, file, scope) };
  }

  #trash(file) {
    const tdir = path.join(this.dataDir, 'agent-trash');
    fs.mkdirSync(tdir, { recursive: true });
    const dest = path.join(tdir, `${Date.now()}-${path.basename(file)}`);
    fs.copyFileSync(file, dest);
    fs.unlinkSync(file);
    return dest;
  }

  async remove(file, cwd) {
    const d = await this.dirs(cwd);
    if (!this.#inside(file, d)) throw new Error('Only user or project agent files can be deleted');
    if (!fs.existsSync(file)) throw new Error('File not found');
    return { backup: this.#trash(file) };
  }

  async setOverride(name, kind, value) {
    if (!name) throw new Error('name required');
    if (kind === 'disabled') {
      let cur = [];
      try { cur = (await this.cli.json(['config', 'get', 'task.disabledAgents', '--json'])).value || []; } catch {}
      const next = value ? [...new Set([...cur, name])] : cur.filter((n) => n !== name);
      // keep config.yml tidy: an empty list goes back to the default instead of being written out
      return next.length ? this.cli.setSetting('task.disabledAgents', next, 'array') : this.cli.resetSetting('task.disabledAgents');
    }
    const key = OVERRIDES[kind];
    if (!key) throw new Error('unknown override');
    let rec = {};
    try { rec = (await this.cli.json(['config', 'get', key, '--json'])).value || {}; } catch {}
    if (value === null || value === '' || value === undefined) delete rec[name];
    else rec[name] = kind === 'budget' ? Number(value) : value;
    return Object.keys(rec).length ? this.cli.setSetting(key, rec, 'record') : this.cli.resetSetting(key);
  }

  /** Ask omp itself (print mode, no tools) to draft an agent file from a plain-language description. */
  async generate({ description, name, tools, models }) {
    const example = (() => { try { return fs.readFileSync(path.join(this.dataDir, 'bundled-agents', fs.readdirSync(path.join(this.dataDir, 'bundled-agents'))[0], 'reviewer.md'), 'utf8').slice(0, 2500); } catch { return ''; } })();
    const prompt = [
      'You design subagents for the oh-my-pi (omp) coding agent. Write ONE agent definition file.',
      'Format: markdown with YAML frontmatter between --- lines, then the agent system prompt as the body.',
      'Frontmatter keys you may use:',
      '- name (required, kebab-case, not "main"/"sub")',
      '- description (required, one sentence: when the orchestrator should delegate to this agent)',
      `- tools: comma-separated subset of: ${(tools || KNOWN_TOOLS).join(', ')} (least privilege; omit = default toolset)`,
      '- spawns: "*" or comma-separated agent names it may delegate to (omit = none)',
      `- model: a role alias like "@smol" (fast/cheap), "@slow" (deep reasoning), "@default"${models?.length ? ', or one of: ' + models.slice(0, 12).join(', ') : ''}`,
      '- thinking-level: off | minimal | low | medium | high | xhigh',
      '- output: optional JSON-schema-like YAML for a structured result (properties with metadata.description and type)',
      'Body: a focused system prompt with sections: role, how to work, constraints, and what to return. Be specific and terse.',
      example ? 'Example of a bundled agent file:\n' + example : '',
      name ? `Use the name: ${name}` : '',
      'The agent to create:',
      description,
      'Reply with ONLY the file contents, starting with --- . No code fences, no commentary.',
    ].filter(Boolean).join('\n');
    const work = path.join(this.dataDir, 'agent-builder');
    fs.mkdirSync(work, { recursive: true });
    const r = await this.cli.run(['-p', '--no-session', '--no-tools', '--no-skills', '--no-rules', '--no-context-files', prompt], { cwd: work, timeoutMs: 300000 });
    if (r.code !== 0) throw new Error((r.stderr || r.stdout || 'omp failed').trim().slice(0, 500));
    let out = r.stdout.trim();
    const fence = out.match(/```(?:markdown|md|yaml)?\s*\n([\s\S]*?)```/);
    if (fence && !out.startsWith('---')) out = fence[1].trim();
    const i = out.indexOf('---');
    if (i > 0) out = out.slice(i);
    const parsed = parseAgentFile(out, null, 'user');
    return { raw: out, agent: parsed };
  }
}
