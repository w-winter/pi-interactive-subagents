/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { writeFileSync } from "node:fs";
import { createSubagentActivityRecorder } from "./activity.ts";
import { parseConversationProfile } from "./conversation-profile.ts";
import { installSubagentModelGuard } from "./model-guard.ts";
import { parseLaunchSettings, readLaunchSettings, type LaunchSettings } from "./launch-settings.ts";

// Auto-exit requires Pi's agent_settled event, absent from the pinned SDK typings.
type SubagentExtensionAPI = Pick<ExtensionAPI, "on" | "registerTool" | "registerShortcut" | "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry"> & {
  on(event: "agent_settled", handler: (event: { type: "agent_settled" }, ctx: ExtensionContext) => void): void;
};

export function shouldMarkUserTookOver(agentStarted: boolean): boolean {
  return agentStarted;
}

export function shouldAutoExitOnSettled(
  _userTookOver: boolean,
  messages: any[] | undefined,
): boolean {
  // Manual input should not strand an auto-exit subagent. If the latest agent
  // turn completed normally, close the session. Escape/abort still leaves it
  // open for inspection or another prompt.
  //
  // stopReason: "error" (e.g. exhausted retries on a provider overload) also
  // returns true — we want to shut down so the parent is woken up — but we
  // pair this with findLatestAssistantError() so the parent learns it was an
  // error, not a clean completion.
  if (messages) {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg?.role === "assistant") {
        return msg.stopReason !== "aborted";
      }
    }
  }

  return true;
}

export interface SubagentErrorInfo {
  errorMessage: string;
  stopReason: "error" | "length";
}

type ChildExitSidecarPayload =
  | { type: "done" }
  | { type: "ping"; name: string; message: string }
  | ({ type: "error" } & SubagentErrorInfo)
  | { type: "quit" };

export type ExitSidecarWriteResult = "written" | "exists" | "missing-session" | "write-error";

export function writeExitSidecarIfAbsent(
  sessionFile: string | undefined,
  payload: ChildExitSidecarPayload,
): ExitSidecarWriteResult {
  if (!sessionFile) return "missing-session";
  const exitFile = `${sessionFile}.exit`;
  try {
    writeFileSync(exitFile, JSON.stringify(payload), { flag: "wx" });
    return "written";
  } catch (error) {
    const code = typeof error === "object" && error !== null && "code" in error
      ? (error as { code?: unknown }).code
      : undefined;
    return code === "EEXIST" ? "exists" : "write-error";
  }
}

/** Report provider failures and incomplete output from the latest assistant turn. */
export function findLatestAssistantError(
  messages: any[] | undefined,
): SubagentErrorInfo | null {
  if (!messages) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== "assistant") continue;
    if (msg.stopReason === "length") {
      return {
        errorMessage: "Subagent reached the output token limit; its response is incomplete.",
        stopReason: "length",
      };
    }
    if (msg.stopReason !== "error") return null;
    const raw = typeof msg.errorMessage === "string" ? msg.errorMessage.trim() : "";
    return {
      errorMessage: raw || "Subagent agent loop ended with stopReason=error (no errorMessage field).",
      stopReason: "error",
    };
  }
  return null;
}

export default function (pi: SubagentExtensionAPI) {
  if (process.env.PI_SUBAGENT_SESSION) installSubagentModelGuard();

  let toolNames: string[] = [];
  let denied: string[] = [];
  let expanded = false;

  // Read subagent identity from env vars (set by parent orchestrator)
  const subagentName = process.env.PI_SUBAGENT_NAME ?? "";
  const subagentAgent = process.env.PI_SUBAGENT_AGENT ?? "";
  const launchJson = process.env.PI_SUBAGENT_LAUNCH_SETTINGS;
  const initialLaunch = launchJson ? parseLaunchSettings(launchJson) : null;
  let launchSettings: LaunchSettings | null = null;
  const autoExit = process.env.PI_SUBAGENT_AUTO_EXIT === "1";
  const recorder = createSubagentActivityRecorder({
    runningChildId: process.env.PI_SUBAGENT_ID,
    activityFile: process.env.PI_SUBAGENT_ACTIVITY_FILE,
  });

  function renderWidget(ctx: { ui: { setWidget: Function } }, _theme: any) {
    ctx.ui.setWidget(
      "subagent-tools",
      (_tui: any, theme: any) => {
        const box = new Box(1, 0, (text: string) => theme.bg("toolSuccessBg", text));

        const label = subagentAgent || subagentName;
        const agentTag = label ? theme.bold(theme.fg("accent", `[${label}]`)) : "";

        if (expanded) {
          // Expanded: full tool list + initially disabled tools
          const countInfo = theme.fg("dim", ` — ${toolNames.length} available`);
          const hint = theme.fg("muted", "  (Ctrl+J to collapse)");

          const toolList = toolNames
            .map((name: string) => theme.fg("dim", name))
            .join(theme.fg("muted", ", "));

          let deniedLine = "";
          if (denied.length > 0) {
            const deniedList = denied
              .map((name: string) => theme.fg("error", name))
              .join(theme.fg("muted", ", "));
            deniedLine = "\n" + theme.fg("muted", "initially disabled: ") + deniedList;
          }

          const content = new Text(
            `${agentTag}${countInfo}${hint}\n${toolList}${deniedLine}`,
            0,
            0,
          );
          box.addChild(content);
        } else {
          // Collapsed: one-line summary
          const countInfo = theme.fg("dim", ` — ${toolNames.length} tools`);
          const deniedInfo =
            denied.length > 0
              ? theme.fg("dim", " · ") + theme.fg("error", `${denied.length} initially disabled`)
              : "";
          const hint = theme.fg("muted", "  (Ctrl+J to expand)");

          const content = new Text(`${agentTag}${countInfo}${deniedInfo}${hint}`, 0, 0);
          box.addChild(content);
        }

        return box;
      },
      { placement: "aboveEditor" },
    );
  }

  let userTookOver = false;
  let agentStarted = false;
  let exitSidecarClaimed = false;
  let completedMessages: AgentEndEvent["messages"] = [];

  function claimExitSidecar(
    sessionFile: string | undefined,
    payload: ChildExitSidecarPayload,
  ): ExitSidecarWriteResult {
    const result = writeExitSidecarIfAbsent(sessionFile, payload);
    if (result === "written" || result === "exists") {
      exitSidecarClaimed = true;
    }
    return result;
  }

  // Show widget + status bar on session start
  pi.on("session_start", (_event, ctx) => {
    const profileJson = process.env.PI_SUBAGENT_CONVERSATION_PROFILE;
    if (profileJson) pi.appendEntry("subagent-conversation", parseConversationProfile(profileJson));
    const saved = initialLaunch ? readLaunchSettings(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionId()) : null;
    const settings = saved ?? initialLaunch;
    if (settings) {
      if (!saved) {
        pi.setActiveTools((settings.tools ?? pi.getActiveTools()).filter((name) => !settings.deniedTools.includes(name)));
      }
      launchSettings = { ...settings, cwd: ctx.cwd, tools: pi.getActiveTools() };
      pi.appendEntry("subagent-launch", { ...launchSettings, sessionId: ctx.sessionManager.getSessionId() });
    }
    recorder.sessionStart();
    const tools = pi.getAllTools();
    toolNames = tools.map((t) => t.name).sort();
    denied = launchSettings?.deniedTools.filter((name) => !pi.getActiveTools().includes(name)) ?? [];

    renderWidget(ctx, null);
  });

  pi.on("input", () => {
    recorder.input();
    // Ignore the initial task message that starts an autonomous subagent.
    // Only inputs after the first agent run has started count as user takeover.
    if (!shouldMarkUserTookOver(agentStarted)) return;
    userTookOver = true;
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    agentStarted = true;
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    completedMessages = event.messages;
  });

  pi.on("agent_settled", (_event, ctx) => {
    const shouldExit = autoExit && shouldAutoExitOnSettled(userTookOver, completedMessages);

    if (shouldExit) {
      // The last low-level run may have failed before Pi completed recovery.
      const errorInfo = findLatestAssistantError(completedMessages);
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (errorInfo) {
        claimExitSidecar(sessionFile, {
          type: "error",
          errorMessage: errorInfo.errorMessage,
          stopReason: errorInfo.stopReason,
        });
      } else {
        claimExitSidecar(sessionFile, { type: "done" });
      }

      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
    if (autoExit) {
      // Reset any recorded manual input marker. Auto-exit is decided by whether
      // the latest agent turn completed normally, not by who initiated it.
      userTookOver = false;
    }
  });

  pi.on("turn_start", (event) => {
    recorder.turnStart((event as any).turnIndex);
  });

  pi.on("turn_end", (event) => {
    recorder.turnEnd((event as any).turnIndex);
  });

  pi.on("before_provider_request", () => {
    recorder.beforeProviderRequest();
  });

  pi.on("after_provider_response", () => {
    recorder.afterProviderResponse();
  });

  pi.on("message_update", (event) => {
    recorder.messageUpdate((event as any).assistantMessageEvent?.type);
  });

  pi.on("tool_execution_start", (event) => {
    recorder.toolExecutionStart((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_call", (event) => {
    recorder.toolCall((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_update", (event) => {
    recorder.toolExecutionUpdate((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_result", (event) => {
    recorder.toolResult((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("tool_execution_end", (event) => {
    recorder.toolExecutionEnd((event as any).toolCallId, (event as any).toolName);
  });

  pi.on("session_shutdown", (event, ctx) => {
    if (launchSettings) {
      pi.appendEntry("subagent-launch", {
        ...launchSettings, tools: pi.getActiveTools(), sessionId: ctx.sessionManager.getSessionId(),
      });
    }
    const reason = (event as any).reason;
    recorder.sessionShutdown(reason);

    if (reason === "quit" && !exitSidecarClaimed) {
      claimExitSidecar(process.env.PI_SUBAGENT_SESSION, { type: "quit" });
    }
  });

  // Toggle expand/collapse with Ctrl+J
  pi.registerShortcut("ctrl+j", {
    description: "Toggle subagent tools widget",
    handler: (ctx) => {
      expanded = !expanded;
      renderWidget(ctx, null);
    },
  });

  pi.registerTool({
    name: "caller_ping",
    label: "Caller Ping",
    description:
      "Send a help request to the parent agent and exit this session. " +
      "The parent will be notified with your message and can resume this session with a response. " +
      "Use when you're stuck, need clarification, or need the parent to take action.",
    parameters: Type.Object({
      message: Type.String({ description: "What you need help with" }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      if (!sessionFile) {
        throw new Error(
          "caller_ping is only available in subagent contexts. " +
            "PI_SUBAGENT_SESSION environment variable is not set.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      claimExitSidecar(sessionFile, exitData);

      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Ping sent. Session will exit and parent will be notified." }],
        details: {},
      };
    },
  });

  pi.registerTool({
    name: "subagent_done",
    label: "Subagent Done",
    description:
      "Close this session and return your results to the main session. " +
      "Your LAST assistant message before calling this becomes the summary returned to the caller.",
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      const sessionFile = process.env.PI_SUBAGENT_SESSION;
      recorder.subagentDone();
      claimExitSidecar(sessionFile, { type: "done" });
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
