import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";

test("subagent completion uses effective definitions and preserves task text", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "pis-completions-"));
  const previousCwd = process.cwd();
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  const agentDir = join(dir, "agent");
  const globalAgents = join(agentDir, "agents");
  const projectAgents = join(dir, ".pi/agents");
  const echo = "completion-fixture-Echo";
  const quiet = "completion-fixture-Quiet";
  try {
    mkdirSync(globalAgents, { recursive: true });
    mkdirSync(projectAgents, { recursive: true });
    writeFileSync(join(globalAgents, `${echo}.md`), `---\nname: ${echo}\ndescription: Global role\n---\nGlobal instructions.\n`);
    writeFileSync(join(projectAgents, `${echo}.md`), `---\nname: ${echo}\ndescription: Project role\n---\nProject instructions.\n`);
    writeFileSync(join(projectAgents, `${quiet}.md`), `---\nname: ${quiet}\ndisable-model-invocation: true\n---\nUser-invoked instructions.\n`);
    process.chdir(dir);
    process.env.PI_CODING_AGENT_DIR = agentDir;
    const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
    const api: Partial<ExtensionAPI> = {
      on() {}, registerTool() {}, registerMessageRenderer() {},
      registerCommand(name, command) { commands.set(name, command); },
      getAllTools() { return []; },
    };
    // SAFETY: Loading the extension uses only the registration APIs supplied by this runtime double.
    subagentsExtension(api as ExtensionAPI);
    const command = commands.get("subagent");
    assert.ok(command);
    const complete = command.getArgumentCompletions;
    assert.ok(complete);
    const matches = await complete("CoMpLeTiOn-FiXtUrE-");
    assert.ok(matches);
    assert.deepEqual(matches.map((item) => item.value).sort(), [echo, quiet]);
    assert.equal(matches.find((item) => item.value === echo)?.description, "Project role");
    assert.equal(__test__.loadAgentDefaults(echo)?.body, "Project instructions.");
    assert.ok((await complete(""))?.some((item) => item.value === quiet));
    assert.equal(await complete("no-such-completion-fixture"), null);
    for (const prefix of [`${echo} `, `${echo}\tDo work`, `${echo}\nDo work`]) {
      assert.equal(await complete(prefix), null);
    }
    const provider = new CombinedAutocompleteProvider([{ name: "subagent", ...command }], dir);
    const line = "/subagent completion-fixture-e Do work";
    const cursor = line.indexOf(" Do work");
    const suggestions = await provider.getSuggestions([line], 0, cursor, { signal: new AbortController().signal });
    assert.ok(suggestions);
    const item = suggestions.items.find((item) => item.value === echo);
    assert.ok(item);
    const completed = provider.applyCompletion([line], 0, cursor, item, suggestions.prefix);
    assert.deepEqual(completed.lines, [`/subagent ${echo} Do work`]);
    const artifacts = join(import.meta.dirname, "artifacts/command-completions");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "receipt.json"), JSON.stringify({ matches, completed, paidRequests: 0 }, null, 2) + "\n");
    t.diagnostic(`Verification artifact: ${artifacts}/receipt.json`);
  } finally {
    process.chdir(previousCwd);
    if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
    execFileSync("trash", [dir]);
  }
});
