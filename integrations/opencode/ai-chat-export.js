// OpenCode plugin for ai-chat-export.
//
// Tells the agent's shell which session it is in (so `ai-chat-export start` can find it), and when
// the session is being saved, sends its messages to ai-chat-export after each prompt and reply.

import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "ai-chat-export");
const BIN = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../bin/ai-chat-export.mjs");

export const AiChatExport = async ({ client, directory }) => {
  async function send(sessionID) {
    if (!sessionID || !existsSync(join(STATE, `opencode--${sessionID}.json`))) return;
    const res = await client.session.messages({ path: { id: sessionID } });
    const messages = (res.data ?? []).map(({ info, parts }) => ({
      role: info.role,
      ts: new Date(info.time?.created ?? Date.now()).toISOString(),
      model: info.modelID,
      text: (parts ?? [])
        .filter((p) => p.type === "text" && !p.synthetic && !p.ignored)
        .map((p) => p.text)
        .join("\n\n"),
    }));
    const child = spawn(BIN, ["hook", "opencode"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    child.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_id: sessionID, cwd: directory, messages }));
    child.unref();
  }

  return {
    "shell.env": async (input, output) => {
      if (!input.sessionID) return;
      output.env.AI_CHAT_HARNESS = "opencode";
      output.env.AI_CHAT_SESSION = input.sessionID;
    },
    event: async ({ event }) => {
      const p = event?.properties ?? {};
      try {
        if (event.type === "session.idle") await send(p.sessionID);
        else if (event.type === "message.updated" && p.info?.role === "user") await send(p.info.sessionID);
      } catch {}
    },
  };
};

export default AiChatExport;
