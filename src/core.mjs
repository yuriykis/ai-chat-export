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
import { renderBody, renderFrontmatter, yamlValue, ymd } from './render.mjs';

const HOME = os.homedir();
const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'ai-chat-export/config.json');
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'ai-chat-export');

const DEFAULTS = {
  folder: 'AI Chats',
  labels: { user: 'User', assistant: 'AI' },
  defaultTitle: 'Chat',
  frontmatter: {},
  projects: { fromActiveNote: false, category: '[[Projects]]' },
};

export function loadConfig() {
  if (!fs.existsSync(CONFIG_FILE)) throw new Error(`No config at ${CONFIG_FILE} — run \`ai-chat-export install\` first.`);
  const user = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  if (!user.vault) throw new Error(`Set "vault" in ${CONFIG_FILE}.`);
  return {
    ...DEFAULTS,
    ...user,
    labels: { ...DEFAULTS.labels, ...user.labels },
    projects: { ...DEFAULTS.projects, ...user.projects },
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
// as are built-in slash commands that got no reply (/model, /clear…).
function normalize(items) {
  const out = [];
  let skipping = false;
  for (const m of items) {
    const text = (m.text ?? '').trim();
    if (!text || (m.role !== 'user' && m.role !== 'assistant')) continue;
    if (m.role === 'user') {
      skipping = SAVE_COMMAND.test(text);
      if (!skipping) out.push({ role: 'user', text, ts: m.ts });
    } else if (!skipping) {
      const prev = out.at(-1);
      if (prev?.role === 'assistant') prev.text += `\n\n${text}`;
      else out.push({ role: 'assistant', text, ts: m.ts });
    }
  }
  return out.filter((m, i) => !(m.role === 'user' && m.text.startsWith('/') && i < out.length - 1 && out[i + 1].role !== 'assistant'));
}

function collect(marker, { messages, prompt, reply }) {
  const h = harnesses[marker.harness];
  const raw = messages ?? (marker.transcript && fs.existsSync(marker.transcript) ? h.parse(marker.transcript) : []);
  const items = normalize(raw);
  // The Stop hook can run before the final reply reaches the transcript; the hook carries it too.
  const last = reply?.trim();
  if (last && items.length && !(items.at(-1).role === 'assistant' && items.at(-1).text.endsWith(last))) {
    if (items.at(-1).role === 'assistant') items.at(-1).text += `\n\n${last}`;
    else items.push({ role: 'assistant', text: last, ts: new Date().toISOString() });
  }
  // UserPromptSubmit fires before the prompt reaches the transcript; show it right away.
  const pending = prompt?.trim();
  if (pending && !SAVE_COMMAND.test(pending) && items.findLast((m) => m.role === 'user')?.text !== pending) {
    items.push({ role: 'user', text: pending, ts: new Date().toISOString() });
  }
  return items;
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
  const body = renderBody(collect(marker, input), cfg.labels);
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

function frontmatterOf(file) {
  try { return fs.readFileSync(file, 'utf8').match(/^---\n([\s\S]*?)\n---/)?.[1] ?? ''; } catch { return ''; }
}

// Only for sessions started inside the vault: the note open in Obsidian (the `active` leaf of
// workspace.json). If it is a project, that project; if it links `projects`, those; otherwise none.
function detectProjects(cfg, cwd) {
  if (!cfg.projects.fromActiveNote || !cwd.startsWith(cfg.vault)) return [];
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
  const fm = frontmatterOf(path.join(cfg.vault, rel));
  const category = cfg.projects.category.replace(/[[\]]/g, '');
  if (new RegExp(`^category:\\s*"?\\[\\[${category}\\]\\]"?\\s*$`, 'm').test(fm)) return [path.basename(rel, '.md')];
  const list = fm.match(/^projects:[ \t]*\n((?:[ \t]+-.*\n?)*)/m)?.[1] ?? '';
  return [...list.matchAll(/\[\[([^\]|#]+)/g)].map((m) => m[1]);
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
  const projects = detectProjects(cfg, process.cwd());
  const now = new Date();
  const title = (opts.title || projects[0] || cfg.defaultTitle).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const marker = {
    harness,
    sid,
    transcript: harnesses[harness].findTranscript(sid),
    projects,
    created: ymd(now),
    file: uniqueFile(path.join(cfg.vault, cfg.folder), `${ymd(now)} ${title}`),
    written: false,
  };
  saveMarker(marker);
  const file = write(cfg, marker);
  return `Saving this conversation to ${rel(file)}${projects.length ? ` (project: ${projects.join(', ')})` : ''}. Every new message is added as it happens.`;
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
    prompt: input.hook_event_name === 'UserPromptSubmit' || input.messages ? input.prompt : undefined,
    reply: input.hook_event_name === 'Stop' ? input.last_assistant_message : undefined,
  });
  return h.hookOutput(input.hook_event_name);
}
