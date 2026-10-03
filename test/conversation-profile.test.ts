import assert from "node:assert/strict";
import test from "node:test";
import { conversationArgs, readConversationProfile, buildModelArgs, type ConversationProfile } from "../pi-extension/subagents/conversation-profile.ts";
import { __test__ } from "../pi-extension/subagents/index.ts";

const profile: ConversationProfile = {
  systemPromptPath: "/tmp/custom instructions.md",
  cwd: "/tmp/project",
  agentDir: "/tmp/config",
  model: "example/conversation-model",
  thinking: "off",
};

test("conversation launches suppress tools, context files, discovered extensions, skills, and prompt appendices", () => {
  const args = conversationArgs(profile);
  for (const flag of ["--no-tools", "--no-context-files", "--no-extensions", "--no-skills", "--no-prompt-templates"]) {
    assert.ok(args.includes(flag));
  }
  assert.equal(args[args.indexOf("--system-prompt") + 1], profile.systemPromptPath);
  assert.equal(args[args.indexOf("--append-system-prompt") + 1], "");
  assert.equal(args[args.indexOf("--thinking") + 1], "off");
});

test("resume restores the latest recorded conversation profile and rejects malformed records", () => {
  const entry = { type: "custom", customType: "subagent-conversation", data: profile };
  assert.deepEqual(readConversationProfile([{ type: "session" }, entry]), profile);
  assert.equal(readConversationProfile([{ type: "session" }]), null);
  assert.throws(() => readConversationProfile([entry, { ...entry, data: { ...profile, systemPromptPath: "relative.md" } }]), /conversation profile/i);
});

test("explicit thinking off overrides a model suffix and also works with the default model", () => {
  assert.deepEqual(buildModelArgs("example/model:high", "off"), ["--model", "example/model:high", "--thinking", "off"]);
  assert.deepEqual(buildModelArgs(undefined, "off"), ["--thinking", "off"]);
});

test("input files become CLI attachments rather than path references in the task", () => {
  assert.deepEqual(__test__.buildPiPromptArgs({
    taskDelivery: "artifact", taskArg: "@/tmp/task.md", inputFiles: ["/tmp/context with spaces.md"],
  }), ["@/tmp/context with spaces.md", "@/tmp/task.md"]);
  assert.throws(() => __test__.buildPiPromptArgs({
    taskDelivery: "artifact", taskArg: "@/tmp/task.md", inputFiles: ["relative.md"],
  }), /absolute/i);
});

test("attachments do not prevent a skill prompt from expanding in a forked session", () => {
  assert.deepEqual(__test__.buildPiPromptArgs({
    taskDelivery: "direct", taskArg: "Continue the task", effectiveSkills: "review",
    inputFiles: ["/tmp/context.md"],
  }), ["", "/skill:review", "@/tmp/context.md", "Continue the task"]);
});
