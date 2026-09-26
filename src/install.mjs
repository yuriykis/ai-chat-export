// Wires ai-chat-export into every agent found on this machine, and takes it out again.
// Everything is idempotent: running install twice changes nothing the second time.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HOME = os.homedir();
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BIN = path.join(REPO, 'bin/ai-chat-export.mjs');
const CONFIG_FILE = path.join(process.env.XDG_CONFIG_HOME || path.join(HOME, '.config'), 'ai-chat-export/config.json');

const exists = (p) => fs.existsSync(p);
const tilde = (p) => p.replace(HOME, '~');

function link(target, linkPath, log) {
  fs.mkdirSync(path.dirname(linkPath), { recursive: true });
  try {
    if (fs.readlinkSync(linkPath) === target) return;
    fs.rmSync(linkPath);
  } catch (err) {
    if (err.code !== 'ENOENT') throw new Error(`${tilde(linkPath)} exists and is not a link — remove it first.`);
  }
  fs.symlinkSync(target, linkPath);
  log.push(`linked ${tilde(linkPath)}`);
}

function unlink(linkPath, log) {
  try {
    if (!fs.readlinkSync(linkPath).startsWith(REPO)) return;
    fs.rmSync(linkPath);
    log.push(`removed ${tilde(linkPath)}`);
  } catch { /* not ours or not there */ }
}

// Claude Code (~/.claude/settings.json) and Codex (~/.codex/hooks.json) share the same hooks shape.
// New entries are appended, never inserted: Codex remembers which hooks you trusted by their position.
function editHooks(file, harness, add, log) {
  if (!exists(file)) {
    if (!add) return;
    fs.writeFileSync(file, '{}\n');
  }
  const json = JSON.parse(fs.readFileSync(file, 'utf8') || '{}');
  json.hooks ??= {};
  const ours = (group) => group.hooks?.some((h) => h.command?.includes(BIN));
  let changed = false;
  for (const event of ['UserPromptSubmit', 'Stop']) {
    const groups = json.hooks[event] ?? [];
    if (add && !groups.some(ours)) {
      groups.push({ hooks: [{ type: 'command', command: `"${BIN}" hook ${harness}`, timeout: 10 }] });
      changed = true;
    }
    if (!add && groups.some(ours)) {
      groups.splice(0, groups.length, ...groups.filter((g) => !ours(g)));
      changed = true;
    }
    if (groups.length) json.hooks[event] = groups;
    else delete json.hooks[event];
  }
  if (!changed) return;
  fs.copyFileSync(file, `${file}.bak`);
  fs.writeFileSync(file, `${JSON.stringify(json, null, 2)}\n`);
  log.push(`${add ? 'added hooks to' : 'removed hooks from'} ${tilde(file)} (backup: ${tilde(file)}.bak)`);
}

const targets = () => [
  { name: 'Claude Code', dir: path.join(HOME, '.claude'), skills: path.join(HOME, '.claude/skills'), hooks: path.join(HOME, '.claude/settings.json'), harness: 'claude' },
  { name: 'Codex', dir: path.join(HOME, '.codex'), hooks: path.join(HOME, '.codex/hooks.json'), harness: 'codex' },
  { name: 'Pi', dir: path.join(HOME, '.pi/agent'), extension: path.join(HOME, '.pi/agent/extensions/ai-chat-export.ts'), source: 'integrations/pi/ai-chat-export.ts' },
  { name: 'OpenCode', dir: path.join(HOME, '.config/opencode'), extension: path.join(HOME, '.config/opencode/plugins/ai-chat-export.js'), source: 'integrations/opencode/ai-chat-export.js' },
];

export function install({ vault, folder }) {
  const log = [];
  if (!exists(CONFIG_FILE)) {
    if (!vault) throw new Error('First install needs --vault <path to your Obsidian vault>.');
    fs.mkdirSync(path.dirname(CONFIG_FILE), { recursive: true });
    const example = JSON.parse(fs.readFileSync(path.join(REPO, 'config.example.json'), 'utf8'));
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify({ ...example, vault: path.resolve(vault), ...(folder && { folder }) }, null, 2)}\n`);
    log.push(`wrote ${tilde(CONFIG_FILE)}`);
  }
  fs.chmodSync(BIN, 0o755);
  link(BIN, path.join(HOME, '.local/bin/ai-chat-export'), log);
  // One skill for all agents: ~/.agents/skills is read by Codex, Pi and OpenCode; Claude Code needs its own.
  link(path.join(REPO, 'skills/save-chat'), path.join(HOME, '.agents/skills/save-chat'), log);
  for (const t of targets()) {
    if (!exists(t.dir)) continue;
    if (t.skills) link(path.join(REPO, 'skills/save-chat'), path.join(t.skills, 'save-chat'), log);
    if (t.hooks) editHooks(t.hooks, t.harness, true, log);
    if (t.extension) link(path.join(REPO, t.source), t.extension, log);
  }
  return log;
}

export function uninstall() {
  const log = [];
  unlink(path.join(HOME, '.local/bin/ai-chat-export'), log);
  unlink(path.join(HOME, '.agents/skills/save-chat'), log);
  for (const t of targets()) {
    if (t.skills) unlink(path.join(t.skills, 'save-chat'), log);
    if (t.hooks) editHooks(t.hooks, t.harness, false, log);
    if (t.extension) unlink(t.extension, log);
  }
  return log;
}
