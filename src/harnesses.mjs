// Where each agent keeps its conversations and how to read them.
//
// Claude Code and Codex write JSONL transcripts that the hooks point to, so they are parsed here.
// Pi and OpenCode have extension APIs instead: their integrations send the messages themselves,
// already as [{ role, text, ts }], so nothing needs to be parsed for them.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const HOME = os.homedir();

function readJsonl(file) {
  const entries = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch { /* a line still being written */ }
  }
  return entries;
}

const textBlocks = (content, types) =>
  typeof content === 'string'
    ? content
    : Array.isArray(content) ? content.filter((b) => types.includes(b.type)).map((b) => b.text).join('\n\n') : '';

const stripReminders = (text) => text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim();

// --- Claude Code ------------------------------------------------------------------------------

// The transcript is a tree (rewinds create branches). The live conversation is the parent chain of
// the newest message; after compaction the chain continues through logicalParentUuid.
function activeChain(entries) {
  const byId = new Map();
  let last = null;
  for (const e of entries) {
    if (!e.uuid || e.isSidechain) continue;
    byId.set(e.uuid, e);
    if (e.type === 'user' || e.type === 'assistant') last = e;
  }
  const chain = [];
  const seen = new Set();
  for (let e = last; e && !seen.has(e.uuid);) {
    seen.add(e.uuid);
    chain.push(e);
    const parent = e.parentUuid ?? e.logicalParentUuid;
    e = parent ? byId.get(parent) : null;
  }
  return chain.reverse();
}

function claudeUserText(raw) {
  const cmd = raw.match(/<command-name>([\s\S]*?)<\/command-name>/);
  if (cmd) {
    const args = raw.match(/<command-args>([\s\S]*?)<\/command-args>/)?.[1]?.trim();
    return cmd[1].trim() + (args ? ` ${args}` : '');
  }
  if (/<local-command-(stdout|stderr|caveat)>/.test(raw) || /^\[Request interrupted/.test(raw.trim())) return '';
  return stripReminders(raw);
}

const claude = {
  sessionEnv: ['CLAUDE_CODE_SESSION_ID'],
  findTranscript(sid) {
    const root = path.join(HOME, '.claude/projects');
    for (const dir of fs.existsSync(root) ? fs.readdirSync(root) : []) {
      const file = path.join(root, dir, `${sid}.jsonl`);
      if (fs.existsSync(file)) return file;
    }
    return null;
  },
  parse(file) {
    const out = [];
    for (const e of activeChain(readJsonl(file))) {
      if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly || e.isApiErrorMessage) continue;
      const content = e.message?.content;
      // A message typed while the agent is still working is stored as a queued command.
      const queued = e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.origin?.kind === 'human';
      if (queued) {
        out.push({ role: 'user', text: stripReminders(textBlocks(e.attachment.prompt, ['text'])), ts: e.timestamp });
      } else if (e.type === 'user') {
        if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
        out.push({ role: 'user', text: claudeUserText(textBlocks(content, ['text'])), ts: e.timestamp });
      } else if (e.type === 'assistant' && e.message?.model !== '<synthetic>') {
        out.push({ role: 'assistant', text: stripReminders(textBlocks(content, ['text'])), ts: e.timestamp });
      }
    }
    return out;
  },
  // Plain stdout of UserPromptSubmit would be added to the model's context, so print nothing.
  hookOutput: () => '',
};

// --- Codex ------------------------------------------------------------------------------------

// Codex sends AGENTS.md, the environment and skill bodies as user messages wrapped in tags.
const codexInjected = (t) => /^# AGENTS\.md instructions/.test(t) || /^\s*<([\w:-]+)[^>]*>[\s\S]*<\/\1>\s*$/.test(t);

function* walkNewestFirst(dir, depth) {
  if (!fs.existsSync(dir)) return;
  const names = fs.readdirSync(dir).sort().reverse();
  for (const name of names) {
    const full = path.join(dir, name);
    if (depth > 0) yield* walkNewestFirst(full, depth - 1);
    else yield full;
  }
}

const codex = {
  sessionEnv: ['CODEX_THREAD_ID', 'CODEX_SESSION_ID'],
  findTranscript(sid) {
    // ~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl
    for (const file of walkNewestFirst(path.join(HOME, '.codex/sessions'), 3)) {
      if (file.endsWith(`-${sid}.jsonl`)) return file;
    }
    return null;
  },
  parse(file) {
    const out = [];
    for (const e of readJsonl(file)) {
      if (e.type !== 'response_item' || e.payload?.type !== 'message') continue;
      const { role, content = [] } = e.payload;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = content
        .filter((b) => b.type === 'input_text' || b.type === 'output_text')
        .map((b) => b.text)
        .filter((t) => role === 'assistant' || !codexInjected(t))
        .join('\n\n');
      out.push({ role, text, ts: e.timestamp });
    }
    return out;
  },
  // Codex rejects plain text from a Stop hook; an empty JSON object means "no decision".
  hookOutput: (event) => (event === 'Stop' ? '{}' : ''),
};

// --- Pi and OpenCode: messages arrive from their integrations -------------------------------------

const pushed = { sessionEnv: [], findTranscript: () => null, parse: () => [], hookOutput: () => '' };

export const harnesses = { claude, codex, pi: pushed, opencode: pushed };
