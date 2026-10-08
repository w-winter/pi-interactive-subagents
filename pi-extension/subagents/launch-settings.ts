import { accessSync, constants, existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const LaunchSchema = Type.Object({
  cwd: Type.String(), agentDir: Type.String(), agent: Type.Union([Type.String(), Type.Null()]),
  tools: Type.Union([Type.Array(Type.String()), Type.Null()]), deniedTools: Type.Array(Type.String()),
  systemPrompt: Type.Union([
    Type.Object({ mode: Type.Literal("none") }),
    Type.Object({ mode: Type.Union([Type.Literal("append"), Type.Literal("replace")]), path: Type.String() }),
  ]),
});
const SavedLaunchSchema = Type.Object({
  ...LaunchSchema.properties, tools: Type.Array(Type.String()), sessionId: Type.String(),
});
const EntrySchema = Type.Object({
  type: Type.Literal("custom"), customType: Type.Literal("subagent-launch"), data: Type.Unknown(),
});

/** Resolved ordinary-child context; null tools uses Pi's initial selection. */
export type LaunchSettings = Static<typeof LaunchSchema>;
type SavedLaunchSettings = Static<typeof SavedLaunchSchema>;

function requireAbsolutePaths(settings: LaunchSettings): void {
  if (!isAbsolute(settings.cwd) || !isAbsolute(settings.agentDir) ||
      (settings.systemPrompt.mode !== "none" && !isAbsolute(settings.systemPrompt.path))) {
    throw new Error("Subagent launch settings require absolute paths");
  }
}

/** Parse resolved launch settings supplied by the parent to an ordinary child. */
export function parseLaunchSettings(json: string): LaunchSettings {
  const settings = Value.Decode(LaunchSchema, JSON.parse(json));
  requireAbsolutePaths(settings);
  return settings;
}

/** Read this session's latest selected-branch settings, excluding inherited parent settings. */
export function readLaunchSettings(entries: readonly unknown[], sessionId: string): SavedLaunchSettings | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!Value.Check(EntrySchema, entry)) continue;
    const settings = Value.Decode(SavedLaunchSchema, entry.data);
    requireAbsolutePaths(settings);
    if (settings.sessionId === sessionId) return settings;
  }
  return null;
}

/** Require the original directories and role file before creating a resumed terminal. */
export function requireLaunchResources(settings: LaunchSettings): void {
  for (const path of [settings.cwd, settings.agentDir]) {
    if (!existsSync(path) || !statSync(path).isDirectory()) throw new Error(`Subagent launch directory is missing: ${path}`);
    accessSync(path, constants.R_OK | constants.X_OK);
  }
  if (settings.systemPrompt.mode !== "none" &&
      (!existsSync(settings.systemPrompt.path) || !statSync(settings.systemPrompt.path).isFile())) {
    throw new Error(`Subagent system prompt is missing: ${settings.systemPrompt.path}`);
  }
  if (settings.systemPrompt.mode !== "none") accessSync(settings.systemPrompt.path, constants.R_OK);
}

export function launchPromptArgs(settings: LaunchSettings): string[] {
  return settings.systemPrompt.mode === "none" ? [] : [
    settings.systemPrompt.mode === "replace" ? "--system-prompt" : "--append-system-prompt",
    settings.systemPrompt.path,
  ];
}
