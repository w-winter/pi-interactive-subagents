import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI, ExtensionCommandContext, Theme, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { CombinedAutocompleteProvider } from "@mariozechner/pi-tui";
import subagentsExtension, { __test__ } from "../pi-extension/subagents/index.ts";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { withIsolatedAgentEnv, writeAgentFile } from "./helpers/agent-fixtures.ts";

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
    writeAgentFile(globalAgents, echo, `name: ${echo}\ndescription: Global role`, "Global instructions.");
    writeAgentFile(projectAgents, echo, `name: ${echo}\ndescription: Project role`, "Project instructions.");
    writeAgentFile(projectAgents, quiet, `name: ${quiet}\ndisable-model-invocation: true`, "User-invoked instructions.");
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

function commandRuntime() {
  const commands = new Map<string, Parameters<ExtensionAPI["registerCommand"]>[1]>();
  const tools = new Map<string, {
    execute(ctx: ExtensionCommandContext): ReturnType<ToolDefinition["execute"]>;
    renderResult: ToolDefinition["renderResult"];
  }>();
  const sent: string[] = [];
  const notifications: Array<{ message: string; severity: string | undefined }> = [];
  const api: Partial<ExtensionAPI> = {
    on() {}, registerMessageRenderer() {}, getAllTools() { return []; },
    registerCommand(name, command) { commands.set(name, command); },
    registerTool(tool) {
      tools.set(tool.name, {
        execute(ctx) {
          const params = {};
          assert.ok(Value.Check(tool.parameters, params));
          return tool.execute("list", params, undefined, undefined, ctx);
        },
        // SAFETY: Error rendering uses the native error shape; these renderers do not consume state or arguments.
        renderResult: tool.renderResult as ToolDefinition["renderResult"],
      });
    },
    sendUserMessage(message) { assert.ok(Value.Check(Type.String(), message)); sent.push(message); },
  };
  // SAFETY: The registration double implements every API used by this extension during loading.
  subagentsExtension(api as ExtensionAPI);
  const command = commands.get("subagent");
  assert.ok(command?.getArgumentCompletions);
  // SAFETY: Command submission only reads ui.notify; no session or terminal operations run here.
  const ctx = { hasUI: true, ui: { notify(message: string, severity?: string) {
    notifications.push({ message, severity });
  } } } as ExtensionCommandContext;
  return { command, complete: command.getArgumentCompletions, tools, sent, notifications, ctx };
}

test("manual invocation resolves canonical hidden names and preserves literal task text", async () => {
  await withIsolatedAgentEnv(async ({ globalAgentsDir, projectAgentsDir }) => {
    const name = 'manual-"role';
    writeAgentFile(globalAgentsDir, "alias", `name: ${JSON.stringify(name)}\ndescription: Global role`);
    writeAgentFile(projectAgentsDir, "other-alias", `name: ${JSON.stringify(name)}\ndescription: Project role\ndisable-model-invocation: true`);
    writeFileSync(join(projectAgentsDir, "unmarked.md"), "---\nprofile: private\n---\nPrivate");
    writeFileSync(join(projectAgentsDir, "foreign.md"), "---\nextension: other\nprofile: private\n---\nPrivate");
    const runtime = commandRuntime();
    assert.deepEqual((await runtime.complete(""))?.map(item => item.value), [name]);
    const list = runtime.tools.get("subagents_list");
    assert.ok(list);
    const result = await list.execute(runtime.ctx);
    assert.equal(JSON.stringify(result.details), '{"agents":[]}');
    for (const separator of [" ", "\t", "\n"]) {
      const task = "Do one\n  then two";
      await runtime.command.handler(name + separator + task, runtime.ctx);
      const message = runtime.sent.at(-1);
      assert.ok(message?.includes(`agent: ${JSON.stringify(name)}`));
      assert.ok(message?.includes(`task: ${JSON.stringify(task)}`));
    }
    for (const unavailable of ["alias", "other-alias", "unmarked", "foreign", "missing"]) {
      await runtime.command.handler(`${unavailable} Task`, runtime.ctx);
      assert.match(runtime.notifications.at(-1)?.message ?? "", /not found/);
      assert.equal(runtime.notifications.at(-1)?.severity, "error");
    }
    assert.equal(runtime.sent.length, 3);
    const artifacts = join(import.meta.dirname, "artifacts/command-completions");
    mkdirSync(artifacts, { recursive: true });
    writeFileSync(join(artifacts, "manual-receipt.json"), JSON.stringify({ sent: runtime.sent, notifications: runtime.notifications, paidRequests: 0 }, null, 2));
  });
});

test("configuration failure stays visible at submission and does not reject native autocomplete", async () => {
  await withIsolatedAgentEnv(async ({ projectDir, projectAgentsDir }) => {
    const path = join(projectAgentsDir, "broken.md");
    writeAgentFile(projectAgentsDir, "valid", "name: valid");
    writeFileSync(path, "---\nextension: pi-interactive-subagents\nbroken: [\n---");
    const runtime = commandRuntime();
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args) => { warnings.push(args.map(String).join(" ")); };
    try {
      const provider = new CombinedAutocompleteProvider([{ name: "subagent", ...runtime.command }], projectDir);
      for (const input of ["/subagent ", "/subagent v"]) {
        const result = await provider.getSuggestions([input], 0, input.length, { signal: new AbortController().signal });
        assert.equal(result, null);
      }
      assert.equal(warnings.length, 2);
      assert.ok(warnings.every(warning => warning.includes(path)));
      assert.equal(runtime.notifications.length, 0);
      assert.equal(await runtime.complete("valid Task"), null);
      assert.equal(warnings.length, 2, "task text must not scan definitions");
      await runtime.command.handler("valid Task", runtime.ctx);
      assert.ok(runtime.notifications[0].message.includes(path));
      assert.deepEqual(runtime.sent, []);
      const list = runtime.tools.get("subagents_list");
      assert.ok(list?.renderResult);
      let diagnostic = "";
      await assert.rejects(list.execute(runtime.ctx), (error: Error) => {
        diagnostic = error.message;
        return diagnostic.includes(path);
      });
      // SAFETY: These renderers only call fg and bold; color values are not under test.
      const theme = { fg(_color: string, text: string) { return text; }, bold(text: string) { return text; } } as Theme;
      for (const tool of [list, runtime.tools.get("subagent")]) {
        assert.ok(tool?.renderResult);
        const rendered = tool.renderResult({ content: [{ type: "text", text: diagnostic }], details: {} },
          { expanded: false, isPartial: false }, theme, {
            args: {}, toolCallId: "failed", invalidate() {}, lastComponent: undefined, state: {}, cwd: projectDir,
            executionStarted: true, argsComplete: true, isPartial: false, expanded: false, showImages: false, isError: true,
          });
        assert.ok(rendered.render(120).join("\n").includes(path));
      }
    } finally {
      console.warn = originalWarn;
    }
  });
});
