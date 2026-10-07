import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { RpcClient } from "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
import { __test__ } from "../pi-extension/subagents/index.ts";
import { withIsolatedAgentEnv, writeAgentFile } from "./helpers/agent-fixtures.ts";

const root = join(import.meta.dirname, "..");
const receipts: object[] = [];
after(() => {
  const artifacts = join(import.meta.dirname, "artifacts/agent-membership");
  mkdirSync(artifacts, { recursive: true });
  writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ node: process.version, receipts, paidRequests: 0 }, null, 2));
});

test("installed runtime rejects unmarked commands and queues only the canonical marked instruction", async () => {
  await withIsolatedAgentEnv(async ({ projectDir, globalDir, globalAgentsDir }) => {
    writeFileSync(join(globalAgentsDir, "unmarked.md"), "---\nname: unmarked\n---\nPrivate");
    writeAgentFile(globalAgentsDir, "alias", "name: runtime-member");
    const session = join(projectDir, "runtime.jsonl");
    const rpc = new RpcClient({
      cliPath: "/opt/homebrew/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js",
      cwd: projectDir,
      args: ["--offline", "--no-extensions", "--no-skills", "--no-context-files", "--no-tools", "--session", session,
        "--model", "guard-test/astra", "-e", join(root, "test/fixtures/model-guard-provider.ts"),
        "-e", join(root, "pi-extension/subagents/index.ts")],
      env: { PI_CODING_AGENT_DIR: globalDir },
    });
    const Notification = Type.Object({ type: Type.Literal("extension_ui_request"), method: Type.Literal("notify"), message: Type.String(), notifyType: Type.String() });
    const notifications: Array<{ message: string; severity: string }> = [];
    // RPC emits UI notifications despite omitting them from its event declaration.
    rpc.onEvent(event => {
      const boundaryEvent: unknown = event;
      if (Value.Check(Notification, boundaryEvent)) notifications.push({ message: boundaryEvent.message, severity: boundaryEvent.notifyType });
    });
    try {
      await rpc.start();
      const rejected = await rpc.prompt("/subagent unmarked Do not start");
      assert.equal(rejected, "handled");
      assert.ok(notifications.some(event => event.severity === "error" && event.message.includes("unmarked") && event.message.includes(globalAgentsDir)));
      await rpc.promptAndWait("/subagent runtime-member Verify installed parser");
      const UserEntry = Type.Object({ type: Type.Literal("message"), message: Type.Object({ role: Type.Literal("user"), content: Type.Array(Type.Object({ type: Type.Literal("text"), text: Type.String() })) }) });
      const instructions = readFileSync(session, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line))
        .filter(entry => Value.Check(UserEntry, entry)).flatMap(entry => entry.message.content.map(part => part.text))
        .filter(text => text.startsWith("Use subagent with"));
      assert.equal(instructions.length, 1);
      assert.ok(instructions[0].includes('agent: "runtime-member"'));
      const artifacts = join(root, "test/artifacts/agent-membership");
      mkdirSync(artifacts, { recursive: true });
      writeFileSync(join(artifacts, "installed-runtime.json"), JSON.stringify({ rejected, notifications, instructions, paidRequests: 0 }, null, 2));
      cpSync(session, join(artifacts, "installed-runtime.jsonl"));
    } finally {
      await rpc.stop();
    }
  });
});

test("membership precedes private field interpretation", async () => {
  await withIsolatedAgentEnv(({ globalAgentsDir }) => {
    writeAgentFile(globalAgentsDir, "member", "name: member");
    for (const [name, marker] of [
      ["unmarked", ""], ["foreign", "extension: session-ask\n"],
      ["case", "extension: Pi-Interactive-Subagents\n"],
      ["list", "extension: [pi-interactive-subagents]\n"],
      ["map", "extension: {owner: pi-interactive-subagents}\n"],
    ]) {
      writeFileSync(join(globalAgentsDir, `${name}.md`), `---\n${marker}profile: private\ntools: [read, bash]\n---\nPrivate instructions.`);
    }
    const names = __test__.discoverAgentDefinitions().map((agent) => agent.name);
    assert.deepEqual(names, ["member"]);
    receipts.push({ test: "membership", names });
  });
});

test("canonical identity and project precedence replace whole definitions", async () => {
  await withIsolatedAgentEnv(({ globalAgentsDir, projectAgentsDir }) => {
    writeAgentFile(globalAgentsDir, "global-alias", "name: shared\nmodel: global/model\ntools: read", "Global");
    writeAgentFile(projectAgentsDir, "project-alias", "name: shared\nmodel: project/model", "Project");
    writeAgentFile(globalAgentsDir, "same-file", "name: global-name");
    writeAgentFile(projectAgentsDir, "same-file", "name: project-name");
    writeAgentFile(globalAgentsDir, "filename-default", "description: No declared name");
    const shared = __test__.loadAgentDefaults("shared");
    assert.equal(shared.body, "Project");
    assert.equal(shared.model, "project/model");
    assert.equal(shared.tools, undefined);
    assert.equal(__test__.discoverAgentDefinitions().find((agent) => agent.name === "shared")?.source, "project");
    assert.equal(__test__.loadAgentDefaults("filename-default").description, "No declared name");
    assert.throws(() => __test__.loadAgentDefaults("project-alias"), /not found/);
    assert.deepEqual(__test__.discoverAgentDefinitions().map((agent) => agent.name), ["filename-default", "global-name", "project-name", "shared"]);
    receipts.push({ test: "identity", names: __test__.discoverAgentDefinitions().map((agent) => agent.name) });
  });
});

test("foreign project files do not displace eligible global definitions", async () => {
  await withIsolatedAgentEnv(({ globalAgentsDir, projectAgentsDir }) => {
    writeAgentFile(globalAgentsDir, "shared", "name: shared", "Global");
    writeFileSync(join(projectAgentsDir, "shared.md"), "---\nname: shared\nextension: other\nprofile: private\n---\nForeign");
    assert.equal(__test__.loadAgentDefaults("shared").body, "Global");
    assert.equal(__test__.discoverAgentDefinitions().find((agent) => agent.name === "shared")?.source, "global");
  });
});

test("quoted YAML, BOM and newline variants preserve membership and settings", async () => {
  await withIsolatedAgentEnv(({ globalAgentsDir }) => {
    for (const newline of ["\n", "\r\n", "\r"]) {
      for (const bom of ["", "\uFEFF"]) {
        const content = '--- \nextension: "pi-interactive-subagents"\nname: "quoted"\nmodel: "provider/model # literal"\nspawning: ""\ninteractive: "TRUE"\ndisable-model-invocation: "TRUE"\nsession-mode: sideways\n---\nBody\n';
        writeFileSync(join(globalAgentsDir, "file.md"), bom + content.replaceAll("\n", newline));
        const agent = __test__.loadAgentDefaults("quoted");
        assert.equal(agent.model, "provider/model # literal");
        assert.equal(agent.body, "Body");
        assert.equal(agent.spawning, false);
        assert.equal(agent.interactive, false);
        assert.equal(agent.disableModelInvocation, true);
        assert.equal(agent.sessionMode, undefined);
      }
    }
    receipts.push({ test: "yaml", newlineVariants: 3, bomVariants: 2 });
  });
});

test("malformed frontmatter and invalid member fields fail with the offending path", async () => {
  await withIsolatedAgentEnv(({ globalAgentsDir, projectAgentsDir, globalDir, projectDir }) => {
    writeAgentFile(globalAgentsDir, "valid", "name: valid");
    const path = join(projectAgentsDir, "broken.md");
    const invalid = [
      "---\nextension: pi-interactive-subagents\nbroken: [\n---",
      "---\nextension: one\nextension: two\n---",
      "---\nextension: pi-interactive-subagents",
      "---suffix\nextension: pi-interactive-subagents\n---",
      "---\nextension: pi-interactive-subagents\n---suffix\n---",
      "---\n- pi-interactive-subagents\n---",
      "---\nscalar\n---",
      ...["profile: private", "profile: conversation", "model: []", "spawning: null", 'model: ""', 'name: "has space"', 'name: ""']
        .map((field) => `---\nextension: pi-interactive-subagents\n${field}\n---\nBody`),
    ];
    for (const content of invalid) {
      writeFileSync(path, content);
      const hasPath = (error: Error) => error.message.includes(path);
      assert.throws(() => __test__.discoverAgentDefinitions(), hasPath);
      assert.throws(() => __test__.loadAgentDefaults("valid"), hasPath);
    }
    execFileSync("trash", [path]);
    writeAgentFile(globalAgentsDir, "duplicate", "name: valid");
    assert.throws(() => __test__.loadAgentDefaults("valid"), (error: Error) =>
      error.message.includes(join(globalAgentsDir, "duplicate.md")) && error.message.includes(join(globalAgentsDir, "valid.md")));
    execFileSync("trash", [join(globalAgentsDir, "duplicate.md")]);
    for (const name of ["", "missing", "../valid", "Valid"]) {
      assert.throws(() => __test__.loadAgentDefaults(name), (error: Error) =>
        error.message.includes(globalDir) && error.message.includes(projectDir) && error.message.includes("omit"));
    }
    receipts.push({ test: "diagnostics", invalidCases: invalid.length, pathsReported: true });
  });
});

test("next operation sees definition edits and removal", async () => {
  await withIsolatedAgentEnv(({ globalAgentsDir }) => {
    writeAgentFile(globalAgentsDir, "file", "name: before", "First");
    assert.equal(__test__.loadAgentDefaults("before").body, "First");
    writeAgentFile(globalAgentsDir, "file", "name: after", "Second");
    assert.equal(__test__.loadAgentDefaults("after").body, "Second");
    assert.throws(() => __test__.loadAgentDefaults("before"), /not found/);
    execFileSync("trash", [join(globalAgentsDir, "file.md")]);
    assert.throws(() => __test__.loadAgentDefaults("after"), /not found/);
  });
});

test("a private package copy ignores package, example and test definition decoys", async () => {
  const directory = mkdtempSync(join(tmpdir(), "pis-definition-sources-"));
  try {
    cpSync(join(root, "pi-extension"), join(directory, "pi-extension"), { recursive: true });
    for (const file of ["package.json", "config.json.example"]) cpSync(join(root, file), join(directory, file));
    symlinkSync(join(root, "node_modules"), join(directory, "node_modules"), "dir");
    for (const path of ["agents", "examples/agents", "test/integration/agents"]) {
      writeAgentFile(join(directory, path), "inactive", "name: inactive");
    }
    const output = execFileSync(process.execPath, ["--input-type=module", "-e", `
      import assert from 'node:assert/strict';
      import { __test__ } from './pi-extension/subagents/index.ts';
      const names = __test__.discoverAgentDefinitions().map(agent => agent.name);
      assert.deepEqual(names, []);
      assert.throws(() => __test__.loadAgentDefaults('inactive'), /not found/);
      console.log(JSON.stringify({names, inactiveLookupRejected: true}));
    `], { cwd: directory, env: { ...process.env, PI_CODING_AGENT_DIR: join(directory, "isolated") }, encoding: "utf8" });
    receipts.push({ test: "inactive-sources", output: output.trim() });
  } finally {
    execFileSync("trash", [directory]);
  }
});
