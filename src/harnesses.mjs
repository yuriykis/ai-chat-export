// Where each agent keeps its conversations and how to read them.
//
// Claude Code and Codex write JSONL transcripts that the hooks point to, so they are parsed here.
// Pi and OpenCode have extension APIs instead: their integrations send the messages themselves,
// already as [{ role, text, ts, model }] plus the working directory, so nothing is parsed for them.

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

// The transcript is a tree: a rewind starts a new branch from an earlier message, and the old one
// stays in the file. After compaction the chain continues through logicalParentUuid.
const parentOf = (e) => e.parentUuid ?? e.logicalParentUuid;

function claudeTree(file) {
  const byId = new Map();
  const kids = new Map();
  let last = null;
  for (const e of readJsonl(file)) {
    if (!e.uuid || e.isSidechain) continue;
    byId.set(e.uuid, e);
    if (e.type === 'user' || e.type === 'assistant') last = e;
  }
  for (const e of byId.values()) {
    const p = parentOf(e);
    if (p) kids.set(p, [...(kids.get(p) ?? []), e]);
  }
  const chainTo = (leaf) => {
    const chain = [];
    const seen = new Set();
    for (let e = leaf; e && !seen.has(e.uuid);) {
      seen.add(e.uuid);
      chain.push(e);
      const p = parentOf(e);
      e = p ? byId.get(p) : null;
    }
    return chain.reverse();
  };
  return { byId, kids, last, chainTo };
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

function claudeMessages(chain) {
  const out = [];
  let cwd = null;
  for (const e of chain) {
    cwd = e.cwd ?? cwd;
    if (e.isMeta || e.isCompactSummary || e.isVisibleInTranscriptOnly || e.isApiErrorMessage) continue;
    const content = e.message?.content;
    // A message typed while the agent is still working is stored as a queued command.
    const queued = e.type === 'attachment' && e.attachment?.type === 'queued_command' && e.attachment.origin?.kind === 'human';
    if (queued) {
      out.push({ role: 'user', text: stripReminders(textBlocks(e.attachment.prompt, ['text'])), ts: e.timestamp, uuid: e.uuid });
    } else if (e.type === 'user') {
      if (Array.isArray(content) && content.some((b) => b.type === 'tool_result')) continue;
      out.push({ role: 'user', text: claudeUserText(textBlocks(content, ['text'])), ts: e.timestamp, uuid: e.uuid });
    } else if (e.type === 'assistant' && e.message?.model !== '<synthetic>') {
      out.push({ role: 'assistant', text: stripReminders(textBlocks(content, ['text'])), ts: e.timestamp, model: e.message?.model, uuid: e.uuid });
    }
  }
  return { messages: out, cwd };
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
    const { last, chainTo } = claudeTree(file);
    return claudeMessages(chainTo(last));
  },
  // Every path through the conversation: the live one first, then each abandoned branch that has
  // a message of the owner's in it, oldest first. `ids` is the whole path from the first entry.
  paths(file) {
    const { kids, last, chainTo } = claudeTree(file);
    const live = chainTo(last);
    const onLive = new Set(live.map((e) => e.uuid));
    const leaves = [];
    for (const e of live) {
      for (const start of kids.get(e.uuid) ?? []) {
        if (onLive.has(start.uuid)) continue;
        const found = [];
        let spoke = false;
        for (const stack = [start]; stack.length;) {
          const x = stack.pop();
          if (x.type === 'user' && claudeMessages([x]).messages[0]?.text) spoke = true;
          const next = kids.get(x.uuid);
          if (next?.length) stack.push(...next);
          else found.push(x);
        }
        if (spoke) leaves.push(...found);
      }
    }
    leaves.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
    return [live, ...leaves.map(chainTo)].map((chain) => ({ ids: chain.map((e) => e.uuid), times: chain.map((e) => e.timestamp), ...claudeMessages(chain) }));
  },
  ids(file) {
    return new Set(claudeTree(file).byId.keys());
  },
  // The first entry of a transcript. A fork (`--fork-session`) copies the conversation with the same
  // ids into a new file, so a shared first entry is how a fork is recognised.
  firstId(file) {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(256 * 1024);
      const text = buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0));
      for (const line of text.split('\n').slice(0, -1)) {
        try { const e = JSON.parse(line); if (e.uuid && !e.isSidechain) return e.uuid; } catch { /* partial line */ }
      }
      return null;
    } finally { fs.closeSync(fd); }
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
    let cwd = null;
    let model = null;
    for (const e of readJsonl(file)) {
      if (e.type === 'session_meta') cwd = e.payload?.cwd ?? cwd;
      if (e.type === 'turn_context') model = e.payload?.model ?? model;
      if (e.type !== 'response_item' || e.payload?.type !== 'message') continue;
      const { role, content = [] } = e.payload;
      if (role !== 'user' && role !== 'assistant') continue;
      const text = content
        .filter((b) => b.type === 'input_text' || b.type === 'output_text')
        .map((b) => b.text)
        .filter((t) => role === 'assistant' || !codexInjected(t))
        .join('\n\n');
      out.push({ role, text, ts: e.timestamp, model: role === 'assistant' ? model : undefined });
    }
    return { messages: out, cwd };
  },
  // Codex rejects plain text from a Stop hook; an empty JSON object means "no decision".
  hookOutput: (event) => (event === 'Stop' ? '{}' : ''),
};

// --- Pi and OpenCode: messages arrive from their integrations -------------------------------------

// `pushed` marks that the messages come only with a hook call; without one there is nothing to read.
const pushed = { pushed: true, sessionEnv: [], findTranscript: () => null, parse: () => ({ messages: [] }), hookOutput: () => '' };

export const harnesses = { claude, codex, pi: pushed, opencode: pushed };
