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
import { hm, renderBody, renderFrontmatter, yamlField, yamlValue, ymd } from './render.mjs';

const HOME = os.homedir();
const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'ai-chat-export/config.json');
export const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(HOME, '.local/state'), 'ai-chat-export');

const DEFAULTS = {
  folder: 'AI Chats',
  defaultTitle: 'Chat',
  frontmatter: {},
  projects: null,
  branchLabel: 'branch',
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
const readMarker = (harness, sid) => { try { return loadMarker(harness, sid); } catch { return null; } };
// A fork adds itself to its parent's `children` from another process; never drop an entry.
const saveMarker = (m) => {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  const children = [...(m.children ?? [])];
  for (const c of readMarker(m.harness, m.sid)?.children ?? []) if (!children.some((x) => x.sid === c.sid)) children.push(c);
  fs.writeFileSync(markerPath(m.harness, m.sid), JSON.stringify(children.length ? { ...m, children } : m, null, 2));
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
      if (!skipping) out.push({ role: 'user', text, ts: m.ts, uuid: m.uuid });
    } else if (!skipping) {
      const prev = out.at(-1);
      if (prev?.role === 'assistant') prev.text += `\n\n${text}`;
      else out.push({ role: 'assistant', text, ts: m.ts, model: m.model, uuid: m.uuid });
    }
  });
  const messages = out.filter((m, i) => !(m.role === 'user' && m.text.startsWith('/') && i < out.length - 1 && out[i + 1].role !== 'assistant'));
  return { messages, tailSkipped: skipping };
}

const modelsOf = (items) => [...new Set(items.map((m) => m.model).filter((m) => m && !m.startsWith('<')))];

function collect(marker, { messages, prompt, reply, cwd }, live) {
  const h = harnesses[marker.harness];
  const parsed = messages
    ? { messages, cwd }
    : live ?? (marker.transcript && fs.existsSync(marker.transcript) ? h.parse(marker.transcript) : { messages: [] });
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
  return { harness: marker.harness, cwd: parsed.cwd ?? marker.cwd, models: modelsOf(items), messages: items };
}

// --- the note --------------------------------------------------------------------------------------

// A note moved or renamed in Obsidian is found again by its `session` property, a branch note by
// `session` and `branch` together.
function locate(cfg, marker, branch = null) {
  const known = branch ? marker.branches?.[branch]?.file : marker.file;
  if (known && fs.existsSync(known)) return known;
  const dir = path.join(cfg.vault, cfg.folder);
  const session = `\nsession: ${yamlValue(`${marker.harness}:${marker.sid}`)}\n`;
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    const file = path.join(dir, name);
    if (!name.endsWith('.md')) continue;
    const fm = fs.readFileSync(file, 'utf8').match(/^---\n[\s\S]*?\n---\n/)?.[0] ?? '';
    if (!fm.includes(session)) continue;
    if (branch ? fm.includes(`\nbranch: ${branch}\n`) : !fm.includes('\nbranch: ')) return file;
  }
  return null;
}

// Writes the body under the note's own frontmatter (or a new one); true if the file changed.
function writeNote(file, body, frontmatter) {
  if (fs.existsSync(file)) {
    const old = fs.readFileSync(file, 'utf8');
    const fm = old.match(/^---\n[\s\S]*?\n---\n/)?.[0];
    if (fm && old.slice(fm.length).replace(/^\n/, '') === body) return false;
    fs.writeFileSync(file, `${(fm ?? frontmatter()).replace(/^modified:.*$/m, `modified: ${ymd(new Date())}`)}\n${body}`);
  } else {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${frontmatter()}\n${body}`);
  }
  return true;
}

function write(cfg, marker, input = {}) {
  const h = harnesses[marker.harness];
  let file = locate(cfg, marker);
  if (!file) {
    // It was written before and is gone now: the owner deleted it. Do not bring it back.
    if (marker.written) { fs.rmSync(markerPath(marker.harness, marker.sid), { force: true }); return null; }
    file = marker.file;
  }
  // Pi and OpenCode send the messages with each hook call. `start` and `stop` run without them, so
  // an existing note keeps its body instead of being rebuilt empty.
  if (h.pushed && !input.messages && fs.existsSync(file)) return file;
  let paths = !input.messages && h.paths && marker.transcript && fs.existsSync(marker.transcript) ? h.paths(marker.transcript) : null;
  // A stopped recording is rewritten only to add a fork's line; what was said after it stopped stays out.
  if (paths && marker.stoppedAt) paths = paths.map((p) => cutAt(p, Date.parse(marker.stoppedAt))).filter((p) => p.ids.length);
  const chat = collect(marker, input, paths?.[0]);
  const next = { ...marker, file, written: true };
  const notes = paths ? branchNotes(cfg, next, file, chat, paths) : [];
  writeNote(file, renderBody(chat), () => newFrontmatter(cfg, marker));
  // After the main note, so a new branch takes the projects the main note has now.
  for (const note of notes) {
    if (note.key) writeNote(note.file, renderBody(note.chat), () => branchFrontmatter(cfg, next, note.key, file));
  }
  if (JSON.stringify(next) !== JSON.stringify(marker)) saveMarker(next);
  return file;
}

function cutAt(p, time) {
  const end = p.times.findIndex((t) => Date.parse(t) > time);
  if (end < 0) return p;
  const ids = p.ids.slice(0, end);
  const kept = new Set(ids);
  return { ...p, ids, times: p.times.slice(0, end), messages: p.messages.filter((m) => kept.has(m.uuid)) };
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

// --- branches -------------------------------------------------------------------------------------
//
// Claude Code keeps a conversation as a tree. The note always shows the live path; a branch left
// behind by a rewind gets a note of its own with the messages after the point where it split off.
// A fork (`--fork-session`) is a new session, saved only when asked, and then only from its split.
// If the conversation it came from has a note, the split point there gets a line linking to the
// fork, with a block id the fork links back to.

const noteName = (file) => path.basename(file, '.md');
const branchLine = (file, anchor) => `↳ Branch: [[${noteName(file)}]] ^${anchor}`;
const backLink = (file, anchor) => `[[${noteName(file)}#^${anchor}|${noteName(file)}]]`;

function branchFile(cfg, of, taken) {
  const label = cfg.branchLabel;
  const base = noteName(of).replace(new RegExp(` \\(${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\d+\\)$`), '');
  for (let n = 1; ; n++) {
    const file = path.join(cfg.vault, cfg.folder, `${base} (${label} ${n}).md`);
    if (!fs.existsSync(file) && !taken.has(file)) { taken.add(file); return file; }
  }
}

function branchFrontmatter(cfg, marker, key, mainFile) {
  const today = ymd(new Date());
  return renderFrontmatter({
    created: today,
    modified: today,
    ...cfg.frontmatter,
    projects: linkedProjects(frontmatterOf(mainFile)).map((p) => `[[${p}]]`),
    session: `${marker.harness}:${marker.sid}`,
    branch: key,
  });
}

// Builds the branch notes of one session and puts the split-point lines (`marks`) into `chat` and
// into them. Updates `marker.branches` and `marker.children` in place.
function branchNotes(cfg, marker, file, chat, paths) {
  const [live, ...rest] = paths;
  const own = (ids, after) => new Set(after && ids.includes(after) ? ids.slice(ids.indexOf(after) + 1) : ids);
  const main = { key: null, ids: live.ids, own: own(live.ids, marker.parent?.at), file, chat };
  if (marker.parent) {
    chat.messages = chat.messages.filter((m) => !m.uuid || main.own.has(m.uuid));
    if (marker.parent.unsaved) {
      const t = live.times[live.ids.indexOf(marker.parent.at)];
      chat.parentLink = `an unsaved conversation${t ? `, ${ymd(new Date(t))} ${hm(new Date(t))}` : ''}`;
    } else {
      const parent = readMarker(marker.harness, marker.parent.sid);
      const where = parent?.children?.find((c) => c.sid === marker.sid)?.note ?? marker.parent.note;
      if (where) marker.parent = { ...marker.parent, note: where };
      if (where && fs.existsSync(where)) chat.parentLink = backLink(where, `fork-${marker.sid.slice(0, 8)}`);
    }
  }
  const notes = [main];
  const marks = [];
  const branches = { ...marker.branches };
  const taken = new Set(Object.values(branches).map((b) => b.file).filter(Boolean));

  for (const p of rest) {
    // The note this path shares the longest start with is where it split off.
    let parent = null;
    let at = 0;
    for (const n of notes) {
      let k = 0;
      while (k < p.ids.length && k < n.ids.length && p.ids[k] === n.ids[k]) k++;
      if (k > at) { at = k; parent = n; }
    }
    if (!parent || at >= p.ids.length) continue;
    const key = p.ids[at];
    const mine = new Set(p.ids.slice(at));
    const shown = normalize(p.messages, marker.answeredAt).messages.filter((m) => mine.has(m.uuid));
    // Only a full exchange makes a branch; a message taken back before any reply does not.
    const asked = shown.findIndex((m) => m.role === 'user');
    if (asked < 0 || !shown.slice(asked).some((m) => m.role === 'assistant')) continue;
    if (branches[key]?.deleted) continue;
    let bfile = locate(cfg, { ...marker, branches }, key);
    if (!bfile) {
      if (branches[key]?.written) { branches[key] = { deleted: true }; continue; }
      bfile = branches[key]?.file ?? branchFile(cfg, file, taken);
    }
    branches[key] = { file: bfile, written: true };
    const anchor = `branch-${key.slice(0, 8)}`;
    const note = {
      key,
      ids: p.ids,
      own: mine,
      file: bfile,
      chat: { harness: marker.harness, cwd: p.cwd ?? chat.cwd, models: modelsOf(shown), messages: shown, parentLink: backLink(parent.file, anchor) },
    };
    notes.push(note);
    marks.push({ note: parent, at: p.ids[at - 1], line: branchLine(bfile, anchor) });
  }

  const children = (marker.children ?? []).map((c) => {
    // A fork that has just been adopted has no note yet, only the file it is about to write.
    const fork = readMarker(marker.harness, c.sid);
    const target = locate(cfg, fork ?? { harness: marker.harness, sid: c.sid, file: c.file ?? '' }) ?? (fork && !fork.written ? fork.file : null);
    if (!target) return c;
    const owner = notes.find((n) => n.own.has(c.at)) ?? main;
    marks.push({ note: owner, at: c.at, line: branchLine(target, `fork-${c.sid.slice(0, 8)}`) });
    return { ...c, file: target, note: owner.file };
  });

  // A split line goes right after the last message at or before the split point.
  for (const n of notes) {
    const index = new Map(n.ids.map((id, i) => [id, i]));
    n.chat.marks = marks.filter((m) => m.note === n).map((m) => {
      // A fork made after a recording stopped split off past the end of its note.
      const limit = index.get(m.at) ?? Infinity;
      const after = n.chat.messages.findLastIndex((x) => (index.get(x.uuid) ?? Infinity) <= limit);
      return { after, line: m.line };
    });
  }
  if (Object.keys(branches).length) marker.branches = branches;
  if (children.length) marker.children = children;
  return notes;
}

// The recording of the conversation a fork was made from, if it has a note: its marker, or one rebuilt
// for a recording stopped before markers were kept, treated as stopped when the note last changed.
function originRecording(cfg, harness, origin) {
  const m = readMarker(harness, origin.sid);
  if (m) {
    const note = locate(cfg, m);
    return note ? { marker: m, note } : null;
  }
  const note = locate(cfg, { harness, sid: origin.sid, file: '' });
  if (!note) return null;
  const fm = frontmatterOf(note);
  const marker = {
    harness,
    sid: origin.sid,
    transcript: origin.transcript,
    projects: linkedProjects(fm),
    created: fm.match(/^created:\s*(\S+)/m)?.[1] ?? ymd(new Date()),
    file: note,
    written: true,
    stopped: true,
    stoppedAt: fs.statSync(note).mtime.toISOString(),
  };
  return { marker, note };
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
  const existing = readMarker(harness, sid);
  if (existing?.stopped) {
    const { stopped, stoppedAt, ...resumed } = existing;
    saveMarker(resumed);
    const file = write(cfg, resumed);
    if (file) return `Saving this conversation again to ${rel(file)}. Every new message is added as it happens.`;
  } else if (existing) {
    const file = write(cfg, existing);
    if (file) return `Already saving this conversation to ${rel(file)}.`;
  }
  const h = harnesses[harness];
  const transcript = h.findTranscript(sid);
  const origin = transcript && h.forkOrigin ? h.forkOrigin(transcript) : null;
  const from = origin && originRecording(cfg, harness, origin);
  const index = cfg.projects && projectIndex(cfg);
  const named = opts.project && opts.project !== true ? [opts.project] : [];
  const projects = named.length ? resolveProjects(cfg, named, index) : from ? linkedProjects(frontmatterOf(from.note)) : [];
  const now = new Date();
  const title = (opts.title || projects[0] || cfg.defaultTitle).replace(/[\\/:*?"<>|#^[\]]/g, '').replace(/\s+/g, ' ').trim().slice(0, 100);
  const marker = {
    harness,
    sid,
    transcript,
    cwd: process.cwd(),
    projects,
    created: ymd(now),
    file: from ? branchFile(cfg, from.note, new Set()) : uniqueFile(path.join(cfg.vault, cfg.folder), `${ymd(now)} ${title}`),
    written: false,
    ...(origin && { parent: { sid: origin.sid, at: origin.at, ...(!from && { unsaved: true }) } }),
  };
  saveMarker(marker);
  if (from) {
    // The note it came from gets the line pointing here before this note is written, so both links exist.
    saveMarker({ ...from.marker, children: [...(from.marker.children ?? []), { sid, at: origin.at }] });
    write(cfg, loadMarker(harness, origin.sid));
  }
  const file = write(cfg, marker);
  const what = from ? `this fork of ${noteName(from.note)}` : origin ? 'this fork from where it split off' : 'this conversation';
  const saving = `Saving ${what} to ${rel(file)}${projects.length ? ` (project: ${projects.join(', ')})` : ''}. Every new message is added as it happens.`;
  if (!cfg.projects || projects.length || from) return saving;
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
  if (!readMarker(harness, sid) || readMarker(harness, sid).stopped) throw new Error('This conversation is not being saved — start saving it first.');
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
  const marker = readMarker(harness, sid);
  if (!marker || marker.stopped) return 'This conversation was not being saved.';
  const file = write(cfg, marker);
  // The marker stays, marked stopped: a later fork of this conversation can still link to its note.
  if (file) saveMarker({ ...readMarker(harness, sid), stopped: true, stoppedAt: new Date().toISOString() });
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
  if (marker.stopped) return h.hookOutput(input.hook_event_name);
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
