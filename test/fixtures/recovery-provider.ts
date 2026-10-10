import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { appendFileSync, existsSync, writeFileSync } from "node:fs";
import { setTimeout } from "node:timers/promises";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const FIXTURE_GATE_INTERVAL_MS = 20;

export default function (pi: ExtensionAPI) {
  if (process.env.RECOVERY_SEED_HEAD_STATE === "1") {
    const key = Symbol.for("pi-subagents/running-state");
    Reflect.set(globalThis, key, { agents: new Map(), pendingResumes: new Set() });
  }
  const lifecycleLog = process.env.RECOVERY_LIFECYCLE_LOG;
  if (lifecycleLog) {
    const info = console.info;
    console.info = (...args: unknown[]) => {
      if (Value.Check(Type.String(), args[0]) && args[0].startsWith("[subagents:parent-lifecycle]")) {
        appendFileSync(lifecycleLog, JSON.stringify({ pid: process.pid, event: "detached", message: args[0] }) + "\n");
      }
      info(...args);
    };
    process.on("exit", () => appendFileSync(lifecycleLog, JSON.stringify({ pid: process.pid, event: "exit" }) + "\n"));
  }
  pi.registerCommand("recovery-select", { description: "Select a private fixture branch",
    handler: (id, ctx) => ctx.navigateTree(id, { summarize: false }).then(() => {}) });
  pi.registerCommand("recovery-reload", { description: "Reload this isolated fixture", handler: (_args, ctx) => ctx.reload() });
  pi.registerProvider("recovery-test", {
    api: "openai-responses", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: ["parent", "child"].map((id) => ({
      id, name: id, reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
    })),
    streamSimple(model, context, options) {
      const stream = createAssistantMessageEventStream();
      const last = context.messages.at(-1);
      const text = last?.role === "user"
        ? Value.Check(Type.String(), last.content) ? last.content : last.content.filter((part) => part.type === "text").map((part) => part.text).join("\n")
        : "";
      const message: AssistantMessage = {
        role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      const log = process.env.RECOVERY_PROVIDER_LOG;
      if (!log) throw new Error("Missing fixture provider log");
      appendFileSync(log, JSON.stringify({ model: model.id, pid: process.pid }) + "\n");
      // oxlint-disable-next-line complexity, sonarjs/cognitive-complexity -- One fixture adapter emits variants of parent and child turns for native lifecycle tests.
      void (async () => {
        const gate = model.id === "child" ? process.env.RECOVERY_CHILD_RELEASE : text === "BLOCK" ? process.env.RECOVERY_PARENT_RELEASE : "";
        if (gate) {
          writeFileSync(gate + ".waiting", JSON.stringify({ pid: process.pid, ppid: process.ppid }));
          while (!existsSync(gate) && !options?.signal?.aborted) await setTimeout(FIXTURE_GATE_INTERVAL_MS);
        }
        if (options?.signal?.aborted) {
          message.stopReason = "aborted";
          stream.push({ type: "error", reason: "aborted", error: message });
        } else if (model.id === "parent" && text.startsWith("CALL ")) {
          const separator = text.indexOf(" ", 5);
          message.content = [{ type: "toolCall", id: "fixture-call", name: text.slice(5, separator), arguments: JSON.parse(text.slice(separator + 1)) }];
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else if (model.id === "child" && (text.includes("RECOVERY_EXPLICIT_DONE") || text.includes("RECOVERY_EXPLICIT_PING"))) {
          const ping = text.includes("RECOVERY_EXPLICIT_PING");
          message.content = [{ type: "text", text: "RECOVERY_EXPLICIT_ANSWER" }, {
            type: "toolCall", id: "fixture-child-call", name: ping ? "caller_ping" : "subagent_done",
            arguments: ping ? { message: "RECOVERY_HELP_REQUEST" } : {},
          }];
          message.stopReason = "toolUse";
          stream.push({ type: "done", reason: "toolUse", message });
        } else {
          message.content = model.id === "child" && text.includes("RECOVERY_NO_ANSWER") ? []
            : [{ type: "text", text: model.id === "child" ? "RECOVERY_CHILD_ANSWER" : "RECOVERY_PARENT_READY" }];
          stream.push({ type: "done", reason: "stop", message });
        }
        stream.end();
      })();
      return stream;
    },
  });
}
