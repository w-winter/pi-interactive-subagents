import { isAbsolute } from "node:path";
import { Type, type Static } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const ProfileSchema = Type.Object({
  systemPromptPath: Type.String(), cwd: Type.String(), agentDir: Type.String(),
  model: Type.String({ minLength: 1 }), thinking: Type.Union([Type.String(), Type.Null()]),
});
const ProfileEntrySchema = Type.Object({
  type: Type.Literal("custom"), customType: Type.Literal("subagent-conversation"), data: Type.Optional(Type.Unknown()),
});
export type ConversationProfile = Static<typeof ProfileSchema>;

function validatePaths(data: ConversationProfile): ConversationProfile {
  if (!isAbsolute(data.systemPromptPath) || !isAbsolute(data.cwd) || !isAbsolute(data.agentDir)) {
    throw new Error("Invalid subagent conversation profile");
  }
  return {
    systemPromptPath: data.systemPromptPath, cwd: data.cwd, agentDir: data.agentDir,
    model: data.model, thinking: data.thinking,
  };
}

export function parseConversationProfile(json: string): ConversationProfile {
  return validatePaths(Value.Decode(ProfileSchema, JSON.parse(json)));
}

/** Read the launch contract from session metadata; ordinary agent sessions have none. */
export function readConversationProfile(entries: readonly unknown[]): ConversationProfile | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (!Value.Check(ProfileEntrySchema, entry)) continue;
    return validatePaths(Value.Decode(ProfileSchema, entry.data));
  }
  return null;
}

export function buildModelArgs(model: string | undefined, thinking: string | undefined): string[] {
  return [...(model ? ["--model", model] : []), ...(thinking ? ["--thinking", thinking] : [])];
}

export function conversationArgs(profile: ConversationProfile): string[] {
  return [
    "--no-tools", "--no-extensions", "--no-skills", "--no-prompt-templates", "--no-context-files",
    "--system-prompt", profile.systemPromptPath, "--append-system-prompt", "",
    ...buildModelArgs(profile.model, profile.thinking ?? undefined),
  ];
}
