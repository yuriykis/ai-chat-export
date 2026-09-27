---
name: save-chat
description: Save this conversation to the Obsidian vault as a note that keeps updating with every new message. Use when the user asks to save, record or keep this chat/conversation (e.g. "zapisz tę rozmowę", "save this chat"), or asks to stop saving it.
---

# Save chat

Run the command below with your shell tool, then reply with one short sentence based on its output. Do nothing else.

- Start saving: `ai-chat-export start --harness <agent> --title "<title>"`. If the user said which project the conversation belongs to, add `--project "<project>"`.
- Stop saving (only when the user asks to stop): `ai-chat-export stop --harness <agent>`

`<agent>` is the coding agent you are running in: `claude` (Claude Code), `codex` (Codex CLI), `pi` or `opencode`.

Title: if the user gave one, use it verbatim. Otherwise write a short descriptive title (3–7 words) in the language of the conversation that says what the conversation is about. If there is nothing to summarise yet, leave out `--title`.

## Project

If the output of `start` says no project is set, ask the user which project the conversation belongs to. Never choose one yourself, not even the first suggestion.

- In Claude Code, ask with the AskUserQuestion tool: one option per suggested project (label: the project name, description: why it is suggested), then a "No project" option. The user types any other project as "Other".
- In other agents, ask in one short sentence that lists the suggestions and says they can also name another project or none. Then wait for the answer.

Then run one more command:

- a project: `ai-chat-export project --harness <agent> "<project>"`
- no project: `ai-chat-export project --harness <agent> --none`

If `project` says there is no such project, show the user the list it prints and ask again. Reply with one short sentence.

## Notes

The commands write into the Obsidian vault, outside the working directory. If a sandbox blocks them, rerun them with the permissions needed to write there.

After saving starts, every message is added to the note automatically. Never write to the note yourself.
