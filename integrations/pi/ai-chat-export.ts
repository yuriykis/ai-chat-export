// Pi extension for ai-chat-export.
//
// Tells the agent's shell which session it is in (so `ai-chat-export start` can find it), and when
// the session is being saved, sends the active branch to ai-chat-export after each prompt and reply.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const STATE = join(process.env.XDG_STATE_HOME || join(homedir(), ".local/state"), "ai-chat-export");
const BIN = join(dirname(realpathSync(fileURLToPath(import.meta.url))), "../../bin/ai-chat-export.mjs");

const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.filter((b: any) => b?.type === "text").map((b: any) => b.text ?? "").join("\n\n")
      : "";

export default function (pi: ExtensionAPI) {
  function send(ctx: any, prompt?: string) {
    const sid = ctx.sessionManager.getSessionId();
    if (!existsSync(join(STATE, `pi--${sid}.json`))) return;
    const messages = ctx.sessionManager
      .getBranch()
      .filter((e: any) => e.type === "message" && (e.message?.role === "user" || e.message?.role === "assistant"))
      .map((e: any) => ({ role: e.message.role, text: textOf(e.message.content), ts: e.timestamp }));
    const child = spawn(BIN, ["hook", "pi"], { stdio: ["pipe", "ignore", "ignore"], detached: true });
    child.on("error", () => {});
    child.stdin.end(JSON.stringify({ session_id: sid, messages, prompt }));
    child.unref();
  }

  pi.on("session_start", (_event, ctx) => {
    process.env.AI_CHAT_HARNESS = "pi";
    process.env.AI_CHAT_SESSION = ctx.sessionManager.getSessionId();
  });
  pi.on("before_agent_start", (event, ctx) => send(ctx, event.prompt));
  pi.on("agent_end", (_event, ctx) => send(ctx));
}
