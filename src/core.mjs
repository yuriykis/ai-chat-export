// Recording state and the note itself.
//
// `start` creates a marker file for one session of one agent. Every hook call afterwards rebuilds the
// whole note body from the agent's own record of the conversation, so rewinds and compaction never
// leave stale text behind. The frontmatter is written once and then only `modified` is touched, so
// properties added by hand in Obsidian survive.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { harnesses } from './harnesses.mjs';
import { renderBody, renderFrontmatter, yamlField, yamlValue, ymd } from './render.mjs';

const HOME = os.homedir();
const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'ai-chat-export/config.json');
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'ai-chat-export');

const DEFAULTS = {
  folder: 'AI Chats',
  defaultTitle: 'Chat',
  frontmatter: {},
  projects: null,
};

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`No config at ${CONFIG_FILE} — run \`ai-chat-export install\` first.`);
  const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!user.vault) throw new Error(`Set "vault" in ${CONFIG_FILE}.`);
  return {
    ...DEFAULTS,
    ...user,
    projects: user.projects ? { category: '[[Projects]]', ...user.projects } : DEFAULTS.projects,
    configFile: CONFIG_FILE,
  };
}

const markerPath = (harness, sid) => path.join(STATE_DIR, `${harness}--${sid}.json`);
const loadMarker = (harness, sid) => JSON.parse(fs.readFileSync(markerPath(harness, sid), 'utf8'));
const saveMarker = (m) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(markerPath(m.harness, m.sid), JSON.stringify(m, null, 2));
};

// --- which conversation --------------------------------------------------------------------------

// Pi and OpenCode integrations export AI_CHAT_HARNESS / AI_CHAT_SESSION to the agent's shell;
// Claude Code and Codex export their own session id variables.
export function resolveSession({ harness, session }) {
  if (harness && !harnesses[harness]) throw new Error(`Unknown agent "${harness}". Known: ${Object.keys(harnesses).join(', ')}.`);
  if (harness && session) return { harness, sid: session };
  const env = process.env;
  const candidates = harness ? [harness] : ['pi', 'opencode', 'codex', 'claude'];
  for (const h of candidates) {
    if (env.AI_CHAT_HARNESS === h && env.AI_CHAT_SESSION) return { harness: h, sid: env.AI_CHAT_SESSION };
    const v = harnesses[h].sessionEnv.map((name) => env[name]).find(Boolean);
    if (v) return { harness: h, sid: v };
  }
  throw new Error(harness
    ? `Cannot find the ${harness} session id in the environment — pass --session.`
    : 'Cannot tell which agent session this is — pass --harness (and --session if needed).');
}

// --- messages --------------------------------------------------------------------------------------

const SAVE_COMMAND = /^(?:[/$](?:skill:)?save-chat\b|<skill[^>]*save-chat)/;

// Only user messages and text replies. The save-chat request itself and the reply to it are left out,
// as are built-in slash commands that got no reply (/model, /clear…). So is the owner's answer to the
// "which project?" question when the agent asked it in the chat: the first message after the save
// request, sent before `project` recorded the answer (`answeredAt`), and the reply to it.
function normalize(items, answeredAt) {
  const answered = answeredAt ? Date.parse(answeredAt) : NaN;
  const sentBefore = (m) => Date.parse(m.ts) <= answered;
  const isUser = (m) => m.role === 'user' && (m.text ?? '').trim();
  const out = [];
  let skipping = false;
  let afterSave = false;
  items.forEach((m, i) => {
    const text = (m.text ?? '').trim();
    if (!text || (m.role !== 'user' && m.role !== 'assistant')) return;
    if (m.role === 'user') {
      const next = items.slice(i + 1).find(isUser);
      const answer = afterSave && sentBefore(m) && !(next && sentBefore(next));
      afterSave = SAVE_COMMAND.test(text);
      skipping = afterSave || answer;
      if (!skipping) out.push({ role: 'user', text, ts: m.ts });
    } else if (!skipping) {
      const prev = out.at(-1);
      if (prev?.role === 'assistant') prev.text += `\n\n${text}`;
      else out.push({ role: 'assistant', text, ts: m.ts, model: m.model });
    }
  });
  const messages = out.filter((m, i) => !(m.role === 'user' && m.text.startsWith('/') && i < out.length - 1 && out[i + 1].role !== 'assistant'));
  return { messages, tailSkipped: skipping };
}

function collect(marker, { messages, prompt, reply, cwd }) {
  const h = harnesses[marker.harness];
  const parsed = messages
    ? { messages, cwd }
    : marker.transcript && fs.existsSync(marker.transcript) ? h.parse(marker.transcript) : { messages: [] };
  const { messages: items, tailSkipped } = normalize(parsed.messages, marker.answeredAt);
  // The Stop hook can run before the final reply reaches the transcript; the hook carries it too.
  // A reply to a left-out message (the save request, the project answer) stays out.
  const last = tailSkipped ? '' : reply?.trim();
  if (last && items.length && !(items.at(-1).role === 'assistant' && items.at(-1).text.endsWith(last))) {
    if (items.at(-1).role === 'assistant') items.at(-1).text += `\n\n${last}`;
    else items.push({ role: 'assistant', text: last, ts: new Date().toISOString() });
  }
  // UserPromptSubmit fires before the prompt reaches the transcript; show it right away.
  const pending = prompt?.trim();
  if (pending && !SAVE_COMMAND.test(pending) && items.findLast((m) => m.role === 'user')?.text !== pending) {
    items.push({ role: 'user', text: pending, ts: new Date().toISOString() });
  }
  const models = [...new Set(items.map((m) => m.model).filter((m) => m && !m.startsWith('<')))];
  return { harness: marker.harness, cwd: parsed.cwd ?? marker.cwd, models, messages: items };
}

// --- the note --------------------------------------------------------------------------------------

// A note moved or renamed in Obsidian is found again by its `session` property.
function locate(cfg, marker) {
  if (fs.existsSync(marker.file)) return marker.file;
  const dir = path.join(cfg.vault, cfg.folder);
  const needle = `\nsession: ${yamlValue(`${marker.harness}:${marker.sid}`)}\n`;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, name);
    if (name.endsWith('.md') && fs.readFileSync(file, 'utf8').includes(needle)) return file;
  }
  return null;
}

function write(cfg, marker, input = {}) {
  let file = locate(cfg, marker);
  if (!file) {
    // It was written before and is gone now: the owner deleted it. Do not bring it back.
    if (marker.written) { fs.rmSync(markerPath(marker.harness, marker.sid), { force: true }); return null; }
    file = marker.file;
  }
  const body = renderBody(collect(marker, input));
  const today = ymd(new Date());

  let content;
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    const fm = old.match(/^---\n[\s\S]*?\n---\n/)?.[0];
    if (fm && old.slice(fm.length).replace(/^\n/, '') === body) return file;
    content = `${(fm ?? newFrontmatter(cfg, marker)).replace(/^modified:.*$/m, `modified: ${today}`)}\n${body}`;
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    content = `${newFrontmatter(cfg, marker)}\n${body}`;
  }
  fs.writeFileSync(file, content);
  if (file !== marker.file || !marker.written) saveMarker({ ...marker, file, written: true });
  return file;
}

function newFrontmatter(cfg, marker) {
  return renderFrontmatter({
    created: marker.created,
    modified: marker.created,
    ...cfg.frontmatter,
    projects: marker.projects.map((p) => `[[${p}]]`),
    session: `${marker.harness}:${marker.sid}`,
  });
}

// --- project of the conversation ------------------------------------------------------------------
//
// Never guessed: the owner names it, or `start` asks the agent to ask. The suggestions only order the
// question — the project of an earlier chat from the same directory, then the note open in Obsidian.

function frontmatterOf(file) {
  try { return fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''; } catch { return ''; }
}

const PROJECTS_FIELD = /^projects:[^\n]*\n(?:[ \t]+-[^\n]*\n)*/m;
const linkedProjects = (fm) =>
  [...(`${fm}\n`.match(PROJECTS_FIELD)?.[0] ?? '').matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1].trim());

// Every project note in the vault, by lower-cased name.
function projectIndex(cfg) {
  const category = cfg.projects.category.replace(/[[\]]/g, '');
  const isProject = new RegExp(`^category:\\s*"?\\[\\[${category}\\]\\]"?\\s*$`, 'm');
  const index = new Map();
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.md')) {
        const fm = frontmatterOf(full);
        if (isProject.test(fm)) index.set(e.name.slice(0, -3).toLowerCase(), { name: e.name.slice(0, -3), active: /^status:.*\[\[Active\]\]/m.test(fm) });
      }
    }
  };
  walk(cfg.vault);
  return index;
}

// The note open in Obsidian (the `active` leaf of workspace.json): itself if it is a project,
// otherwise the projects it links.
function openNoteProjects(cfg, index) {
  let ws;
  try { ws = JSON.parse(fs.readFileSync(path.join(cfg.vault, '.obsidian/workspace.json'), 'utf8')); } catch { return []; }
  const find = (node) => {
    if (!node || typeof node !== 'object') return null;
    if (node.type === 'leaf' && node.id === ws.active) return node;
    for (const v of Object.values(node)) { const hit = find(v); if (hit) return hit; }
    return null;
  };
  const rel = find(ws)?.state?.state?.file;
  if (!rel?.endsWith('.md')) return [];
  const own = path.basename(rel, '.md');
  return index.has(own.toLowerCase()) ? [own] : linkedProjects(frontmatterOf(path.join(cfg.vault, rel)));
}

// The projects of the newest chat note recorded in the same directory that has any.
function directoryProjects(cfg, cwd) {
  const dir = path.join(cfg.vault, cfg.folder);
  const needle = `**Directory:** \`${cwd.replace(HOME, '~')}\``;
  const notes = (fs.existsSync(dir) ? fs.readdirSync(dir) : [])
    .filter((n) => n.endsWith('.md'))
    .map((n) => path.join(dir, n))
    .sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
  for (const file of notes) {
    const text = fs.readFileSync(file, 'utf8');
    if (!text.includes(needle)) continue;
    const found = linkedProjects(text.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? '');
    if (found.length) return found;
  }
  return [];
}

function suggestProjects(cfg, cwd, index) {
  const out = [];
  const add = (names, why) => {
    for (const n of names) {
      const hit = index.get(n.toLowerCase());
      if (hit && !out.some((s) => s.name === hit.name)) out.push({ name: hit.name, why });
    }
  };
  add(directoryProjects(cfg, cwd), 'an earlier chat from this directory');
  add(openNoteProjects(cfg, index), 'open in Obsidian');
  return out.slice(0, 3);
}

// Project names as given by the agent or the owner, checked against the vault.
function resolveProjects(cfg, names, index) {
  const clean = names.map((n) => String(n).replace(/^\[\[|\]\]$/g, '').trim()).filter(Boolean);
  const missing = clean.filter((n) => !index.has(n.toLowerCase()));
  if (missing.length) {
    const active = [...index.values()].filter((p) => p.active).map((p) => p.name).sort();
    throw new Error(`No project note named ${missing.map((n) => `"${n}"`).join(', ')}. Active projects: ${active.join(', ')}.`);
  }
  return clean.map((n) => index.get(n.toLowerCase()).name);
}

// --- commands --------------------------------------------------------------------------------------

function uniqueFile(dir, base) {
  let file = path.join(dir, `${base}.md`);
  for (let i = 2; fs.existsSync(file); i++) file = path.join(dir, `${base} ${i}.md`);
  return file;
}

export function start(opts) {
  const cfg = loadConfig();
  const { harness, sid } = resolveSession(opts);
  const rel = (f) => path.relative(cfg.vault, f);
  if (fs.existsSync(markerPath(harness, sid))) {
    const file = write(cfg, loadMarker(harness, sid));
    if (file) return `Already saving this conversation to ${rel(file)}.`;
  }
  const index = cfg.projects && projectIndex(cfg);
  const named = opts.project && opts.project !== true ? [opts.project] : [];
  const projects = named.length ? resolveProjects(cfg, named, index) : [];
  const now = new Date();
  const title = (opts.title || projects[0] || cfg.defaultTitle).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const marker = {
    harness,
    sid,
    transcript: harnesses[harness].findTranscript(sid),
    cwd: process.cwd(),
    projects,
    created: ymd(now),
    file: uniqueFile(path.join(cfg.vault, cfg.folder), `${ymd(now)} ${title}`),
    written: false,
  };
  saveMarker(marker);
  const file = write(cfg, marker);
  const saving = `Saving this conversation to ${rel(file)}${projects.length ? ` (project: ${projects.join(', ')})` : ''}. Every new message is added as it happens.`;
  if (!cfg.projects || projects.length) return saving;
  const suggested = suggestProjects(cfg, marker.cwd, index);
  return [
    saving,
    'No project is set. Ask the user which project this conversation belongs to, then run',
    `\`ai-chat-export project --harness ${harness} "<project>"\` or \`ai-chat-export project --harness ${harness} --none\`.`,
    suggested.length
      ? `Suggestions: ${suggested.map((s) => `${s.name} (${s.why})`).join('; ')}.`
      : 'No suggestions.',
  ].join('\n');
}

// Sets the project after the owner answered the question `start` asked. Only the `projects`
// property changes; the body follows on the next update, without the answer in it.
export function project(opts) {
  const cfg = loadConfig();
  if (!cfg.projects) throw new Error(`Projects are off — add "projects" to ${cfg.configFile}.`);
  const { harness, sid } = resolveSession(opts);
  if (!fs.existsSync(markerPath(harness, sid))) throw new Error('This conversation is not being saved — start saving it first.');
  if (!opts.none && !opts._.length) throw new Error('Give a project name, or --none for no project.');
  const projects = opts.none ? [] : resolveProjects(cfg, opts._, projectIndex(cfg));
  const marker = { ...loadMarker(harness, sid), projects, answeredAt: new Date().toISOString() };
  saveMarker(marker);
  const file = locate(cfg, marker);
  if (file) {
    const old = fs.readFileSync(file, 'utf8');
    const fm = old.match(/^---\n[\s\S]*?\n---\n/)?.[0];
    if (fm) {
      const field = `${yamlField('projects', projects.map((p) => `[[${p}]]`))}\n`;
      const next = PROJECTS_FIELD.test(fm) ? fm.replace(PROJECTS_FIELD, field) : fm.replace(/\n---\n$/, `\n${field}---\n`);
      fs.writeFileSync(file, next + old.slice(fm.length));
    }
  }
  return projects.length ? `Project set: ${projects.join(', ')}.` : 'Saving without a project.';
}

export function stop(opts) {
  const cfg = loadConfig();
  const { harness, sid } = resolveSession(opts);
  if (!fs.existsSync(markerPath(harness, sid))) return 'This conversation was not being saved.';
  const file = write(cfg, loadMarker(harness, sid));
  fs.rmSync(markerPath(harness, sid), { force: true });
  return `Stopped saving. The note stays at ${file ? path.relative(cfg.vault, file) : '(deleted)'}.`;
}

// Called by every integration after each user message and each finished reply. Must stay silent
// unless the agent needs specific output, and must be cheap when the session is not being recorded.
export function hook(harness, input) {
  const h = harnesses[harness];
  if (!h) return '';
  const sid = input.session_id;
  if (!sid || !fs.existsSync(markerPath(harness, sid))) return h.hookOutput(input.hook_event_name);
  const marker = loadMarker(harness, sid);
  if (input.transcript_path && input.transcript_path !== marker.transcript) {
    marker.transcript = input.transcript_path;
    saveMarker(marker);
  }
  write(loadConfig(), marker, {
    messages: input.messages,
    cwd: input.cwd,
    prompt: input.hook_event_name === 'UserPromptSubmit' || input.messages ? input.prompt : undefined,
    reply: input.hook_event_name === 'Stop' ? input.last_assistant_message : undefined,
  });
  return h.hookOutput(input.hook_event_name);
}
