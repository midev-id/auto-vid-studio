// Runs Claude inside Auto Vid Studio with the Claude Agent SDK (no terminal window).
// One run per project. Every message is kept as an event list the UI reads over SSE
// (/api/panel/claude-events?name=). Tool permissions Claude asks for are shown in the app and answered there.
// The session id is saved in public/<name>/.claude-session so a revision continues the same conversation.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {spawn, execFile} from 'node:child_process';

const MODULES = (root) => process.env.GAS_MODULES || path.join(root, 'app', 'node_modules');
// the Claude Code binary that ships inside the SDK (used for login and status; query() finds it itself)
export const claudeExe = (root) => {
  const f = path.join(MODULES(root), '@anthropic-ai', `claude-agent-sdk-${process.platform}-${process.arch}`, process.platform === 'win32' ? 'claude.exe' : 'claude');
  return fs.existsSync(f) ? f : null;
};
// env for Claude without anything inherited from another Claude session (desktop app, terminal Claude Code)
export const cleanEnv = (root) => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!/^(CLAUDE|ANTHROPIC_)/.test(k) && k !== 'ELECTRON_RUN_AS_NODE') env[k] = v;
  const s = readSettings(root);
  if (s.apiKey) env.ANTHROPIC_API_KEY = s.apiKey;
  return env;
};
export const authStatus = (root) =>
  new Promise((resolve) => {
    const s = readSettings(root);
    if (s.apiKey) return resolve({loggedIn: true, method: 'API key'});
    const exe = claudeExe(root);
    if (!exe) return resolve({loggedIn: false, method: 'none', error: 'Claude Code bawaan SDK tidak ditemukan'});
    execFile(exe, ['auth', 'status'], {env: cleanEnv(root), timeout: 20000, windowsHide: true}, (_e, out) => {
      try {
        const j = JSON.parse(out);
        resolve({loggedIn: !!j.loggedIn, method: j.authMethod, email: j.email ?? j.account?.email ?? ''});
      } catch {
        resolve({loggedIn: false, method: 'none'});
      }
    });
  });
// sign in once with the browser (opens a small console window running `claude auth login`)
export const openLogin = (root) => {
  const exe = claudeExe(root);
  if (!exe) throw new Error('Claude Code bawaan SDK tidak ditemukan');
  // run claude.exe itself: detached on Windows gives it its own console window, and Node quotes the path
  // (paths with spaces, like the installed "Auto Vid Studio" folder, broke the old `cmd /c start` form)
  spawn(exe, ['auth', 'login'], {env: cleanEnv(root), detached: true, stdio: 'ignore', windowsHide: false}).unref();
};

let sdk = null;
const loadSdk = async (root) => {
  if (sdk) return sdk;
  const f = path.join(MODULES(root), '@anthropic-ai', 'claude-agent-sdk', 'sdk.mjs');
  if (!fs.existsSync(f)) throw new Error('Claude Agent SDK belum terpasang (cd app; npm install)');
  sdk = await import(pathToFileURL(f).href);
  return sdk;
};

// ---------- settings (stored next to the workspace, never sent anywhere but Anthropic) ----------
export const settingsFile = (root) => path.join(root, '.studio', 'settings.json');
export const DEFAULT_SETTINGS = {
  apiKey: '', // empty = use the Claude Code login on this PC
  model: '', // empty = Claude Code default
  effort: '', // '', low, medium, high, xhigh, max
  approve: 'edits', // edits: file edits auto, other tools ask | all: everything auto | ask: ask for every tool
};
export const readSettings = (root) => {
  try {
    return {...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(settingsFile(root), 'utf8'))};
  } catch {
    return {...DEFAULT_SETTINGS};
  }
};
export const writeSettings = (root, patch) => {
  const s = {...readSettings(root)};
  for (const k of Object.keys(DEFAULT_SETTINGS)) if (k in patch) s[k] = String(patch[k] ?? '').trim();
  fs.mkdirSync(path.dirname(settingsFile(root)), {recursive: true});
  fs.writeFileSync(settingsFile(root), JSON.stringify(s, null, 2));
  return s;
};
// what the UI may see: never the key itself
export const publicSettings = (root) => {
  const s = readSettings(root);
  return {...s, apiKey: s.apiKey ? `••••${s.apiKey.slice(-4)}` : '', hasKey: !!s.apiKey};
};

// tools that only read never need a question
const READ_ONLY = new Set(['Read', 'Glob', 'Grep', 'LS', 'TodoWrite', 'WebSearch', 'WebFetch', 'Skill', 'ToolSearch']);
const EDITS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

// ---------- runs ----------
const runs = new Map(); // name -> run

const summarizeTool = (name, input = {}) => {
  if (name === 'Bash' || name === 'PowerShell') return String(input.command ?? '').slice(0, 400);
  if (input.file_path) return String(input.file_path);
  if (input.pattern) return String(input.pattern);
  if (input.skill) return String(input.skill);
  if (input.description) return String(input.description);
  return JSON.stringify(input).slice(0, 300);
};

const push = (run, ev) => {
  ev.id = run.events.length;
  ev.t = Date.now();
  run.events.push(ev);
  for (const fn of run.listeners) fn(ev);
};

export const getRun = (name) => runs.get(name) ?? null;
export const runState = (name) => {
  const r = runs.get(name);
  if (!r) return null;
  return {state: r.state, started: r.started, cost: r.cost, pending: [...r.pending.keys()]};
};

export const subscribe = (name, fromId, fn) => {
  const r = runs.get(name);
  if (!r) return () => {};
  for (const ev of r.events) if (ev.id >= fromId) fn(ev);
  r.listeners.add(fn);
  return () => r.listeners.delete(fn);
};

export const answerPermission = (name, reqId, allow, always = false) => {
  const r = runs.get(name);
  const p = r?.pending.get(reqId);
  if (!p) return false;
  r.pending.delete(reqId);
  if (always) r.alwaysAllow.add(p.tool);
  push(r, {type: 'permission-answer', reqId, allow});
  p.resolve(allow ? {behavior: 'allow', updatedInput: p.input} : {behavior: 'deny', message: 'User menolak lewat app.'});
  return true;
};

export const stopRun = (name) => {
  const r = runs.get(name);
  if (!r || r.state !== 'running') return false;
  r.abort.abort();
  for (const [id] of r.pending) answerPermission(name, id, false);
  return true;
};

/**
 * Start Claude on a task for one project.
 * @param {object} o
 * @param {string} o.root     workspace root (cwd for Claude, holds CLAUDE.md)
 * @param {string} o.name     project name
 * @param {string} o.prompt   the task
 * @param {boolean} o.resume  continue the project's last Claude session
 * @param {string} o.appendSystem extra system prompt (extension rules)
 */
export const startRun = async ({root, name, prompt, resume = false, appendSystem = ''}) => {
  const old = runs.get(name);
  if (old?.state === 'running') throw new Error('Claude masih jalan di project ini');
  const {query} = await loadSdk(root);
  const settings = readSettings(root);
  const sessFile = path.join(root, 'public', name, '.claude-session');
  const sessionId = resume && fs.existsSync(sessFile) ? fs.readFileSync(sessFile, 'utf8').trim() : '';

  const run = {name, state: 'running', started: Date.now(), cost: 0, events: [], listeners: new Set(), pending: new Map(), alwaysAllow: new Set(), abort: new AbortController()};
  runs.set(name, run);
  push(run, {type: 'user', text: prompt});

  const env = cleanEnv(root);

  const canUseTool = (tool, input, {signal}) => {
    if (READ_ONLY.has(tool) || run.alwaysAllow.has(tool) || settings.approve === 'all' || (settings.approve === 'edits' && EDITS.has(tool)))
      return Promise.resolve({behavior: 'allow', updatedInput: input});
    return new Promise((resolve) => {
      const reqId = `p${run.events.length}`;
      run.pending.set(reqId, {tool, input, resolve});
      push(run, {type: 'permission', reqId, tool, detail: summarizeTool(tool, input)});
      signal?.addEventListener('abort', () => answerPermission(name, reqId, false));
    });
  };

  const options = {
    cwd: root,
    abortController: run.abort,
    settingSources: ['user', 'project', 'local'], // CLAUDE.md + the user's skills (hyperframes etc.)
    systemPrompt: {type: 'preset', preset: 'claude_code', ...(appendSystem ? {append: appendSystem} : {})},
    permissionMode: 'default',
    canUseTool,
    env,
    ...(settings.model ? {model: settings.model} : {}),
    ...(settings.effort ? {effort: settings.effort} : {}),
    ...(sessionId ? {resume: sessionId} : {}),
  };

  (async () => {
    try {
      for await (const m of query({prompt, options})) {
        if (m.type === 'system' && m.subtype === 'init') {
          fs.writeFileSync(sessFile, m.session_id);
          push(run, {type: 'init', model: m.model, session: m.session_id});
        } else if (m.type === 'assistant') {
          for (const b of m.message?.content ?? []) {
            if (b.type === 'text' && b.text.trim()) push(run, {type: 'text', text: b.text});
            else if (b.type === 'tool_use') push(run, {type: 'tool', tool: b.name, detail: summarizeTool(b.name, b.input)});
          }
        } else if (m.type === 'user') {
          for (const b of Array.isArray(m.message?.content) ? m.message.content : []) {
            if (b.type === 'tool_result' && b.is_error) {
              const t = Array.isArray(b.content) ? b.content.map((c) => c.text ?? '').join('\n') : String(b.content ?? '');
              push(run, {type: 'tool-error', text: t.slice(0, 600)});
            }
          }
        } else if (m.type === 'result') {
          run.cost = m.total_cost_usd ?? 0;
          push(run, {type: 'result', ok: m.subtype === 'success' && !m.is_error, text: m.result ?? m.subtype, cost: run.cost, turns: m.num_turns});
        }
      }
      run.state = 'done';
    } catch (e) {
      run.state = run.abort.signal.aborted ? 'stopped' : 'error';
      push(run, {type: 'error', text: run.state === 'stopped' ? 'Dihentikan.' : String(e?.message ?? e)});
    }
    push(run, {type: 'end', state: run.state});
  })();
  return run;
};
