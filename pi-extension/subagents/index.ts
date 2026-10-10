import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { keyHint, SessionManager } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { Box, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  copyFileSync,
  realpathSync,
} from "node:fs";
import { homedir } from "node:os";
import {
  AgentDefinitionError,
  discoverAgentDefinitions as discoverActiveAgentDefinitions,
  loadAgentDefaults as loadActiveAgentDefaults,
  type AgentDefaults,
  type ListedAgentDefinition,
  type SubagentSessionMode,
} from "./agent-definitions.ts";
import { buildModelArgs, buildResumeArgs, conversationArgs, readConversationProfile, type ConversationProfile } from "./conversation-profile.ts";
import { buildRunCommand } from "./launch-command.ts";
import { ParentRunObserver } from "./recovery.ts";
import { cancelUnstarted, decodeRun, type RunRecord, type RunOutcome } from "./run-records.ts";
import { isTabClosed } from "./orca.ts";
import {
  isMuxAvailable,
  muxSetupHint,
  createSurface,
  writeCommandScript,
  sendCommand,
  closeSurface,
  getMuxBackend,
  sendEscape,
  shellEscape,
} from "./mux.ts";

import {
  getNewEntries,
  seedSubagentSessionFile,
} from "./session.ts";
import { launchPromptArgs, readLaunchSettings, requireLaunchResources, type LaunchSettings } from "./launch-settings.ts";
import {
  type StatusSnapshot,
  type SubagentStatusState,
  advanceStatusState,
  capStatusLines,
  classifyStatus,
  createStatusState,
  forceStatusAfterInterrupt,
  formatStatusAggregate,
  formatTransitionLine,
  observeStatus,
  loadStatusConfig,
} from "./status.ts";
import {
  getSubagentActivityFile,
  readSubagentActivityFile,
  type ActivityReadResult,
  type SubagentActivityState,
} from "./activity.ts";

/** Absolute path to `pi-extension/subagents`. https://github.com/nodejs/node/issues/37845 */
const SUBAGENTS_DIR = dirname(fileURLToPath(import.meta.url));

// Reload replaces observers, while child processes and their tracking survive.
const WIDGET_INTERVAL_KEY = Symbol.for("pi-subagents/widget-interval");
const STATUS_INTERVAL_KEY = Symbol.for("pi-subagents/status-interval");

{
  const prevInterval = (globalThis as any)[WIDGET_INTERVAL_KEY];
  if (prevInterval) {
    clearInterval(prevInterval);
    (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
  }
  const prevStatusInterval = (globalThis as any)[STATUS_INTERVAL_KEY];
  if (prevStatusInterval) {
    clearInterval(prevStatusInterval);
    (globalThis as any)[STATUS_INTERVAL_KEY] = null;
  }
}

const ShutdownEvent = Type.Object({ reason: Type.Union([
  Type.Literal("reload"), Type.Literal("quit"), Type.Literal("new"),
  Type.Literal("resume"), Type.Literal("fork"),
]) });

const SubagentParams = Type.Object({
  name: Type.String({ description: "Display name for the subagent" }),
  task: Type.String({ description: "Task/prompt for the sub-agent" }),
  inputFiles: Type.Optional(Type.Array(Type.String({ description: "Absolute path to a file attached in full to the child's initial prompt" }))),
  agent: Type.Optional(
    Type.String({
      description:
        "Exact canonical name of a definition marked extension: pi-interactive-subagents in .pi/agents/ or the global agent directory. Unavailable names fail before launch. Omit agent for a bare launch.",
    }),
  ),
  systemPrompt: Type.Optional(
    Type.String({ description: "Appended to system prompt (role instructions)" }),
  ),
  model: Type.Optional(Type.String({ description: "Model override (overrides agent default)" })),
  thinking: Type.Optional(Type.String({ description: "Thinking level override (overrides agent default, including off)" })),
  skills: Type.Optional(
    Type.String({ description: "Comma-separated skills (overrides agent default)" }),
  ),
  tools: Type.Optional(
    Type.String({ description: "Comma-separated initial tools for Pi-backed sessions (overrides agent default)" }),
  ),
  cwd: Type.Optional(
    Type.String({
      description:
        "Working directory for the sub-agent. The agent starts in this folder and picks up its local .pi/ config, CLAUDE.md, skills, and extensions. Use for role-specific subfolders.",
    }),
  ),
  fork: Type.Optional(
    Type.Boolean({
      description:
        "Force the full-context fork mode for this spawn. The sub-agent inherits the current session conversation, overriding any agent frontmatter session-mode.",
    }),
  ),
  autoExit: Type.Optional(
    Type.Boolean({
      description:
        "Set true to close the child and return its result after the final response, including any automatic retries and queued follow-ups. False leaves it open after replying. Defaults to the selected definition's auto-exit setting, or false if absent. Interrupted turns stay open. Not supported for definitions with cli: claude.",
    }),
  ),
  interactive: Type.Optional(
    Type.Boolean({
      description:
        "When true, suppress notifications about missing or restored activity updates from the child. Does not control exit or result delivery. Defaults to the selected definition's interactive setting, otherwise the opposite of autoExit.",
    }),
  ),
  resumeSessionId: Type.Optional(
    Type.String({
      description:
        "Resume a previous Claude Code session by its ID. Loads the conversation history and continues where it left off. The session ID is returned in details of every claude tool call. Use this to retry cancelled runs or ask follow-up questions.",
    }),
  ),
});

/** Tools that are gated by `spawning: false` */
const SPAWNING_TOOLS = new Set([
  "subagent",
  "subagent_interrupt",
  "subagents_list",
  "subagent_resume",
]);

/**
 * Resolve the effective set of denied tool names from agent defaults.
 * `spawning: false` expands to all SPAWNING_TOOLS.
 * `deny-tools` adds individual tool names on top.
 */
function resolveDenyTools(agentDefs: AgentDefaults | null): Set<string> {
  const denied = new Set<string>();
  if (!agentDefs) return denied;

  // spawning: false → deny all spawning tools
  if (agentDefs.spawning === false) {
    for (const t of SPAWNING_TOOLS) denied.add(t);
  }

  // deny-tools: explicit list
  if (agentDefs.denyTools) {
    for (const t of agentDefs.denyTools
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean)) {
      denied.add(t);
    }
  }

  return denied;
}

/** Resolve the global agent config directory, respecting PI_CODING_AGENT_DIR. */
function getAgentConfigDir(): string {
  return process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".pi", "agent");
}

function discoverAgentDefinitions(): ListedAgentDefinition[] {
  return discoverActiveAgentDefinitions(getAgentConfigDir(), process.cwd());
}

function logAgentDefinitionError(operation: string, error: AgentDefinitionError): void {
  console.warn("[subagents:agent-definitions]", JSON.stringify({ operation, diagnostic: error.message }));
}

function resolveSubagentPaths(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): { effectiveCwd: string | null; localAgentDir: string | null; effectiveAgentDir: string } {
  const rawCwd = params.cwd ?? agentDefs?.cwd ?? null;
  const cwdIsFromAgent = !params.cwd && agentDefs?.cwd != null;
  const cwdBase = cwdIsFromAgent ? getAgentConfigDir() : process.cwd();
  const effectiveCwd = rawCwd
    ? rawCwd.startsWith("/")
      ? rawCwd
      : join(cwdBase, rawCwd)
    : null;
  const localAgentDir = effectiveCwd ? join(effectiveCwd, ".pi", "agent") : null;
  const effectiveAgentDir =
    localAgentDir && existsSync(localAgentDir) ? localAgentDir : getAgentConfigDir();
  return { effectiveCwd, localAgentDir, effectiveAgentDir };
}

function getDefaultSessionDirFor(cwd: string, agentDir: string): string {
  const safePath = `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  const sessionDir = join(agentDir, "sessions", safePath);
  if (!existsSync(sessionDir)) {
    mkdirSync(sessionDir, { recursive: true });
  }
  return sessionDir;
}

function resolveEffectiveSessionMode(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): SubagentSessionMode {
  if (params.fork) return "fork";
  return agentDefs?.sessionMode ?? "standalone";
}

function resolveLaunchBehavior(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): {
  sessionMode: SubagentSessionMode;
  seededSessionMode: "lineage-only" | "fork" | null;
  inheritsConversationContext: boolean;
  taskDelivery: "direct" | "artifact";
} {
  const sessionMode = resolveEffectiveSessionMode(params, agentDefs);
  const inheritsConversationContext = sessionMode === "fork";
  return {
    sessionMode,
    seededSessionMode: sessionMode === "standalone" ? null : sessionMode,
    inheritsConversationContext,
    taskDelivery: inheritsConversationContext ? "direct" : "artifact",
  };
}

function resolveEffectiveAutoExit(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  return params.autoExit ?? agentDefs?.autoExit ?? false;
}

// Explicit notification settings take precedence over the effective exit policy.
function resolveEffectiveInteractive(
  params: Static<typeof SubagentParams>,
  agentDefs: AgentDefaults | null,
): boolean {
  if (params.interactive != null) return params.interactive;
  if (agentDefs?.interactive != null) return agentDefs.interactive;
  return !resolveEffectiveAutoExit(params, agentDefs);
}

function loadAgentDefaults(agentName: string): ListedAgentDefinition {
  return loadActiveAgentDefaults(agentName, getAgentConfigDir(), process.cwd());
}

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m ${s}s`;
}

/**
 * Wait long enough for a freshly created pane to finish shell startup.
 *
 * Some environments do extra shell-init work before the prompt is ready
 * (for example direnv/devenv), so the delay is configurable for users who hit
 * dropped commands. Keep the historical default at 500ms.
 */
function getShellReadyDelayMs(): number {
  const raw = process.env.PI_SUBAGENT_SHELL_READY_DELAY_MS?.trim();
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : 500;
}

function muxUnavailableResult() {
  return {
    content: [
      {
        type: "text" as const,
        text: `Subagents require a supported terminal multiplexer. ${muxSetupHint()}`,
      },
    ],
    details: { error: "mux not available" },
  };
}

/**
 * Build the internal artifact directory path for the current session.
 * Used by the subagents extension to stash task files, system prompts, and
 * launch scripts for sub-agents. Path convention:
 *   <sessionDir>/artifacts/<session-id>/
 */
function getArtifactDir(sessionDir: string, sessionId: string): string {
  return join(sessionDir, "artifacts", sessionId);
}

const statusConfig = loadStatusConfig();

function formatWidgetRightLabel(snapshot: StatusSnapshot): string {
  if (snapshot.kind === "starting") return " starting… ";
  if (snapshot.kind === "running") return ` running ${snapshot.elapsedText} `;
  if (snapshot.kind === "active") {
    const label = snapshot.activityLabel ?? snapshot.activeScope;
    const duration = snapshot.activeDurationText ? ` ${snapshot.activeDurationText}` : "";
    return label ? ` active · ${label}${duration} ` : " active ";
  }
  if (snapshot.kind === "blocked") {
    const detail = snapshot.activityLabel ? ` · ${snapshot.activityLabel}` : "";
    return ` blocked${detail} `;
  }
  if (snapshot.kind === "waiting") {
    const duration = snapshot.waitingDurationText ? ` ${snapshot.waitingDurationText}` : "";
    const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
    return ` waiting${duration}${detail} `;
  }

  const detail = snapshot.statusLabel ? ` · ${snapshot.statusLabel}` : "";
  const duration = snapshot.snapshotProblemText ? ` ${snapshot.snapshotProblemText}` : "";
  return ` stalled${detail}${duration} `;
}

function resolveResultPresentation(
  result: { exitCode: number; elapsed: number; summary: string; sessionFile?: string; errorMessage?: string; exitReason?: RunOutcome["reason"] },
  name: string,
): string {
  const sessionRef = result.sessionFile
    ? `\n\nSession: ${result.sessionFile}\nResume: pi --session ${result.sessionFile}`
    : "";

  if (result.exitReason === "quit") {
    return (
      `Sub-agent "${name}" closed by user (${formatElapsed(result.elapsed)}).\n\n` +
      `${result.summary}${sessionRef}`
    );
  }

  if (result.errorMessage) {
    // Partial output must not be presented as a completed result.
    return (
      `Sub-agent "${name}" failed after ${formatElapsed(result.elapsed)} ` +
      `(provider/agent error).\n\n` +
      `Error: ${result.errorMessage}\n\n` +
      `The subagent did not produce a complete result. You can retry by spawning a new ` +
      `subagent or resume the session with subagent_resume.${sessionRef}`
    );
  }

  return result.exitCode !== 0
    ? `Sub-agent "${name}" failed (exit code ${result.exitCode}).\n\n${result.summary}${sessionRef}`
    : `Sub-agent "${name}" completed (${formatElapsed(result.elapsed)}).\n\n${result.summary}${sessionRef}`;
}

/**
 * State for a launched (but not yet completed) subagent.
 */
interface RunningSubagentBase {
  record: RunRecord;
  statusState: SubagentStatusState;
  activity?: SubagentActivityState;
  activityRead?: { ok: boolean; reason?: "missing" | "invalid" | "wrong-id"; error?: string };
}

type RunningSubagent = RunningSubagentBase & (
  | { control: "current"; surface: string; launchScriptFile: string }
  | { control: "recovered" }
);

function trackRun<C extends { control: "current"; surface: string; launchScriptFile: string } | { control: "recovered" }>(record: RunRecord, control: C): RunningSubagentBase & C {
  const base: RunningSubagentBase = { record, statusState: createStatusState({
    source: record.launch.kind === "claude" ? "claude" : "pi", startTimeMs: record.startTime,
  }) };
  return { ...control, ...base };
}

const RUNNING_STATE_KEY = Symbol.for("pi-subagents/recovery-state");
interface RunningState {
  agents: Map<string, RunningSubagent>;
  pendingResumes: Set<string>;
  records: Map<string, RunRecord>;
  submitted: Set<string>;
  owner: RunRecord["owner"] | null;
}
// SAFETY: This module exclusively initializes and accesses this process-local symbol.
const runtimeGlobal = globalThis as typeof globalThis & { [RUNNING_STATE_KEY]?: RunningState };
const runningState = runtimeGlobal[RUNNING_STATE_KEY] ??= { agents: new Map(), pendingResumes: new Set(), records: new Map(), submitted: new Set(), owner: null };
/** All currently running subagents, keyed by id. */
const runningSubagents = runningState.agents;

// ── Widget management ──

/** Latest ExtensionContext from session_start, used for widget updates. */
let latestCtx: ExtensionContext | null = null;

/** Interval timer for widget re-renders. */
let widgetInterval: ReturnType<typeof setInterval> | null = null;

/** Interval timer for status transition checks. */
let statusInterval: ReturnType<typeof setInterval> | null = null;

function formatElapsedMMSS(startTime: number): string {
  const seconds = Math.floor((Date.now() - startTime) / 1000);
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

const ACCENT = "\x1b[38;2;77;163;255m";
const RST = "\x1b[0m";

/**
 * Build a bordered content line: │left          right│
 * Left content is truncated if needed, right is preserved, padded to fill width.
 */
function borderLine(left: string, right: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}│${RST}`;

  // width = total visible chars for the whole line including │ and │
  const contentWidth = Math.max(0, width - 2); // space inside the two │ chars
  const rightVis = visibleWidth(right);

  // If the status chunk alone is too wide, prefer preserving it in compact form
  // rather than overflowing the terminal.
  if (rightVis >= contentWidth) {
    const truncRight = truncateToWidth(right, contentWidth);
    const rightPad = Math.max(0, contentWidth - visibleWidth(truncRight));
    return `${ACCENT}│${RST}${truncRight}${" ".repeat(rightPad)}${ACCENT}│${RST}`;
  }

  const maxLeft = Math.max(0, contentWidth - rightVis);
  const truncLeft = truncateToWidth(left, maxLeft);
  const leftVis = visibleWidth(truncLeft);
  const pad = Math.max(0, contentWidth - leftVis - rightVis);
  return `${ACCENT}│${RST}${truncLeft}${" ".repeat(pad)}${right}${ACCENT}│${RST}`;
}

/**
 * Build the bordered top line: ╭─ Title ──── info ─╮
 * All chars are accounted for within `width`.
 */
function borderTop(title: string, info: string, width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╭${RST}`;

  // ╭─ Title ───...─── info ─╮
  // overhead: ╭─ (2) + space around title (2) + space around info (2) + ─╮ (2) = but we simplify
  const inner = Math.max(0, width - 2); // inside ╭ and ╮
  const titlePart = `─ ${title} `;
  const infoPart = ` ${info} ─`;
  const fillLen = Math.max(0, inner - titlePart.length - infoPart.length);
  const fill = "─".repeat(fillLen);
  const content = `${titlePart}${fill}${infoPart}`.slice(0, inner).padEnd(inner, "─");
  return `${ACCENT}╭${content}╮${RST}`;
}

/**
 * Build the bordered bottom line: ╰──────────────────╯
 */
function borderBottom(width: number): string {
  if (width <= 0) return "";
  if (width === 1) return `${ACCENT}╰${RST}`;

  const inner = Math.max(0, width - 2);
  return `${ACCENT}╰${"─".repeat(inner)}╯${RST}`;
}

function renderSubagentWidgetLines(agents: RunningSubagent[], width: number): string[] {
  const count = agents.length;
  const title = "Subagents";
  const info = `${count} running`;

  const lines: string[] = [borderTop(title, info, width)];

  for (const agent of agents) {
    const elapsed = formatElapsedMMSS(agent.record.startTime);
    const agentTag = agent.record.agent ? ` (${agent.record.agent})` : "";
    const left = ` ${elapsed}  ${agent.record.name}${agentTag} `;
    const snapshot = classifyStatus(agent.statusState, Date.now());
    const right = statusConfig.enabled
      ? formatWidgetRightLabel(snapshot)
      : agent.record.launch.kind === "claude"
        ? " running… "
        : " starting… ";

    lines.push(borderLine(left, right, width));
  }

  lines.push(borderBottom(width));
  return lines;
}

function updateWidget() {
  if (!latestCtx?.hasUI) return;

  if (runningSubagents.size === 0) {
    latestCtx.ui.setWidget("subagent-status", undefined);
    if (widgetInterval) {
      clearInterval(widgetInterval);
      widgetInterval = null;
      (globalThis as any)[WIDGET_INTERVAL_KEY] = null;
    }
    return;
  }

  latestCtx.ui.setWidget(
    "subagent-status",
    (_tui: any, _theme: any) => {
      return {
        invalidate() {},
        render(width: number) {
          return renderSubagentWidgetLines(Array.from(runningSubagents.values()), width);
        },
      };
    },
    { placement: "aboveEditor" },
  );
}

/**
 * Build the positional prompt args for a Pi CLI subagent launch.
 *
 * In artifact-backed launches (lineage-only, standalone), Pi's buildInitialMessage()
 * concatenates @file content with messages[0] into one initial prompt. That breaks
 * /skill: expansion because the message no longer starts with "/skill:". Only
 * messages[1..] are sent as separate follow-up prompts where /skill: is recognized.
 *
 * When there are skill prompts AND artifact-backed delivery, we prepend an empty
 * first positional message so that /skill: args land in messages[1..] and arrive
 * as standalone prompts in the child session.
 */
const SUBAGENT_CONTROL_TOOLS = ["caller_ping", "subagent_done"] as const;

/** Include completion controls in the child's initial tool selection. */
function buildSubagentToolAllowlist(effectiveTools?: string): string | null {
  const requested = (effectiveTools ?? "")
    .split(",")
    .map((tool) => tool.trim())
    .filter(Boolean);

  if (requested.length === 0) return null;

  const allow = new Set(requested);
  for (const tool of SUBAGENT_CONTROL_TOOLS) {
    allow.add(tool);
  }

  return [...allow].join(",");
}

function buildPiPromptArgs(params: {
  effectiveSkills?: string;
  taskDelivery: "direct" | "artifact";
  taskArg: string;
  inputFiles?: string[];
}): string[] {
  const inputFiles = params.inputFiles ?? [];
  for (const path of inputFiles) {
    if (!isAbsolute(path)) throw new Error("Subagent inputFiles must use absolute paths");
  }
  const skillPrompts = (params.effectiveSkills ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((skill) => `/skill:${skill}`);

  const needsSeparator = (params.taskDelivery === "artifact" || inputFiles.length > 0) && skillPrompts.length > 0;

  return [
    ...(needsSeparator ? [""] : []),
    ...skillPrompts,
    ...inputFiles.map((path) => `@${path}`),
    params.taskArg,
  ];
}

function activityLabel(activity: SubagentActivityState): string | undefined {
  if (activity.uiPrompt) return activity.uiPrompt.title || activity.uiPrompt.kind;
  if (activity.phase !== "active") return undefined;
  if (activity.activeScope === "tool") return activity.toolName ?? "tool";
  if (activity.activeScope === "provider") return "provider";
  if (activity.activeScope === "streaming") return "streaming";
  return activity.activeScope;
}

function observeRunningSubagent(running: RunningSubagent, observedAt = Date.now()) {
  if (running.record.launch.kind === "claude") return;

  const activityFile = running.record.launch.activityFile;
  const read: ActivityReadResult = activityFile
    ? readSubagentActivityFile(activityFile, running.record.id)
    : { ok: false, reason: "missing" };

  running.activityRead = read.ok
    ? { ok: true }
    : { ok: false, reason: read.reason, error: read.error };

  if (read.ok) {
    running.activity = read.activity;
    running.statusState = observeStatus(running.statusState, {
      snapshot: "present",
      updatedAt: read.activity.updatedAt,
      sequence: read.activity.sequence,
      phase: read.activity.phase,
      active: read.activity.phase === "active",
      activeScope: read.activity.activeScope,
      activeSince: read.activity.activeSince,
      waitingSince: read.activity.waitingSince,
      latestEvent: read.activity.latestEvent,
      activityLabel: activityLabel(read.activity),
    }, observedAt);
    return;
  }

  running.statusState = observeStatus(running.statusState, {
    snapshot: read.reason,
    snapshotError: read.error,
  }, observedAt);
}

function resolveInterruptTarget(params: { id?: string; name?: string }):
  | { running: RunningSubagent }
  | { error: string } {
  const requestedId = params.id?.trim();
  if (requestedId) {
    const running = runningSubagents.get(requestedId);
    return running ? { running } : { error: `No running subagent with id "${requestedId}".` };
  }

  const requestedName = params.name?.trim();
  if (!requestedName) {
    return { error: "Provide a running subagent id or exact display name." };
  }

  const matches = Array.from(runningSubagents.values()).filter((running) => running.record.name === requestedName);
  if (matches.length === 1) return { running: matches[0] };
  if (matches.length === 0) {
    return { error: `No running subagent named "${requestedName}".` };
  }

  const candidates = matches.map((running) => `${running.record.name} [${running.record.id}]`).join(", ");
  return { error: `Ambiguous subagent name "${requestedName}". Matches: ${candidates}` };
}

function requestSubagentInterrupt(
  running: RunningSubagent,
  sendEscapeKey: (surface: string) => void = sendEscape,
): { ok: true } | { error: string } {
  if (running.control === "recovered") return { error: "Use the child's original pane to interrupt it; recovered runs have no terminal controls." };
  try {
    sendEscapeKey(running.surface);
    return { ok: true };
  } catch (error: any) {
    const backend = getMuxBackend() ?? "unknown";
    return {
      error:
        `Failed to send Escape to subagent "${running.record.name}" via ${backend}: ` +
        `${error?.message ?? String(error)}`,
    };
  }
}

function handleSubagentInterrupt(
  params: { id?: string; name?: string },
  sendEscapeKey: (surface: string) => void = sendEscape,
) {
  const resolved = resolveInterruptTarget(params);
  if ("error" in resolved) {
    return {
      content: [{ type: "text" as const, text: resolved.error }],
      details: { error: resolved.error },
    };
  }

  const running = resolved.running;
  if (running.record.launch.kind === "claude") {
    return {
      content: [{
        type: "text" as const,
        text:
          "Turn-only Escape interrupt is currently supported only for Pi-backed subagents. Claude-backed semantics have not been verified yet.",
      }],
      details: { error: "claude interrupt unsupported", id: running.record.id, name: running.record.name },
    };
  }

  const now = Date.now();
  observeRunningSubagent(running, now);

  const interruption = requestSubagentInterrupt(running, sendEscapeKey);
  if ("error" in interruption) {
    return {
      content: [{ type: "text" as const, text: interruption.error }],
      details: { error: interruption.error, id: running.record.id, name: running.record.name },
    };
  }

  running.statusState = forceStatusAfterInterrupt(running.statusState, now);
  updateWidget();

  return {
    content: [{ type: "text" as const, text: `Interrupt requested for subagent "${running.record.name}".` }],
    details: { id: running.record.id, name: running.record.name, status: "interrupt_requested" },
  };
}

function startStatusRefresh(pi: ExtensionAPI) {
  if (!statusConfig.enabled || statusInterval) return;

  statusInterval = setInterval(() => {
    if (runningSubagents.size === 0) {
      if (statusInterval) {
        clearInterval(statusInterval);
        statusInterval = null;
        (globalThis as any)[STATUS_INTERVAL_KEY] = null;
      }
      return;
    }

    const transitionLines: string[] = [];
    const now = Date.now();
    let shouldRefreshWidget = false;

    for (const running of runningSubagents.values()) {
      observeRunningSubagent(running, now);
      const { nextState, snapshot, transition } = advanceStatusState(running.statusState, now);
      if (nextState.currentKind !== running.statusState.currentKind) {
        shouldRefreshWidget = true;
      }
      running.statusState = nextState;

      // User-driven children update the widget without waking the parent.
      if (transition && !running.record.interactive) {
        transitionLines.push(formatTransitionLine(running.record.name, snapshot, transition));
      }
    }

    if (shouldRefreshWidget) updateWidget();

    if (transitionLines.length > 0) {
      const capped = capStatusLines(transitionLines, statusConfig.lineLimit);
      pi.sendMessage(
        {
          customType: "subagent_status",
          content: formatStatusAggregate(transitionLines, statusConfig.lineLimit),
          display: true,
          details: { lines: capped.visibleLines, overflow: capped.overflow },
        },
        { triggerTurn: true, deliverAs: "steer" },
      );
    }
  }, 1000);

  (globalThis as any)[STATUS_INTERVAL_KEY] = statusInterval;
}

function resolveResumeLaunchBehavior(params: { autoExit?: boolean }): { autoExit: boolean; interactive: boolean } {
  const autoExit = params.autoExit ?? true;
  return { autoExit, interactive: !autoExit };
}

export const __test__ = {
  borderLine,
  getShellReadyDelayMs,
  renderSubagentWidgetLines,
  loadAgentDefaults,
  discoverAgentDefinitions,
  resolveEffectiveSessionMode,
  resolveLaunchBehavior,
  resolveEffectiveInteractive,
  buildSubagentToolAllowlist,
  buildPiPromptArgs,
  formatWidgetRightLabel,
  observeRunningSubagent,
  resolveDenyTools,
  resolveInterruptTarget,
  requestSubagentInterrupt,
  handleSubagentInterrupt,
  resolveResultPresentation,
  resolveResumeLaunchBehavior,
  runningSubagents,
  formatElapsed,
};

function startWidgetRefresh() {
  if (widgetInterval) return;
  updateWidget(); // immediate first render
  widgetInterval = setInterval(() => {
    updateWidget();
  }, 1000);
  (globalThis as any)[WIDGET_INTERVAL_KEY] = widgetInterval;
}

/**
 * Launch a subagent: creates the multiplexer pane, builds the command, and
 * sends it. Returns a RunningSubagent — does NOT poll.
 *
 * Call watchSubagent() on the returned object to observe completion.
 */
async function launchSubagent(
  params: typeof SubagentParams.static,
  ctx: { sessionManager: { getSessionFile(): string | null; getSessionId(): string; getSessionDir(): string }; cwd: string },
  options: { observer: ParentRunObserver<RunningSubagent>; surface?: string },
): Promise<RunningSubagent> {
  const startTime = Date.now();
  const id = Math.random().toString(16).slice(2, 10);

  const agentDefs = params.agent === undefined ? null : loadAgentDefaults(params.agent);
  if (agentDefs?.cli === "claude" && params.autoExit !== undefined) {
    throw new Error("autoExit is only supported for Pi-backed subagents; this definition uses cli: claude");
  }
  const effectiveModel = params.model ?? agentDefs?.model;
  const effectiveTools = params.tools ?? agentDefs?.tools;
  const effectiveSkills = params.skills ?? agentDefs?.skills;
  const effectiveThinking = params.thinking ?? agentDefs?.thinking;
  const effectiveAutoExit = resolveEffectiveAutoExit(params, agentDefs);
  const effectiveInteractive = resolveEffectiveInteractive(params, agentDefs);
  const isConversation = agentDefs?.profile === "conversation";
  const launchBehavior = resolveLaunchBehavior(params, agentDefs);
  if (isConversation && (!effectiveModel || effectiveSkills || effectiveTools ||
      launchBehavior.inheritsConversationContext || agentDefs.cli === "claude")) {
    throw new Error("Conversation agents require an explicit model, a fresh Pi session, and no skills or tool overrides");
  }
  buildPiPromptArgs({ taskDelivery: launchBehavior.taskDelivery, taskArg: "", inputFiles: params.inputFiles });

  const sessionFile = ctx.sessionManager.getSessionFile();
  if (!sessionFile) throw new Error("No session file");
  const sessionId = ctx.sessionManager.getSessionId();
  const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
  const owner = { sessionId, sessionFile: realpathSync(sessionFile) };
  const runDir = join(artifactDir, "subagent-runs", id);
  mkdirSync(dirname(runDir), { recursive: true });
  mkdirSync(runDir, { mode: 0o700 });

  const { effectiveCwd, localAgentDir, effectiveAgentDir } = resolveSubagentPaths(params, agentDefs);
  const targetCwdForSession = effectiveCwd ?? ctx.cwd;
  const sessionDir = getDefaultSessionDirFor(targetCwdForSession, effectiveAgentDir);

  // Generate a deterministic session file path for this subagent.
  // This eliminates race conditions when multiple agents launch simultaneously —
  // each agent knows exactly which file is theirs.
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 23) + "Z";
  const uuid = [
    id,
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 10),
    Math.random().toString(16).slice(2, 6),
  ].join("-");
  const subagentSessionFile = join(realpathSync(sessionDir), `${timestamp}_${uuid}.jsonl`);

  // Use pre-created surface (parallel mode) or create a new one.
  // For new surfaces, pause briefly so the shell is ready before sending the command.
  const surfacePreCreated = !!options?.surface;
  const surface = options?.surface ?? createSurface(params.name);
  let transferred = false;
  try {
  if (!surfacePreCreated) {
    await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));
  }

  options.observer.requireOpen();

  if (launchBehavior.seededSessionMode) {
    seedSubagentSessionFile({
      mode: launchBehavior.seededSessionMode,
      parentSessionFile: sessionFile,
      childSessionFile: subagentSessionFile,
      childCwd: targetCwdForSession,
    });
  }

  const activityFile = getSubagentActivityFile(artifactDir, id);
  mkdirSync(dirname(activityFile), { recursive: true });
  const { inheritsConversationContext } = launchBehavior;

  const summaryInstruction =
    "Your FINAL assistant message must provide the deliverable requested by your task, in its requested format.";
  const denySet = resolveDenyTools(agentDefs);
  const identity = agentDefs?.body ?? params.systemPrompt ?? null;
  const systemPromptMode = agentDefs?.systemPromptMode;
  const identityInSystemPrompt = systemPromptMode && identity;
  const roleBlock = identity && !identityInSystemPrompt ? `\n\n${identity}` : "";
  const fullTask = inheritsConversationContext || isConversation
    ? params.task
    : `${roleBlock}\n\n${params.task}\n\n${summaryInstruction}`;
  // ── Claude Code CLI path ──
  if (agentDefs?.cli === "claude") {
    const managedContext = JSON.stringify({ cli: "claude", runDir });
    const pluginDir = join(SUBAGENTS_DIR, "plugin");

    const cmdParts: string[] = [];
    cmdParts.push(`PI_SUBAGENT_RUN=${shellEscape(managedContext)}`, `PI_SUBAGENT_ID=${shellEscape(id)}`);
    cmdParts.push("claude");
    cmdParts.push("--dangerously-skip-permissions");

    if (existsSync(pluginDir)) {
      cmdParts.push("--plugin-dir", shellEscape(pluginDir));
    }

    if (effectiveModel) {
      cmdParts.push("--model", shellEscape(effectiveModel));
    }

    const sp = params.systemPrompt ?? agentDefs.body;
    if (sp) {
      cmdParts.push("--append-system-prompt", shellEscape(sp));
    }

    if (params.resumeSessionId) {
      cmdParts.push("--resume", shellEscape(params.resumeSessionId));
    }

    // Always pass the task as the prompt — even for resumed sessions,
    // the caller's task is the follow-up instruction.
    cmdParts.push(shellEscape(params.task));

    const command = buildRunCommand({ id, runDir, cwd: targetCwdForSession, execCommand: `exec env ${cmdParts.join(" ")}` });

    const launchScriptName = `${(params.name || "subagent")
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
    const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);

    writeCommandScript(command, {
      scriptPath: launchScriptFile,
      scriptPreamble: [
        `# Claude Code subagent launch script for ${params.name}`,
        `# Generated: ${new Date().toISOString()}`,
        `# Surface: ${surface}`,
      ].join("\n"),
    });

    const running = trackRun(decodeRun({ id, name: params.name, task: params.task, agent: params.agent ?? null, startTime, interactive: effectiveInteractive, owner, runDir, launch: { kind: "claude" } }), { control: "current", surface, launchScriptFile });

    transferred = true;
    dispatchRun(running, options.observer);
    return running;
  }

  // ── Pi CLI path ──

  // Build pi command
  const parts: string[] = ["/opt/homebrew/bin/pi"];
  parts.push("--session", shellEscape(subagentSessionFile));

  const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
  parts.push("-e", shellEscape(subagentDonePath));

  if (!isConversation) parts.push(...buildModelArgs(effectiveModel, effectiveThinking).map(shellEscape));
  let conversationProfile: ConversationProfile | null = null;
  let systemPrompt: LaunchSettings["systemPrompt"] = { mode: "none" };

  // Pass agent body as system prompt via file to avoid shell escaping issues
  // with multiline content. Pi's --append-system-prompt and --system-prompt
  // auto-detect file paths and read their contents.
  if (identityInSystemPrompt && identity) {
    const flag = systemPromptMode === "replace" ? "--system-prompt" : "--append-system-prompt";
    const spTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const spSafeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .replace(/\s+/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "");
    const syspromptPath = join(artifactDir, `context/${spSafeName || "subagent"}-sysprompt-${spTimestamp}.md`);
    mkdirSync(dirname(syspromptPath), { recursive: true });
    writeFileSync(syspromptPath, identity, "utf8");
    if (isConversation && effectiveModel) {
      conversationProfile = {
        systemPromptPath: syspromptPath, cwd: targetCwdForSession, agentDir: effectiveAgentDir,
        model: effectiveModel, thinking: effectiveThinking ?? null,
      };
      parts.push(...conversationArgs(conversationProfile).map(shellEscape));
    } else {
      systemPrompt = { mode: systemPromptMode === "replace" ? "replace" : "append", path: syspromptPath };
      parts.push(flag, shellEscape(syspromptPath));
    }
  }

  const toolAllowlist = buildSubagentToolAllowlist(effectiveTools);
  const launchSettings: LaunchSettings | null = isConversation ? null : {
    cwd: targetCwdForSession, agentDir: effectiveAgentDir, agent: params.agent ?? null,
    tools: toolAllowlist ? toolAllowlist.split(",") : null, deniedTools: [...denySet], systemPrompt,
  };

  // Build env prefix: resolved launch settings, subagent identity, and config directory.
  const envParts: string[] = [];

  // If the target cwd has its own .pi/agent/, use that as the config root.
  // Otherwise propagate the current/global agent dir.
  if (localAgentDir && existsSync(localAgentDir)) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(localAgentDir)}`);
  } else if (process.env.PI_CODING_AGENT_DIR) {
    envParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
  }

  envParts.push(`PI_SUBAGENT_RUN=${shellEscape(JSON.stringify({ cli: "pi", runDir, outputAfter: 0 }))}`);
  envParts.push(`PI_SUBAGENT_LAUNCH_SETTINGS=${shellEscape(launchSettings ? JSON.stringify(launchSettings) : "")}`);
  envParts.push(`PI_SUBAGENT_NAME=${shellEscape(params.name)}`);
  envParts.push(`PI_SUBAGENT_AGENT=${shellEscape(params.agent ?? "")}`);
  envParts.push(`PI_SUBAGENT_AUTO_EXIT=${effectiveAutoExit ? "1" : "0"}`);
  envParts.push(`PI_SUBAGENT_SESSION=${shellEscape(subagentSessionFile)}`);
  envParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
  envParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
  envParts.push(`PI_SUBAGENT_SURFACE=${shellEscape(surface)}`);
  envParts.push(`PI_SUBAGENT_CONVERSATION_PROFILE=${shellEscape(conversationProfile ? JSON.stringify(conversationProfile) : "")}`);
  const envPrefix = envParts.join(" ") + " ";

  // Pass task and skill prompts to the sub-agent.
  // Only full-context fork mode gets a direct task argument because it already
  // inherits the parent conversation. Blank-session modes use artifact-backed
  // handoff so the wrapper instructions arrive as the initial user message.
  let taskArg: string;
  if (launchBehavior.taskDelivery === "direct") {
    taskArg = fullTask;
  } else {
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const safeName = params.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "") // strip everything except alphanumeric, spaces, hyphens
      .replace(/\s+/g, "-") // spaces to hyphens
      .replace(/-+/g, "-") // collapse multiple hyphens
      .replace(/^-|-$/g, ""); // trim leading/trailing hyphens
    const artifactName = `context/${safeName || "subagent"}-${timestamp}.md`;
    const artifactPath = join(artifactDir, artifactName);
    mkdirSync(dirname(artifactPath), { recursive: true });
    writeFileSync(artifactPath, fullTask, "utf8");
    taskArg = `@${artifactPath}`;
  }

  for (const promptArg of buildPiPromptArgs({
    effectiveSkills,
    taskDelivery: launchBehavior.taskDelivery,
    taskArg,
    inputFiles: params.inputFiles,
  })) {
    parts.push(shellEscape(promptArg));
  }

  // Resolve cwd — param overrides agent default, supports absolute and relative paths.
  // This was already computed above so session placement, PI_CODING_AGENT_DIR, and cd agree.

  const piCommand = `exec env ${envPrefix}${parts.join(" ")}`;
  const { command, stderrFile } = buildPiLaunchCommand(piCommand, artifactDir, id, runDir, targetCwdForSession);
  const launchScriptName = `${(params.name || "subagent")
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "") || "subagent"}-${id}.sh`;
  const launchScriptFile = join(artifactDir, "subagent-scripts", launchScriptName);
  writeCommandScript(command, {
    scriptPath: launchScriptFile,
    scriptPreamble: [
      `# Subagent launch script for ${params.name}`,
      `# Generated: ${new Date().toISOString()}`,
      `# Session: ${subagentSessionFile}`,
      `# Surface: ${surface}`,
    ].join("\n"),
  });

  const running = trackRun(decodeRun({ id, name: params.name, task: params.task, agent: params.agent ?? null, startTime, interactive: effectiveInteractive, owner, runDir, launch: { kind: "pi-fresh", sessionFile: subagentSessionFile, activityFile, stderrFile, autoExit: effectiveAutoExit } }), { control: "current", surface, launchScriptFile });

  transferred = true;
    dispatchRun(running, options.observer);
  return running;
  } catch (error) {
    if (!transferred && !surfacePreCreated) closeSurface(surface);
    throw error;
  }
}

function buildPiLaunchCommand(piCommand: string, artifactDir: string, id: string, runDir: string, cwd: string) {
  const stderrFile = join(artifactDir, "subagent-stderr", `${id}.log`);
  mkdirSync(dirname(stderrFile), { recursive: true });
  writeFileSync(stderrFile, "", { mode: 0o600, flag: "wx" });
  // Keep stdout on the TTY; stderr must survive terminal closure even on a fatal exit.
  return { stderrFile, command: buildRunCommand({ id, runDir, cwd, execCommand: `${piCommand} 2>>${shellEscape(stderrFile)}` }) };
}

const CLAUDE_SESSIONS_DIR = join(
  process.env.HOME ?? "/tmp",
  ".pi", "agent", "sessions", "claude-code",
);

function dispatchRun(running: RunningSubagent & { control: "current" }, observer: ParentRunObserver<RunningSubagent>): void {
  try { observer.recordLaunch(running.record); }
  catch (error) { closeSurface(running.surface); throw error; }
  try { sendCommand(running.surface, `bash ${shellEscape(running.launchScriptFile)}`); }
  catch (error) {
    const claim = cancelUnstarted(running.record, "dispatch_failed");
    if (claim.kind === "not_started") { closeSurface(running.surface); throw error; }
    console.warn(`[subagents:launch] ${JSON.stringify({ id: running.record.id, event: "confirmation_incomplete" })}`);
  }
  observer.trackCurrent(running);
}

// oxlint-disable-next-line complexity, sonarjs/cognitive-complexity -- One formatter covers the captured outcome variants and their history/diagnostic references.
function resultMessage(running: RunningSubagent, outcome: RunOutcome): Parameters<ExtensionAPI["sendMessage"]>[0] {
  const run = running.record;
  const sessionFile = run.launch.kind === "claude" ? undefined : run.launch.sessionFile;
  const sessionRef = sessionFile ? `\n\nSession: ${sessionFile}\nResume: pi --session ${sessionFile}` : "";
  const details = { id: run.id, name: run.name, task: run.task, agent: run.agent ?? undefined,
    parentSessionId: run.owner.sessionId, parentSessionFile: run.owner.sessionFile,
    sessionFile, stderrFile: run.launch.kind === "claude" ? undefined : run.launch.stderrFile ?? undefined,
    exitReason: outcome.reason };
  if (outcome.reason === "ping") return {
    customType: "subagent_ping", display: true,
    content: `Sub-agent "${outcome.name}" needs help:\n\n${outcome.message}${sessionRef}`, details: { ...details, message: outcome.message },
  };
  const output = "output" in outcome ? outcome.output : null;
  let claudeSessionId: string | undefined;
  if (output?.cli === "claude" && output.transcriptPath) {
    try {
      mkdirSync(CLAUDE_SESSIONS_DIR, { recursive: true });
      claudeSessionId = output.transcriptPath.split("/").pop();
      if (claudeSessionId) copyFileSync(output.transcriptPath, join(CLAUDE_SESSIONS_DIR, claudeSessionId));
    } catch (error) { console.warn(`[subagents:recovery] ${JSON.stringify({ id: run.id, event: "transcript_copy_failed", error: error instanceof Error ? error.name : "Error" })}`); }
  }
  if (outcome.reason === "interrupted") return {
    customType: "subagent_result", display: true,
    content: `Sub-agent "${run.name}" was interrupted.\n\n${output?.text ?? "The execution did not finish. Nothing was relaunched."}${sessionRef}`, details: { ...details, claudeSessionId },
  };
  const elapsed = Math.floor((outcome.recordedAt - run.startTime) / 1000);
  const exitCode = outcome.reason === "sentinel" ? outcome.exitCode : outcome.reason === "error" ? 1 : 0;
  const errorMessage = outcome.reason === "error" ? outcome.errorMessage : undefined;
  const summary = output?.text ?? (run.launch.kind === "pi-resume" ? "Resumed session exited without new output" : "Sub-agent exited without output");
  return { customType: "subagent_result", display: true,
    content: resolveResultPresentation({ summary, elapsed, exitCode, exitReason: outcome.reason, errorMessage, sessionFile }, run.name) +
      (exitCode !== 0 && details.stderrFile ? `\n\nStderr: ${details.stderrFile}` : ""),
    details: { ...details, elapsed, exitCode, errorMessage, claudeSessionId },
  };
}

function closeCompletedSurface(surface: string): Error | null {
  try { closeSurface(surface); return null; }
  catch (error) { return error instanceof Error ? error : new Error(String(error)); }
}

export default function subagentsExtension(pi: ExtensionAPI) {
  const observer = new ParentRunObserver(pi, runningState, {
    restore: (record) => trackRun(record, { control: "recovered" }),
    message: resultMessage,
    update(running) { observeRunningSubagent(running); updateWidget(); },
    cleanup(running) {
      if (running.control === "current") {
        const error = closeCompletedSurface(running.surface);
        if (error) console.warn(`[subagents:terminal-lifecycle] ${JSON.stringify({ id: running.record.id, event: "close_failed", error: error.name })}`);
      }
    },
    operatorClosed(running) {
      return running.control === "current" && getMuxBackend() === "orca" ? () => isTabClosed(running.surface) : null;
    },
  });
  let ready: Promise<void> = Promise.resolve();
  pi.on("session_start", (event, ctx) => {
    latestCtx = ctx;
    const reason = Value.Decode(Type.Object({ reason: Type.String() }), event).reason;
    ready = observer.start(ctx, reason);
    return ready.then(() => {
      if (runningSubagents.size) { startWidgetRefresh(); startStatusRefresh(pi); }
    });
  });
  pi.on("session_shutdown", async (event) => {
    const { reason } = Value.Decode(ShutdownEvent, event);
    if (widgetInterval) { clearInterval(widgetInterval); widgetInterval = null; Reflect.set(globalThis, WIDGET_INTERVAL_KEY, null); }
    if (statusInterval) { clearInterval(statusInterval); statusInterval = null; Reflect.set(globalThis, STATUS_INTERVAL_KEY, null); }
    await observer.detach(reason);
  });

  // ── subagent tool ──
    pi.registerTool({
      name: "subagent",
      label: "Subagent",
      description:
        "Delegate a task to a child agent in a separate terminal pane. Returns immediately with a launch acknowledgement; the result arrives later in this conversation and starts a new turn. " +
        "Set autoExit: true to close the child and return its result after its final response. " +
        "With automatic exit disabled, a reply leaves the session open; the child must call subagent_done or the user must close it to return a result. " +
        "After launching, end your turn or do independent work. Do not poll for completion or assume a result before it arrives.",
      promptSnippet:
        "Delegate a task to a child agent in a separate terminal pane. Returns immediately with a launch acknowledgement; the result arrives later in this conversation and starts a new turn. " +
        "Set autoExit: true to close the child and return its result after its final response. " +
        "With automatic exit disabled, a reply leaves the session open; the child must call subagent_done or the user must close it to return a result. " +
        "After launching, end your turn or do independent work. Do not poll for completion or assume a result before it arrives.",
      parameters: SubagentParams,

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        // Prevent self-spawning (e.g. planner spawning another planner)
        const currentAgent = process.env.PI_SUBAGENT_AGENT;
        if (params.agent && currentAgent && params.agent === currentAgent) {
          return {
            content: [
              {
                type: "text",
                text: `You are the ${currentAgent} agent — do not start another ${currentAgent}. You were spawned to do this work yourself. Complete the task directly.`,
              },
            ],
            details: { error: "self-spawn blocked" },
          };
        }

        // Validate prerequisites
        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!ctx.sessionManager.getSessionFile()) {
          return {
            content: [
              {
                type: "text",
                text: "Error: no session file. Start pi with a persistent session to use subagents.",
              },
            ],
            details: { error: "no session file" },
          };
        }

        // Launch the subagent (creates pane, sends command)
        let running: RunningSubagent;
        try {
          await ready;
          running = await launchSubagent(params, ctx, { observer });
        } catch (error) {
          if (error instanceof AgentDefinitionError) logAgentDefinitionError("subagent", error);
          throw error;
        }

        startWidgetRefresh();
        startStatusRefresh(pi);


        const completionInstruction = running.record.launch.kind === "pi-fresh"
          ? running.record.launch.autoExit
            ? "Automatic exit is enabled: the child will return its result and close after its final response. "
            : "Automatic exit is disabled: a completed reply leaves the session open. Results are delivered when the child calls subagent_done or the user closes that child session. "
          : "The result will be delivered when the child session completes. ";
        const launchDetails = {
          id: running.record.id,
          name: params.name,
          task: params.task,
          agent: params.agent,
          launchScriptFile: running.control === "current" ? running.launchScriptFile : undefined,
          status: "started",
        };
        const details = running.record.launch.kind === "claude" ? launchDetails : {
          ...launchDetails, sessionFile: running.record.launch.sessionFile, stderrFile: running.record.launch.stderrFile,
        };
        // Return immediately
        return {
          content: [
            {
              type: "text",
              text:
                `Sub-agent "${params.name}" launched and is now running in the background. ` +
                completionInstruction +
                `End your turn or do independent work until the result arrives.`,
            },
          ],
          details: running.record.launch.kind === "pi-fresh"
            ? { ...details, autoExit: running.record.launch.autoExit }
            : details,
        };
      },

      renderCall(args, theme) {
        const partialArgs = args as Record<string, unknown>;
        const name = typeof partialArgs.name === "string" && partialArgs.name ? partialArgs.name : "(unnamed)";
        const task = typeof partialArgs.task === "string" ? partialArgs.task : "";
        const agent = typeof partialArgs.agent === "string" && partialArgs.agent
          ? theme.fg("dim", ` (${partialArgs.agent})`)
          : "";
        const cwdHint = typeof partialArgs.cwd === "string" && partialArgs.cwd
          ? theme.fg("dim", ` in ${partialArgs.cwd}`)
          : "";
        let text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          agent +
          cwdHint;

        // Show a one-line task preview. renderCall is called repeatedly as the
        // LLM generates tool arguments, so args.task grows token by token.
        // We keep it compact here — Ctrl+O on renderResult expands the full content.
        if (task) {
          const firstLine = task.split("\n").find((l: string) => l.trim()) ?? "";
          const preview = firstLine.length > 100 ? firstLine.slice(0, 100) + "…" : firstLine;
          if (preview) {
            text += "\n" + theme.fg("toolOutput", preview);
          }
          const totalLines = task.split("\n").length;
          if (totalLines > 1) {
            text += theme.fg("muted", ` (${totalLines} lines)`);
          }
        }

        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme, context) {
        if (context.isError) {
          return new Text(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), 0, 0);
        }
        const details = result.details as any;
        const name = details?.name ?? "(unnamed)";

        // "Started" result — tool returned immediately
        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — started"),
            0,
            0,
          );
        }

        // Fallback (shouldn't happen)
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagent_interrupt tool ──
    pi.registerTool({
      name: "subagent_interrupt",
      label: "Interrupt Subagent",
      description:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      promptSnippet:
        "Send Escape to the active turn of a currently running Pi-backed subagent. " +
        "The child pane, session, watcher, and running entry remain alive; this returns only a local acknowledgement " +
        "and does not emit a subagent_result solely because of this request.",
      parameters: Type.Object({
        id: Type.Optional(Type.String({ description: "Exact running subagent id" })),
        name: Type.Optional(Type.String({ description: "Exact running subagent display name" })),
      }),

      async execute(_toolCallId, params) {
        return handleSubagentInterrupt(params);
      },

      renderCall(args, theme) {
        const target = args.id ? `${args.id}` : args.name ?? "(unknown)";
        return new Text(
          theme.fg("accent", "▸") +
            " " +
            theme.fg("toolTitle", theme.bold(target)) +
            theme.fg("dim", " — interrupt turn"),
          0,
          0,
        );
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        if (details?.status === "interrupt_requested") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(details.name ?? details.id ?? "subagent")) +
              theme.fg("dim", " — interrupt requested"),
            0,
            0,
          );
        }

        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },
    });

  // ── subagents_list tool ──
    pi.registerTool({
      name: "subagents_list",
      label: "List Subagents",
      description:
        "List definitions marked extension: pi-interactive-subagents in .pi/agents/ and <agent-dir>/agents/. " +
        "The global agent directory honors PI_CODING_AGENT_DIR (default ~/.pi/agent). " +
        "Project definitions replace global definitions with the same canonical name.",
      promptSnippet:
        "List marked pi-interactive-subagents definitions from project and global agent directories.",
      parameters: Type.Object({}),

      async execute() {
        let list: ListedAgentDefinition[];
        try {
          list = discoverAgentDefinitions().filter((agent) => !agent.disableModelInvocation);
        } catch (error) {
          if (error instanceof AgentDefinitionError) logAgentDefinitionError("subagents_list", error);
          throw error;
        }

        if (list.length === 0) {
          return {
            content: [{ type: "text", text: `No subagent definitions found. Add extension: pi-interactive-subagents to definitions in ${join(getAgentConfigDir(), "agents")} or ${join(process.cwd(), ".pi", "agents")}.` }],
            details: { agents: [] },
          };
        }

        const lines = list.map((a) => {
          const badge = a.source === "project" ? " (project)" : "";
          const desc = a.description ? ` — ${a.description}` : "";
          const model = a.model ? ` [${a.model}]` : "";
          return `• ${a.name}${badge}${model}${desc}`;
        });

        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { agents: list },
        };
      },

      renderResult(result, _opts, theme, context) {
        if (context.isError) {
          return new Text(result.content.filter((block) => block.type === "text").map((block) => block.text).join("\n"), 0, 0);
        }
        const details = result.details as any;
        const agents = details?.agents ?? [];
        if (agents.length === 0) {
          return new Text(theme.fg("dim", "No subagent definitions found."), 0, 0);
        }
        const lines = agents.map((a: any) => {
          const badge = a.source === "project" ? theme.fg("accent", " (project)") : "";
          const desc = a.description ? theme.fg("dim", ` — ${a.description}`) : "";
          const model = a.model ? theme.fg("dim", ` [${a.model}]`) : "";
          return `  ${theme.fg("toolTitle", theme.bold(a.name))}${badge}${model}${desc}`;
        });
        return new Text(lines.join("\n"), 0, 0);
      },
    });



  // ── subagent_resume tool ──
    pi.registerTool({
      name: "subagent_resume",
      label: "Resume Subagent",
      description:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      promptSnippet:
        "Resume a previous sub-agent session in a new multiplexer pane. " +
        "This is a fire-and-forget async tool: the call returns immediately with only an acknowledgement. " +
        "When the resumed sub-agent finishes, the harness AUTOMATICALLY delivers its result as a steer message that wakes you up and starts a new turn — you do not need to do anything to receive it. " +
        "DO NOT write polling loops, sleep/wait commands, tail/watch scripts, or repeatedly read session/log files to detect completion. DO NOT poll for status. All of that is wasted work — the harness handles delivery for you. " +
        "DO NOT fabricate or assume results. After resuming, either end your turn or work on other independent tasks; the harness will wake you when the result is ready. " +
        "Use when a sub-agent was cancelled or needs follow-up work.",
      parameters: Type.Object({
        sessionPath: Type.String({ description: "Path to the session .jsonl file to resume" }),
        name: Type.Optional(
          Type.String({ description: "Display name for the terminal tab. Default: 'Resume'" }),
        ),
        message: Type.Optional(
          Type.String({
            description: "Optional message to send after resuming (e.g. follow-up instructions)",
          }),
        ),
        autoExit: Type.Optional(
          Type.Boolean({
            description:
              "Whether the resumed session should automatically exit after completing its response. Defaults to true for autonomous follow-up work; set false for interactive resumed sessions.",
          }),
        ),
      }),

      renderCall(args, theme) {
        const name = args.name ?? "Resume";
        const text =
          "▸ " +
          theme.fg("toolTitle", theme.bold(name)) +
          theme.fg("dim", " — resuming session");
        return new Text(text, 0, 0);
      },

      renderResult(result, _opts, theme) {
        const details = result.details as any;
        const name = details?.name ?? "Resume";

        if (details?.status === "started") {
          return new Text(
            theme.fg("accent", "▸") +
              " " +
              theme.fg("toolTitle", theme.bold(name)) +
              theme.fg("dim", " — resumed"),
            0,
            0,
          );
        }

        // Fallback
        const text = typeof result.content[0]?.text === "string" ? result.content[0].text : "";
        return new Text(theme.fg("dim", text), 0, 0);
      },

      async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
        const name = params.name ?? "Resume";
        const { autoExit, interactive } = resolveResumeLaunchBehavior(params);
        const startTime = Date.now();
        const id = Math.random().toString(16).slice(2, 10);

        if (!isMuxAvailable()) {
          return muxUnavailableResult();
        }

        if (!existsSync(params.sessionPath)) {
          return {
            content: [
              { type: "text", text: `Error: session file not found: ${params.sessionPath}` },
            ],
            details: { error: "session not found" },
          };
        }

        const sessionPath = realpathSync(params.sessionPath);
        if (runningState.pendingResumes.has(sessionPath)) {
          console.warn(`[subagents:resume] ${JSON.stringify({ event: "duplicate_rejected", sessionPath })}`);
          return {
            isError: true,
            content: [{ type: "text", text: `Error: session is already running or already being resumed: ${sessionPath}` }],
            details: { error: "session already running", sessionPath },
          };
        }
        runningState.pendingResumes.add(sessionPath);
        let surface: string | undefined;
        try {
          await ready;
          const unavailable = observer.resolveResumeAvailability(sessionPath);
          if (unavailable) return { isError: true, content: [{ type: "text", text: unavailable }], details: { error: unavailable, sessionPath } };
          // Record entry count before resuming so we can extract new messages
          const entriesBefore = getNewEntries(sessionPath, 0);
          const entryCountBefore = entriesBefore.length;
          const conversationProfile = readConversationProfile(entriesBefore);
          const resumeSession = SessionManager.open(sessionPath);
          const launchSettings = readLaunchSettings(resumeSession.getBranch(), resumeSession.getSessionId());
          if (launchSettings) requireLaunchResources(launchSettings);
          if (conversationProfile && !existsSync(conversationProfile.systemPromptPath)) {
            throw new Error(`Conversation system prompt is missing: ${conversationProfile.systemPromptPath}`);
          }

          surface = createSurface(name);
          await new Promise<void>((resolve) => setTimeout(resolve, getShellReadyDelayMs()));

          observer.requireOpen();

          // Build pi resume command
          const parts = ["/opt/homebrew/bin/pi", "--session", shellEscape(sessionPath)];

          // Load subagent-done extension so the agent can self-terminate if needed
          const subagentDonePath = join(SUBAGENTS_DIR, "subagent-done.ts");
          parts.push("-e", shellEscape(subagentDonePath));
          parts.push(...buildResumeArgs(sessionPath, conversationProfile).map(shellEscape));
          if (launchSettings) parts.push(...launchPromptArgs(launchSettings).map(shellEscape));

          const sessionId = ctx.sessionManager.getSessionId();
          const artifactDir = getArtifactDir(ctx.sessionManager.getSessionDir(), sessionId);
          const parentFile = ctx.sessionManager.getSessionFile();
          if (!parentFile) throw new Error("Subagent requires a persisted parent session");
          const owner = { sessionId, sessionFile: realpathSync(parentFile) };
          const runDir = join(artifactDir, "subagent-runs", id);
          mkdirSync(dirname(runDir), { recursive: true });
          mkdirSync(runDir, { mode: 0o700 });
          const activityFile = getSubagentActivityFile(artifactDir, id);
          mkdirSync(dirname(activityFile), { recursive: true });

          let resumeMsgFile: string | undefined;
          if (params.message) {
            const msgTimestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
            resumeMsgFile = join(
              artifactDir,
              "subagent-resume",
              `${name
                .toLowerCase()
                .replace(/[^a-z0-9\s-]/g, "")
                .replace(/\s+/g, "-")
                .replace(/-+/g, "-")
                .replace(/^-|-$/g, "") || "resume"}-${msgTimestamp}.md`,
            );
            mkdirSync(dirname(resumeMsgFile), { recursive: true });
            writeFileSync(resumeMsgFile, params.message, "utf8");
            parts.push(shellEscape(`@${resumeMsgFile}`));
          }

          // Build env prefix — propagate PI_CODING_AGENT_DIR for config isolation
          const resumeEnvParts: string[] = [`PI_SUBAGENT_RUN=${shellEscape(JSON.stringify({ cli: "pi", runDir, outputAfter: entryCountBefore }))}`];
          if (conversationProfile) {
            resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(conversationProfile.agentDir)}`);
          } else if (launchSettings) {
            resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(launchSettings.agentDir)}`);
          } else if (process.env.PI_CODING_AGENT_DIR) {
            resumeEnvParts.push(`PI_CODING_AGENT_DIR=${shellEscape(process.env.PI_CODING_AGENT_DIR)}`);
          }
          resumeEnvParts.push(`PI_SUBAGENT_LAUNCH_SETTINGS=${shellEscape(launchSettings ? JSON.stringify(launchSettings) : "")}`);
          resumeEnvParts.push(`PI_SUBAGENT_CONVERSATION_PROFILE=${shellEscape(conversationProfile ? JSON.stringify(conversationProfile) : "")}`);
          resumeEnvParts.push(`PI_SUBAGENT_AGENT=${shellEscape(launchSettings?.agent ?? "")}`);
          resumeEnvParts.push(`PI_SUBAGENT_NAME=${shellEscape(name)}`);
          resumeEnvParts.push(`PI_SUBAGENT_SESSION=${shellEscape(sessionPath)}`);
          resumeEnvParts.push(`PI_SUBAGENT_ID=${shellEscape(id)}`);
          resumeEnvParts.push(`PI_SUBAGENT_ACTIVITY_FILE=${shellEscape(activityFile)}`);
          resumeEnvParts.push(`PI_SUBAGENT_AUTO_EXIT=${autoExit ? "1" : "0"}`);
          const resumeEnvPrefix = resumeEnvParts.join(" ") + " ";

          const resumeCwd = conversationProfile?.cwd ?? launchSettings?.cwd;
          const { command, stderrFile } = buildPiLaunchCommand(`exec env ${resumeEnvPrefix}${parts.join(" ")}`, artifactDir, id, runDir, resumeCwd ?? ctx.cwd);
          const launchScriptFile = join(
            artifactDir,
            "subagent-scripts",
            `${name
              .toLowerCase()
              .replace(/[^a-z0-9\s-]/g, "")
              .replace(/\s+/g, "-")
              .replace(/-+/g, "-")
              .replace(/^-|-$/g, "") || "resume"}-resume-${Date.now()}.sh`,
          );
          writeCommandScript(command, {
            scriptPath: launchScriptFile,
            scriptPreamble: [
              `# Subagent resume script for ${name}`,
              `# Generated: ${new Date().toISOString()}`,
              `# Session: ${sessionPath}`,
              `# Surface: ${surface}`,
              ...(resumeMsgFile ? [`# Resume message file: ${resumeMsgFile}`] : []),
            ].join("\n"),
          });

          // Register as a running subagent for widget tracking
          const running = trackRun(decodeRun({ id, name, task: params.message ?? "resumed session", agent: launchSettings?.agent ?? null, startTime, interactive, owner, runDir, launch: { kind: "pi-resume", sessionFile: sessionPath, activityFile, stderrFile, autoExit, entryCountBefore } }), { control: "current", surface, launchScriptFile });
          surface = undefined;
          dispatchRun(running, observer);
          startWidgetRefresh();
          startStatusRefresh(pi);



          return {
            content: [{ type: "text", text: `Session "${name}" resumed.` }],
            details: {
              id,
              name,
              sessionPath,
              launchScriptFile,
              stderrFile,
              status: "started",
            },
          };
        } catch (error) {
          if (surface) {
            try { closeSurface(surface); }
            catch (cleanupError) {
              console.error(`[subagents:resume] ${JSON.stringify({ event: "cleanup_failed", surface })}`);
              throw new AggregateError([error, cleanupError], "Resume startup and terminal cleanup failed");
            }
          }
          throw error;
        } finally {
          runningState.pendingResumes.delete(sessionPath);
        }
      },
    });

  // /subagent command — spawn a subagent by name
  pi.registerCommand("subagent", {
    description: "Spawn a subagent: /subagent <agent> <task>",
    getArgumentCompletions: (argumentPrefix) => {
      const prefix = argumentPrefix.trimStart();
      if (/\s/.test(prefix)) return null;
      try {
        const matches = discoverAgentDefinitions()
          .filter((agent) => agent.name.toLowerCase().startsWith(prefix.toLowerCase()))
          .map((agent) => ({ value: agent.name, label: agent.name, description: agent.description }));
        return matches.length > 0 ? matches : null;
      } catch (error) {
        if (!(error instanceof AgentDefinitionError)) throw error;
        logAgentDefinitionError("subagent-completion", error);
        return null;
      }
    },
    handler: async (args, ctx) => {
      const trimmed = args.trim();
      if (!trimmed) {
        ctx.ui.notify("Usage: /subagent <agent> [task]", "warning");
        return;
      }

      const spaceIdx = trimmed.search(/\s/);
      const agentName = spaceIdx === -1 ? trimmed : trimmed.slice(0, spaceIdx);
      const task = spaceIdx === -1 ? "" : trimmed.slice(spaceIdx + 1).trim();

      try {
        loadAgentDefaults(agentName);
      } catch (error) {
        if (!(error instanceof AgentDefinitionError)) throw error;
        logAgentDefinitionError("subagent-command", error);
        ctx.ui.notify(error.message, "error");
        return;
      }

      const taskText = task || `You are the ${agentName} agent. Wait for instructions.`;
      const displayName = agentName[0].toUpperCase() + agentName.slice(1);
      const toolCall = `Use subagent with agent: ${JSON.stringify(agentName)}, name: ${JSON.stringify(displayName)}, task: ${JSON.stringify(taskText)}`;
      pi.sendUserMessage(toolCall);
    },
  });

  // ── subagent_result message renderer ──
  pi.registerMessageRenderer("subagent_result", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const exitCode = details.exitCode ?? 0;
        const errorMessage = typeof details.errorMessage === "string" ? details.errorMessage : "";
        const exitReason = details.exitReason;
        const closedByUser = exitReason === "quit";
        const interrupted = exitReason === "interrupted";
        const failed = interrupted || (!closedByUser && (exitCode !== 0 || !!errorMessage));
        const elapsed = details.elapsed != null ? formatElapsed(details.elapsed) : "?";
        const bgFn = failed
          ? (text: string) => theme.bg("toolErrorBg", text)
          : (text: string) => theme.bg("toolSuccessBg", text);
        const icon = failed
          ? theme.fg("error", "✗")
          : theme.fg("success", "✓");
        const status = interrupted ? "interrupted" : closedByUser
          ? "closed by user"
          : errorMessage
            ? "failed (provider/agent error)"
            : failed
              ? `failed (exit ${exitCode})`
              : "completed";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";

        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "—")} ${status} ${theme.fg("dim", `(${elapsed})`)}`;
        const rawContent = typeof message.content === "string" ? message.content : "";

        // Clean summary (remove session ref and leading label for display)
        const summary = rawContent
          .replace(/\n\nSession: .+\nResume: .+$/, "")
          .replace(`Sub-agent "${name}" completed (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" closed by user (${elapsed}).\n\n`, "")
          .replace(`Sub-agent "${name}" failed (exit code ${exitCode}).\n\n`, "")
          .replace(`Sub-agent "${name}" was interrupted.\n\n`, "")
          .replace(
            new RegExp(
              `^Sub-agent "${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}" failed after ${elapsed} \\(provider/agent error\\)\\.\\n\\n`,
            ),
            "",
          );

        // Build content for the box
        const contentLines = [header];

        if (options.expanded) {
          // Full view: complete summary + session info
          if (summary) {
            for (const line of summary.split("\n")) {
              contentLines.push(line.slice(0, width - 6));
            }
          }
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
            contentLines.push(theme.fg("dim", `Resume:  pi --session ${details.sessionFile}`));
          }
        } else {
          // Collapsed: preview + expand hint
          if (summary) {
            const previewLines = summary.split("\n").slice(0, 5);
            for (const line of previewLines) {
              contentLines.push(theme.fg("dim", line.slice(0, width - 6)));
            }
            const totalLines = summary.split("\n").length;
            if (totalLines > 5) {
              contentLines.push(theme.fg("muted", `… ${totalLines - 5} more lines`));
            }
          }
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        // Render via Box for background + padding, with blank line above for separation
        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_status message renderer ──
  pi.registerMessageRenderer("subagent_status", (message, options, theme) => {
    const details = message.details as any;
    const lines = Array.isArray(details?.lines) ? details.lines : [];
    const overflow = typeof details?.overflow === "number" ? details.overflow : 0;
    if (lines.length === 0 && overflow === 0) return undefined;

    return {
      render(width: number): string[] {
        const lineWidth = Math.max(0, width - 6);
        const contentLines = [
          `${theme.fg("accent", "•")} ${theme.fg("toolTitle", theme.bold("Subagent status"))}`,
          ...lines.map((line: string) => theme.fg("dim", truncateToWidth(line, lineWidth))),
        ];

        if (overflow > 0) {
          contentLines.push(theme.fg("muted", `+${overflow} more running.`));
        }
        if (!options.expanded) {
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, (text: string) => theme.bg("customMessageBg", text));
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

  // ── subagent_ping message renderer ──
  pi.registerMessageRenderer("subagent_ping", (message, options, theme) => {
    const details = message.details as any;
    if (!details) return undefined;

    return {
      render(width: number): string[] {
        const name = details.name ?? "subagent";
        const agentTag = details.agent ? theme.fg("dim", ` (${details.agent})`) : "";
        const bgFn = (text: string) => theme.bg("toolSuccessBg", text);

        const icon = theme.fg("accent", "?");
        const header = `${icon} ${theme.fg("toolTitle", theme.bold(name))}${agentTag} ${theme.fg("dim", "— needs help")}`;

        const contentLines = [header];

        if (options.expanded) {
          contentLines.push("");
          contentLines.push(details.message ?? "");
          if (details.sessionFile) {
            contentLines.push("");
            contentLines.push(theme.fg("dim", `Session: ${details.sessionFile}`));
          }
        } else {
          const preview = (details.message ?? "").split("\n")[0].slice(0, width - 10);
          contentLines.push(theme.fg("dim", preview));
          contentLines.push(theme.fg("muted", keyHint("app.tools.expand", "to expand")));
        }

        const box = new Box(1, 1, bgFn);
        box.addChild(new Text(contentLines.join("\n"), 0, 0));
        return ["", ...box.render(width)];
      },
    };
  });

}
// test
