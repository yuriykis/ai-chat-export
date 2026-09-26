---
name: save-chat
description: Save this conversation to the Obsidian vault as a note that keeps updating with every new message. Use when the user asks to save, record or keep this chat/conversation (e.g. "zapisz tę rozmowę", "save this chat"), or asks to stop saving it.
---

# Save chat

Run exactly one command with your shell tool, then reply with one short sentence based on its output. Do nothing else.

- Start saving: `ai-chat-export start --harness <agent> --title "<title>"`
- Stop saving (only when the user asks to stop): `ai-chat-export stop --harness <agent>`

`<agent>` is the coding agent you are running in: `claude` (Claude Code), `codex` (Codex CLI), `pi` or `opencode`.

Title: if the user gave one, use it verbatim. Otherwise write a short descriptive title (3–7 words) in the language of the conversation that says what the conversation is about. If there is nothing to summarise yet, leave out `--title`.

The command writes into the Obsidian vault, outside the working directory. If a sandbox blocks it, rerun it with the permissions needed to write there.

After it starts, every message is added to the note automatically. Never write to the note yourself.
