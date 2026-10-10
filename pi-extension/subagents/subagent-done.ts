/**
 * Extension loaded into sub-agents.
 * - Shows agent identity + available tools as a styled widget above the editor (toggle with Ctrl+J)
 * - Provides a `subagent_done` tool for autonomous agents to self-terminate
 */
import type { AgentEndEvent, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { Box, Text } from "@mariozechner/pi-tui";
import { Type } from "@sinclair/typebox";
import { existsSync } from "node:fs";
import { publishOutcome, readRunContext, type RunOutcome, type RunContext } from "./run-records.ts";
import { findLastAssistantMessage, getBranchEntries, findLatestAssistantError, type SubagentErrorInfo } from "./session.ts";
import { createSubagentActivityRecorder, type SubagentUIPromptKind } from "./activity.ts";
import { parseConversationProfile } from "./conversation-profile.ts";
import { installSubagentModelGuard } from "./model-guard.ts";
import { parseLaunchSettings, readLaunchSettings, type LaunchSettings } from "./launch-settings.ts";

// Pi 1.1 lifecycle events are absent from the pinned SDK typings.
type SubagentExtensionAPI = Pick<ExtensionAPI, "on" | "registerTool" | "registerShortcut" | "getAllTools" | "getActiveTools" | "setActiveTools" | "appendEntry"> & {
  on(event: "ui_prompt_start", handler: (event: { type: "ui_prompt_start"; kind: SubagentUIPromptKind; title?: string }, ctx: ExtensionContext) => void): void;
  on(event: "ui_prompt_end", handler: (event: { type: "ui_prompt_end" }, ctx: ExtensionContext) => void): void;
  on(event: "agent_settled", handler: (event: { type: "agent_settled"; aborted: boolean }, ctx: ExtensionContext) => void): void;
};

type ChildExitSidecarPayload =
  | { type: "done" }
  | { type: "ping"; name: string; message: string }
  | ({ type: "error" } & SubagentErrorInfo)
  | { type: "quit" };

export default function (pi: SubagentExtensionAPI) {
  const managed = readRunContext();
  if (managed && managed.cli !== "pi") throw new Error("Pi child extension requires a Pi run context");
  const context = managed;
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

  let outcomeClaimed = false;
  let completedMessages: AgentEndEvent["messages"] = [];

  function claimExit(context: Extract<RunContext, { cli: "pi" }>, payload: ChildExitSidecarPayload): Error | null {
    try {
      const { id, sessionFile } = context;
      const common = { id, recordedAt: Date.now() };
      let outcome: RunOutcome;
      if (payload.type === "ping") outcome = { ...common, reason: "ping", name: payload.name, message: payload.message };
      else if (payload.type === "error") outcome = { ...common, reason: "error", errorMessage: payload.errorMessage, stopReason: payload.stopReason };
      else outcome = { ...common, reason: payload.type,
        output: { cli: "pi", text: findLastAssistantMessage(existsSync(sessionFile) ? getBranchEntries(sessionFile, context.outputAfter) : []) } };
      publishOutcome({ id, runDir: context.runDir }, outcome);
      outcomeClaimed = true;
      return null;
    } catch (error) {
      return error instanceof Error ? error : new Error(String(error));
    }
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
  });

  pi.on("before_agent_start", () => {
    recorder.beforeAgentStart();
  });

  pi.on("agent_start", () => {
    recorder.agentStart();
  });

  pi.on("agent_end", (event) => {
    completedMessages = event.messages;
  });

  pi.on("agent_settled", (event, ctx) => {
    const shouldExit = context && autoExit && !event.aborted;

    if (shouldExit) {
      // The last low-level run may have failed before Pi completed recovery.
      const errorInfo = findLatestAssistantError(completedMessages);
      const failure = claimExit(context, errorInfo ? {
        type: "error",
        errorMessage: errorInfo.errorMessage,
        stopReason: errorInfo.stopReason,
      } : { type: "done" });
      if (failure) {
        console.error(`[subagents:completion-file] ${JSON.stringify({ event: "publication_failed", id: process.env.PI_SUBAGENT_ID, error: failure.name })}`);
        recorder.agentEndWaiting();
        return;
      }
      recorder.agentEndDone();
      ctx.shutdown();
      return;
    }

    recorder.agentEndWaiting();
  });

  pi.on("ui_prompt_start", (event) => {
    recorder.uiPromptStart(event.kind, event.title);
  });

  pi.on("ui_prompt_end", () => {
    recorder.uiPromptEnd();
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

    if (context && reason === "quit" && !outcomeClaimed) {
      const failure = claimExit(context, { type: "quit" });
      if (failure) console.error(`[subagents:completion-file] ${JSON.stringify({ event: "quit_publication_failed", error: failure.name })}`);
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
      if (!context) {
        throw new Error(
          "caller_ping requires a managed subagent session.",
        );
      }

      recorder.callerPing();
      const exitData = {
        type: "ping" as const,
        name: process.env.PI_SUBAGENT_NAME ?? "subagent",
        message: params.message,
      };
      const failure = claimExit(context, exitData);
      if (failure) throw failure;

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
      if (!context) throw new Error("subagent_done requires a managed subagent session");
      recorder.subagentDone();
      const failure = claimExit(context, { type: "done" });
      if (failure) throw failure;
      ctx.shutdown();
      return {
        content: [{ type: "text", text: "Shutting down subagent session." }],
        details: {},
      };
    },
  });
}
