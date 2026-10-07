import { parseFrontmatter } from "@mariozechner/pi-coding-agent";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

export type SubagentSessionMode = "standalone" | "lineage-only" | "fork";
export type AgentSource = "global" | "project";

export interface AgentDefaults {
  profile?: "conversation";
  model?: string;
  tools?: string;
  skills?: string;
  thinking?: string;
  denyTools?: string;
  spawning?: boolean;
  autoExit?: boolean;
  interactive?: boolean;
  systemPromptMode?: "append" | "replace";
  sessionMode?: SubagentSessionMode;
  cwd?: string;
  cli?: string;
  body?: string;
  disableModelInvocation?: boolean;
}

export interface ListedAgentDefinition extends AgentDefaults {
  name: string;
  description?: string;
  disableModelInvocation: boolean;
  source: AgentSource;
}

/** A definition operation failed; the message identifies the file or searched directories. */
export class AgentDefinitionError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AgentDefinitionError";
  }
}

const EXTENSION_MARKER = "pi-interactive-subagents";
const SCALAR_FIELDS = [
  "name", "description", "model", "tools", "skill", "skills", "thinking", "deny-tools",
  "cwd", "cli", "profile", "system-prompt", "session-mode", "spawning", "auto-exit",
  "interactive", "disable-model-invocation",
];
const NONEMPTY_FIELDS = new Set(["model", "tools", "skill", "skills", "thinking", "cwd", "cli", "profile"]);
const FrontmatterFields = Type.Record(Type.String(), Type.Unknown());
const ScalarField = Type.Union([Type.String(), Type.Number(), Type.Boolean()]);

function configurationError(path: string, reason: string, cause?: unknown): AgentDefinitionError {
  return new AgentDefinitionError(`Invalid agent definition at ${path}: ${reason}`, { cause });
}

function parseOptionalBoolean(value: string | undefined): boolean | undefined {
  return value === undefined ? undefined : value === "true";
}

function readFrontmatter(content: string, path: string): { fields: Static<typeof FrontmatterFields>; body: string } | null {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (!normalized.startsWith("---")) return null;
  const opening = normalized.split("\n", 1)[0];
  if (!/^---[ \t]*$/.test(opening)) throw configurationError(path, "invalid opening frontmatter delimiter");
  // Check the first closing candidate used by the SDK, not a later valid-looking delimiter.
  const end = normalized.indexOf("\n---", 3);
  if (end === -1) throw configurationError(path, "frontmatter has no closing --- line");
  const closing = normalized.slice(end + 1).split("\n", 1)[0];
  if (!/^---[ \t]*$/.test(closing)) throw configurationError(path, "invalid closing frontmatter delimiter");

  let parsed: ReturnType<typeof parseFrontmatter>;
  try {
    parsed = parseFrontmatter(normalized);
  } catch (error) {
    const reason = error instanceof Error ? error.message.split("\n")[0] : "YAML parser failed";
    throw configurationError(path, reason, error);
  }
  if (!Value.Check(FrontmatterFields, parsed.frontmatter)) throw configurationError(path, "frontmatter must be a YAML mapping");
  if (parsed.frontmatter.extension !== EXTENSION_MARKER) return null;
  return { fields: parsed.frontmatter, body: parsed.body.trim() };
}

function normalizeFields(frontmatter: Static<typeof FrontmatterFields>, path: string): Map<string, string> {
  const fields = new Map<string, string>();
  for (const key of SCALAR_FIELDS) {
    const value = frontmatter[key];
    if (value === undefined) continue;
    if (!Value.Check(ScalarField, value)) {
      throw configurationError(path, `${key} must be a scalar string, number or boolean`);
    }
    const text = String(value).trim();
    if (NONEMPTY_FIELDS.has(key) && !text) throw configurationError(path, `${key} must not be empty`);
    fields.set(key, text);
  }
  return fields;
}

function parseSessionMode(value: string | undefined): SubagentSessionMode | undefined {
  if (value === "standalone" || value === "lineage-only" || value === "fork") return value;
  return undefined;
}

function parseDefinition(content: string, path: string, source: AgentSource): ListedAgentDefinition | null {
  const parsed = readFrontmatter(content, path);
  if (!parsed) return null;
  const fields = normalizeFields(parsed.fields, path);
  const name = fields.get("name") ?? basename(path, ".md");
  if (!name || /\s/.test(name)) throw configurationError(path, "name must be a nonempty token with no whitespace");
  const profile = fields.get("profile");
  const systemPromptMode = fields.get("system-prompt");
  const body = parsed.body || undefined;
  if (profile !== undefined && profile !== "conversation") throw configurationError(path, `Unsupported agent profile: ${profile}`);
  if (profile === "conversation" && (systemPromptMode !== "replace" || !body)) {
    throw configurationError(path, "Conversation agents require system-prompt: replace and a nonempty prompt body");
  }
  return {
    name, source, profile, body,
    description: fields.get("description"),
    model: fields.get("model"),
    tools: fields.get("tools"),
    skills: fields.get("skill") ?? fields.get("skills"),
    thinking: fields.get("thinking"),
    denyTools: fields.get("deny-tools"),
    cwd: fields.get("cwd"),
    cli: fields.get("cli"),
    spawning: parseOptionalBoolean(fields.get("spawning")),
    autoExit: parseOptionalBoolean(fields.get("auto-exit")),
    interactive: parseOptionalBoolean(fields.get("interactive")),
    disableModelInvocation: fields.get("disable-model-invocation")?.toLowerCase() === "true",
    systemPromptMode: systemPromptMode === "append" || systemPromptMode === "replace" ? systemPromptMode : undefined,
    sessionMode: parseSessionMode(fields.get("session-mode")),
  };
}

function activeDirectories(agentConfigDir: string, cwd: string): Array<{ path: string; source: AgentSource }> {
  return [
    { path: resolve(agentConfigDir, "agents"), source: "global" },
    { path: resolve(cwd, ".pi", "agents"), source: "project" },
  ];
}

function readCandidates(directory: string): string[] {
  try {
    return readdirSync(directory).filter((file) => file.endsWith(".md")).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw configurationError(directory, "could not read definition directory", error);
  }
}

/** Rereads immediate marked definitions; project names replace entire global definitions. Any configuration error aborts the scan. */
export function discoverAgentDefinitions(agentConfigDir: string, cwd: string): ListedAgentDefinition[] {
  const effective = new Map<string, ListedAgentDefinition>();
  for (const { path: directory, source } of activeDirectories(agentConfigDir, cwd)) {
    const pathsByName = new Map<string, string>();
    for (const candidate of readCandidates(directory)) {
      const path = join(directory, candidate);
      let content: string;
      try {
        content = readFileSync(path, "utf8");
      } catch (error) {
        throw configurationError(path, "could not read definition file", error);
      }
      const definition = parseDefinition(content, path, source);
      if (!definition) continue;
      const previous = pathsByName.get(definition.name);
      if (previous) throw new AgentDefinitionError(`Duplicate agent name ${JSON.stringify(definition.name)} in ${source} definitions: ${previous} and ${path}`);
      pathsByName.set(definition.name, path);
      effective.set(definition.name, definition);
    }
  }
  return [...effective.values()].sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** Resolves an exact canonical name from the same scan as discovery; absence throws before launch. */
export function loadAgentDefaults(agentName: string, agentConfigDir: string, cwd: string): ListedAgentDefinition {
  const definition = discoverAgentDefinitions(agentConfigDir, cwd).find((agent) => agent.name === agentName);
  if (definition) return definition;
  const directories = activeDirectories(agentConfigDir, cwd).map((directory) => directory.path).join(" and ");
  throw new AgentDefinitionError(`Agent ${JSON.stringify(agentName)} not found. Use definitions marked extension: ${EXTENSION_MARKER} in ${directories}. For a bare launch, omit agent.`);
}
