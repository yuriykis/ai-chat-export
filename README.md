# ai-chat-export

Save a conversation with a coding agent to your Obsidian vault as a Markdown note. The note is updated live, message by message.

Recording starts only when you ask for it. In any supported agent, say *"save this chat"* (or invoke the `save-chat` skill). From then on every message you send and every text reply is written to a note in your vault as it happens. Tool calls, thinking and system messages are left out.

Supported agents: **Claude Code**, **Codex CLI**, **Pi**, **OpenCode**.

## How it works

| Piece | What it does |
|---|---|
| `save-chat` skill | Tells the agent to run `ai-chat-export start --harness <agent> --title "…"` when you ask to save the chat, with a title it writes itself. |
| `ai-chat-export start` | Finds the current session (from the agent's session id in the environment), creates a marker for it and writes the note with everything said so far. |
| Claude Code / Codex hooks | `UserPromptSubmit` and `Stop` run `ai-chat-export hook <agent>`. If the session is being recorded, the note is rebuilt from the agent's own transcript. |
| Pi extension / OpenCode plugin | Do the same through the agents' extension APIs. They also export the session id to the agent's shell. |

The note body is rebuilt from the agent's record on every update, so rewinds and compaction never leave stale text behind. The frontmatter is written once; after that only `modified` changes, so properties you add by hand survive.

The text is made safe for the vault: `- [ ]` is escaped so it does not become a task, `#word` so it does not become a tag, and headings inside messages are demoted. Code blocks stay verbatim.

If you rename or move the note inside the folder, it is found again by its `session` property. If you delete it, recording stops and the note is not recreated.

## Install

Requires Node.js 20+.

```sh
git clone https://github.com/yuriykis/ai-chat-export ~/Projects/ai-chat-export
~/Projects/ai-chat-export/bin/ai-chat-export.mjs install --vault "/path/to/vault" --folder "AI Chats"
```

`install` is idempotent and only touches agents it finds:

- links `ai-chat-export` into `~/.local/bin`,
- links the skill into `~/.agents/skills` (read by Codex, Pi and OpenCode) and `~/.claude/skills`,
- appends hooks to `~/.claude/settings.json` and `~/.codex/hooks.json`, keeping a `.bak` of each,
- links the Pi extension into `~/.pi/agent/extensions` and the OpenCode plugin into `~/.config/opencode/plugins`.

**Codex only runs hooks you have trusted.** After installing, open Codex, run `/hooks` and trust the two `ai-chat-export` hooks. Until you do, Codex writes the note once at `start` and never updates it.

`ai-chat-export uninstall` removes everything `install` added. Your config and notes are kept.

## Configure

`~/.config/ai-chat-export/config.json`:

```json
{
  "vault": "/path/to/vault",
  "folder": "AI Chats",
  "defaultTitle": "Chat",
  "frontmatter": { "category": "[[AI Chats]]", "related": null },
  "projects": { "fromActiveNote": true, "category": "[[Projects]]" }
}
```

- `frontmatter` holds extra properties written into every new note; `null` writes an empty property.
- `projects.fromActiveNote` only applies to sessions started inside the vault. When it is on, `projects` is filled from the note open in Obsidian: that note itself if its `category` is `projects.category`, otherwise the projects it links in `projects`.

## Commands

```
ai-chat-export start [--harness claude|codex|pi|opencode] [--session ID] [--title TITLE]
ai-chat-export stop  [--harness …] [--session ID]
ai-chat-export hook <harness>        # used by the integrations; reads hook JSON on stdin
ai-chat-export install [--vault PATH] [--folder NAME]
ai-chat-export uninstall
```

State (one marker file per recorded session) lives in `~/.local/state/ai-chat-export/`. Hook errors are written to `errors.log` there and never reach the agent.

## Limits

- The Claude Code and Codex transcript formats are internal to those tools. If an update changes them, the parser in `src/harnesses.mjs` needs adjusting.
- Codex rollbacks are not followed yet: messages you undo in Codex stay in the note.
- Starting a recording in Codex needs write access outside the workspace. Under Codex's sandbox the agent has to ask for it.

## License

MIT
