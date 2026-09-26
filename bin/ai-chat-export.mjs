#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { hook, start, stop, STATE_DIR } from '../src/core.mjs';
import { install, uninstall } from '../src/install.mjs';

const USAGE = `ai-chat-export — save a conversation with a coding agent to Obsidian, live.

  ai-chat-export start [--harness claude|codex|pi|opencode] [--session ID] [--title TITLE]
  ai-chat-export stop  [--harness ...] [--session ID]
  ai-chat-export hook <harness>          (reads the agent's hook JSON on stdin)
  ai-chat-export install [--vault PATH] [--folder NAME]
  ai-chat-export uninstall`;

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) opts[a.slice(2)] = argv[i + 1]?.startsWith('--') ? true : argv[++i];
    else opts._.push(a);
  }
  return opts;
}

const [cmd, ...rest] = process.argv.slice(2);
const opts = parseArgs(rest);

try {
  if (cmd === 'hook') {
    // A hook must never break the agent: errors go to a log, never to the agent.
    let input = {};
    try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* no payload */ }
    const out = hook(opts._[0], input);
    if (out) process.stdout.write(out);
  } else if (cmd === 'start') console.log(start(opts));
  else if (cmd === 'stop') console.log(stop(opts));
  else if (cmd === 'install') console.log(install(opts).join('\n') || 'Already installed.');
  else if (cmd === 'uninstall') console.log(uninstall().join('\n') || 'Nothing to remove.');
  else console.log(USAGE);
} catch (err) {
  if (cmd === 'hook') {
    fs.mkdirSync(STATE_DIR, { recursive: true });
    fs.appendFileSync(path.join(STATE_DIR, 'errors.log'), `${new Date().toISOString()} hook ${opts._[0]}: ${err.stack}\n`);
  } else {
    console.error(`ai-chat-export: ${err.message}`);
    process.exitCode = 1;
  }
}
