// Turns a conversation into the Markdown body of an Obsidian note, laid out like Pi's session export:
// a session info box on top, each of your messages in a grey box with its time, replies as plain text.

import os from 'node:os';

const pad = (n) => String(n).padStart(2, '0');
export const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const hm = (d) => `${pad(d.getHours())}:${pad(d.getMinutes())}`;

const AGENT_NAMES = { claude: 'Claude Code', codex: 'Codex', pi: 'Pi', opencode: 'OpenCode' };

// Web links stay clickable. Everything else — `[uart.c](uart.c)`, `[[Note]]`, embeds — would point
// into the vault, and clicking it would create an empty note there, so it becomes plain text.
const WEB = /^(?:https?:|mailto:)/i;

function unlink(text) {
  return text
    .replace(/!?\[([^\]\n]*)\]\(<?([^)>\s]*)>?(?:\s+"[^"]*")?\)/g, (m, label, target) => {
      if (WEB.test(target)) return m;
      const shown = label.trim() || target;
      return /\s/.test(shown) || shown.includes('`') ? shown : `\`${shown}\``;
    })
    .replace(/(!?)\[\[/g, '$1\\[\\[');
}

// The chat text must not change the vault: `- [ ]` would become a task (Tasks plugin), `#word` a tag,
// a relative link a new empty note, and `# Heading` would break the note's outline. Fenced code stays.
export function sanitize(text) {
  let fence = null;
  const lines = text.split('\n').map((line) => {
    const f = line.match(/^\s*(`{3,}|~{3,})/);
    if (f) {
      if (!fence) fence = f[1];
      else if (f[1][0] === fence[0] && f[1].length >= fence.length) fence = null;
      return line;
    }
    if (fence) return line;
    line = unlink(line);
    line = line.replace(/^(\s*(?:[-*+]|\d+[.)])\s+)\[(.)\]/, '$1\\[$2]');
    line = line.replace(/^#{1,6}(?=\s)/, (h) => '#'.repeat(Math.min(h.length + 2, 6)));
    return line
      .split(/(`+[^`]*`+)/)
      .map((seg, i) => (i % 2 ? seg : seg.replace(/(^|[^\w\\&#/])#(?=[\p{L}_/-]*[\p{L}_])/gu, '$1\\#')))
      .join('');
  });
  if (fence) lines.push(fence); // an unclosed fence would swallow everything after it
  return lines.join('\n');
}

const callout = (type, title, body) =>
  [`> [!${type}] ${title}`, ...body.split('\n').map((l) => (l ? `> ${l}` : '>'))].join('\n');

function infoBox(chat) {
  const { harness, cwd, models, messages } = chat;
  const first = messages[0]?.ts ? new Date(messages[0].ts) : new Date();
  const count = (role) => messages.filter((m) => m.role === role).length;
  const rows = [
    ['Date', `${ymd(first)} ${hm(first)}`],
    cwd && ['Directory', `\`${cwd.replace(os.homedir(), '~')}\``],
    models.length && [models.length > 1 ? 'Models' : 'Model', models.join(', ')],
    ['Messages', `${count('user')} user, ${count('assistant')} assistant`],
    chat.parentLink && ['Branch of', chat.parentLink],
  ].filter(Boolean);
  return callout('info', `${AGENT_NAMES[harness] ?? harness} session`, rows.map(([k, v]) => `**${k}:** ${v}  `).join('\n').trimEnd());
}

export function renderBody(chat) {
  const parts = [infoBox(chat)];
  let lastDay = ymd(chat.messages[0]?.ts ? new Date(chat.messages[0].ts) : new Date());
  // Lines linking to branches go right after the message the branch split off from.
  const marksAfter = (i) => (chat.marks ?? []).filter((m) => m.after === i).map((m) => m.line);
  parts.push(...marksAfter(-1));
  chat.messages.forEach((m, i) => {
    if (m.role === 'assistant') {
      parts.push(sanitize(m.text));
    } else {
      const d = m.ts ? new Date(m.ts) : new Date();
      const when = ymd(d) === lastDay ? hm(d) : `${ymd(d)} ${hm(d)}`;
      lastDay = ymd(d);
      parts.push(callout('quote', when, sanitize(m.text)));
    }
    parts.push(...marksAfter(i));
  });
  return `${parts.join('\n\n')}\n`;
}

// Quote only what YAML would misread, so dates stay plain dates like in hand-written notes.
export const yamlValue = (v) =>
  typeof v === 'string' && (/[[\]{}:#,&*!|>'"%@`]/.test(v) || v !== v.trim() || !v) ? JSON.stringify(v) : String(v);

export function yamlField(key, value) {
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) return `${key}:`;
  if (Array.isArray(value)) return `${key}:\n${value.map((v) => `  - ${yamlValue(v)}`).join('\n')}`;
  return `${key}: ${yamlValue(value)}`;
}

export function renderFrontmatter(fields) {
  return `---\n${Object.entries(fields).map(([k, v]) => yamlField(k, v)).join('\n')}\n---\n`;
}
