# pi-interactive-subagents

Async subagents for [pi](https://github.com/badlogic/pi-mono) — spawn, orchestrate, and manage sub-agent sessions in multiplexer panes. **Fully non-blocking** — the main agent keeps working while subagents run in the background.

https://github.com/user-attachments/assets/30adb156-cfb4-4c47-84ca-dd4aa80cba9f

## How It Works

Call `subagent()` and it **returns immediately**. The sub-agent runs in its own terminal pane. A live widget above the input shows all running agents with their current state: `starting`, `active`, `blocked`, `waiting`, `stalled`, or `running`. When a sub-agent finishes, its result is **steered back** into the main session as an async notification, triggering a new turn so the agent can process it.

```
╭─ Subagents ──────────────────────────── 2 running ─╮
│ 00:23  Scout: Auth (scout)        active · bash 7m │
│ 00:45  Scout: DB (scout)                waiting 2m │
╰────────────────────────────────────────────────────╯
```

For parallel execution, just call `subagent` multiple times — they all run concurrently:

```typescript
subagent({ name: "Scout: Auth", agent: "scout", task: "Analyze auth module" });
subagent({ name: "Scout: DB", agent: "scout", task: "Map database schema" });
// Both return immediately, results steer back independently
```

## Install

```bash
pi install git:github.com/HazAT/pi-interactive-subagents
```

Supported multiplexers:

- [cmux](https://github.com/manaflow-ai/cmux)
- [tmux](https://github.com/tmux/tmux)
- [zellij](https://zellij.dev)
- [WezTerm](https://wezfurlong.org/wezterm/) (terminal emulator with built-in multiplexing)
- [Orca](https://github.com/stablyai/orca) (AI orchestrator with built-in terminal multiplexing)

Start pi inside one of them:

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm — no wrapper needed
# or
# open a local Orca worktree terminal, then run: pi
```

Optional: set `PI_SUBAGENT_MUX=cmux|tmux|zellij|wezterm|orca` to force a specific backend.

[Orca](https://github.com/stablyai/orca) is an AI orchestrator with a built-in terminal multiplexer. It runs CLI coding agents in worktree-scoped terminal tabs and supports split terminal panes. When Pi runs in a local Orca worktree terminal, each subagent opens in a new background terminal tab in the same worktree without taking focus.

Register Orca's bundled [`orca` CLI](https://www.onorca.dev/docs/cli/overview) under **Settings → General → Orca CLI**. Verify that `orca terminal read --help` lists `--screen`. To use another compatible Orca CLI executable, set `ORCA_CLI_COMMAND` to its command name or path.

If your shell startup is slow and subagent commands sometimes get dropped before the prompt is ready, set `PI_SUBAGENT_SHELL_READY_DELAY_MS` to a higher value (defaults to `500`):

```bash
export PI_SUBAGENT_SHELL_READY_DELAY_MS=2500
```

Subagent panes are created without stealing keyboard focus (cmux, tmux). Launch commands target child surfaces by explicit ID, so focus and command delivery are independent. Note: the `interactive` option controls parent status notifications, not terminal focus.

## What's Included

### Extensions

**Subagents** — 4 main-session tools + 3 commands, plus 1 subagent-only tool:

| Tool                 | Description                                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------- |
| `subagent`           | Spawn a sub-agent in a dedicated multiplexer pane (async — returns immediately)             |
| `subagent_interrupt` | Interrupt a running Pi-backed subagent's current turn                                       |
| `subagents_list`     | List available agent definitions                                                            |
| `subagent_resume`    | Resume a previous sub-agent session (async)                                                 |

| Command                    | Description                          |
| -------------------------- | ------------------------------------ |
| `/plan`                    | Start a full planning workflow       |
| `/iterate`                 | Fork into a subagent for quick fixes |
| `/subagent <agent> <task>` | Spawn a named agent directly         |

### Example agents

[`examples/agents/`](examples/agents/) contains starting points for your own roles. Choose the examples you want, install them in an active agent directory, then edit those copies. From the extension checkout, install the scout globally:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/agents"
mkdir -p "$agent_dir"
cp -i examples/agents/scout.md "$agent_dir/"
```

For one project, copy the selected files into its `.pi/agents/` directory instead. Definitions are read each time you list, complete, or launch an agent, so installing or editing them takes effect immediately.

| Agent             | Model                  | Role                                                                                     |
| ----------------- | ---------------------- | ---------------------------------------------------------------------------------------- |
| **planner**       | Opus (medium thinking) | Brainstorming — clarifies requirements, explores approaches, writes plans, creates todos |
| **scout**         | Haiku                  | Fast codebase reconnaissance — maps files, patterns, conventions                         |
| **worker**        | Sonnet                 | Implements tasks from todos — writes code, runs tests, makes polished commits            |
| **reviewer**      | Opus (medium thinking) | Reviews code for bugs, security issues, correctness                                      |
| **visual-tester** | Sonnet                 | Visual QA via Chrome CDP — screenshots, responsive testing, interaction testing          |

Configure access to each example's model or edit its `model` field. The planner expects `scout` and optionally `researcher` roles, the `todo` tool, a `write-todos` skill, and an `/answer` command. The worker expects `todo` and a `commit` skill. Supply those resources through your Pi configuration or adapt the copied instructions to your tools. The visual tester needs the `chrome-cdp` skill, its `scripts/cdp.mjs` executable, Chrome with remote debugging enabled, and the target page open in a tab. Run `npm run test:agent-examples` to check installation of the shipped definitions independently of the core tests.

---

## Async Subagent Flow

```
1. Agent calls subagent()          → returns immediately ("started")
2. Sub-agent runs in mux pane      → widget shows live status
3. User keeps chatting             → main session fully interactive
4. Sub-agent finishes              → result steered back as a normal completion/failure
5. Main agent processes result     → continues with new context
```

Multiple subagents run concurrently — each steers its result back independently as it finishes. The live widget above the input tracks all running agents:

```
╭─ Subagents ───────────────────────────────── 3 running ─╮
│ 01:23  Scout: Auth (scout)            active · write 7m │
│ 00:45  Researcher (researcher)               stalled 4m │
│ 00:12  Scout: DB (scout)                      starting… │
╰─────────────────────────────────────────────────────────╯
```

Completion messages render with a colored background and are expandable with `Ctrl+O` to show the full summary and session file path.

### Reopening a parent session

Started children keep running when their parent quits, changes session, or reloads. Open the original parent session to recover their monitoring and results. Answers completed while the parent was closed appear in its conversation without starting a model turn; a child that finishes after monitoring resumes sends its normal completion notification. PIS retains each execution's answer and checks the parent's recorded results before delivering it again.

Use each recovered child's original pane to interrupt or close it. Completed recovered panes can remain open, including idle autonomous Claude sessions. Close an existing Claude session before starting another CLI run with its `resumeSessionId`. A same-process `/reload` retains the existing pane controls.

An accepted launch that has not started can remain pending while its parent stays open. Reopening the parent cancels that pending launch and reports that it did not start. Started work continues; interrupted Pi sessions need an explicit `subagent_resume` request. A running or uncertain Pi execution blocks another resume of that child session, including through a symlink to the same file.

If you remove an unrecorded child notification from Pi's queue, its saved answer is recovered when you leave and reopen the parent session or restart Pi with that session. Reloading alone retains the current delivery attempt. Keep one writer per session file. When a CLI exits before saving its answer, PIS captures the eligible text when the parent observes that exit; another writer can change that text in the meantime. Monitoring follows the foreground CLI process; the terminal service controls whether that process survives closure.

When updating PIS, finish active children and reload each PIS-using parent before launching more children. Run `npm run test:restart-recovery` for isolated native-process checks with fake providers and terminals. Receipts and transcripts are written under `test/artifacts/restart-recovery/`.

Pi child stderr, including startup warnings and fatal errors, is written to a private file under the parent's session artifacts in `subagent-stderr/`. Launch acknowledgements include `stderrFile`, and failure messages include its path. Stdout remains connected to the interactive terminal. Check the stderr file when a child fails; review it for sensitive content before sharing it.

The task determines the final assistant response's content and format.

### In-progress status updates

The widget tracks each Pi-backed sub-agent from a child-written runtime snapshot and labels it with a coarse state:

- `starting` — launched, but no valid child snapshot has been observed yet
- `active` — the child is doing observed runtime work: agent turn, provider request, streaming, or tool execution
- `blocked`: an extension dialog needs input in the child's pane; the widget shows its title or dialog kind
- `waiting` — the child finished a turn and is intentionally open for more input or another stage
- `stalled` — the parent has gone too long without a valid current child snapshot and can no longer trust the run is healthy
- `running` — fallback for backends without child snapshots (e.g. Claude)

Each Pi-backed child writes an activity snapshot for the parent widget. A fixed internal watchdog marks a run as `stalled` when valid snapshots never appear, stop being readable, or stop matching the current child. Valid `active`, `blocked`, and `waiting` states remain healthy regardless of their duration. Entering `blocked` or `stalled`, or recovering from `stalled`, sends a status notification to the parent for non-interactive children. Other status transitions update the widget.

**Interactive subagents stay silent.** Long-running user-driven subagents update their widgets and activity snapshots while leaving the parent to its work. The `interactive` tool argument takes precedence over the definition's `interactive` field; otherwise, it defaults to the inverse of the effective `autoExit` setting. Set `interactive: true` to suppress status notifications or `false` to receive them.

Pi 1.1 also reports `working`, `blocked`, `done`, `error`, and `idle` to terminals and dashboards that support OSC 7501. Set `PI_PROGRAM_STATUS=1` to force those terminal reports or `0` to disable them; see [Pi's terminal setup guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/terminal-setup.md#program-status). PIS reads snapshots written by children to update its parent widget. Saved outcomes determine completion and recovery.

#### Configuration

Status display is controlled by `config.json` in the extension directory. Copy `config.json.example` to get started:

```bash
cp config.json.example config.json
```

```json
{
  "status": {
    "enabled": true
  }
}
```

`config.json` is gitignored so local overrides don't get committed.

---

## Spawning Subagents

```typescript
// After installing the named agent definitions
subagent({ name: "Scout", agent: "scout", task: "Analyze the codebase..." });

// Force a full-context fork for this spawn
subagent({ name: "Iterate", fork: true, task: "Fix the bug where..." });

// Agent defaults can choose a different session-mode via frontmatter
subagent({ name: "Planner", agent: "planner", task: "Work through the design with me" });

// Custom working directory
subagent({ name: "Designer", agent: "game-designer", cwd: "agents/game-designer", task: "..." });
```

### Parameters

| Parameter              | Type    | Default        | Description                                                                                       |
| ---------------------- | ------- | -------------- | ------------------------------------------------------------------------------------------------- |
| `name`                 | string  | required       | Display name (shown in widget and pane title)                                                     |
| `task`                 | string  | required       | Task prompt for the sub-agent                                                                     |
| `inputFiles`           | string[] | omitted       | Absolute file paths attached to the initial prompt through Pi's `@file` handling |
| `agent`                | string  | —              | Exact canonical name of an installed marked definition; omit for a bare launch |
| `fork`                 | boolean | `false`        | Force the full-context fork mode for this spawn, overriding any agent `session-mode` frontmatter  |
| `autoExit`             | boolean | derived        | Pi-backed sessions: override the definition's `auto-exit`; defaults to `false` for bare launches. Set `true` to exit and deliver the result after Pi settles. |
| `interactive`          | boolean | derived        | Suppress blocked/stall/recovery notifications when `true`. Defaults to the definition's `interactive` field, otherwise the inverse of effective `autoExit`. Controls notifications, not exit. |
| `model`                | string  | —              | Override agent's default model                                                                    |
| `thinking`             | string  | omitted        | Override agent's default thinking level, including `off` |
| `systemPrompt`         | string  | —              | Append to system prompt                                                                           |
| `skills`               | string  | —              | Comma-separated skill names                                                                       |
| `tools`                | string  | —              | Comma-separated tool names                                                                        |
| `cwd`                  | string  | —              | Working directory for the sub-agent (see [Role Folders](#role-folders))                           |

### Automatic completion

For a one-shot Pi child with no named role definition, set `autoExit: true`:

```typescript
subagent({
  name: "Review",
  task: "Review the attached source and return your findings.",
  inputFiles: ["/absolute/path/to/source.md"],
  autoExit: true,
});
```

The child exits after Pi settles and delivers its final answer automatically, including when the task prohibits tool calls. A cancelled run stays open for another prompt, as reported by Pi's settlement event. The launch acknowledgement reports the effective exit policy, and its details include `autoExit` for Pi-backed children. When automatic exit is disabled, a completed reply leaves the session open; `subagent_done` or session closure delivers its result. Setting `interactive: false` enables status notifications but does not enable exit.

The tool argument overrides a named definition's `auto-exit` in either direction, and it applies to Pi-backed models. Definitions that launch the standalone Claude CLI with `cli: claude` use their plugin's completion hook and reject the Pi-only `autoExit` argument.

### Launching by command

Use `/subagent <agent> [task]` to launch a named agent. Press Tab after `/subagent ` or a partial name to complete the agent name; matching is case-insensitive. Completions show descriptions and use project-over-global precedence. Agents with `disable-model-invocation: true` are available here for manual selection. Once you start typing the task, agent-name completion stops.

### Model and thinking selection

Agent definitions supply the initial model and thinking level. Tool arguments override these defaults. Pi resolves the model reference and clamps thinking to the model's supported levels.

The child treats its current selection as authoritative. Conflicting calls to Pi's extension model and thinking setters raise an error and record a `subagent-selection-rejected` entry in the session. Manual changes through `/model`, `/thinking`, and the native cycling shortcuts update the selection. Resuming a child restores its latest recorded selection.

The guard applies to Pi's extension setter API. Extensions execute inside the Pi process with its operating-system permissions.

Run `npm run test:model-guard` to test the installed Pi at `/opt/homebrew/bin/pi` with a local fake provider. The test checks startup, model requests, manual changes, reload, and resume. It writes a receipt and session transcript to `test/artifacts/model-guard/`.

The live integration suite uses `PI_TEST_MODEL` for parent sessions and generated child definitions, with `anthropic/claude-haiku-4-5` as the default. Set it before running `npm run test:integration` to choose another model. These tests make model calls and create terminals; `npm test` uses fake providers and CLI executables.

---

## Interrupting a running subagent

Use `subagent_interrupt` to cancel the active turn of a running Pi-backed subagent:

```typescript
subagent_interrupt({ id: "abcd1234" });
// or
subagent_interrupt({ name: "Scout" });
```

This sends Escape to the child pane, cancelling the in-progress model turn. The subagent session stays alive — the pane, session file, and background polling all remain intact. After the interrupt, the widget immediately moves the child back to `waiting`, and stale pre-interrupt snapshots are ignored. If the child starts work later, newer snapshots return it to `active`; completion, failure, and `caller_ping` still flow through normally.

After restarting Pi or leaving and reopening the parent session, use the child's original pane for interruption and closure.

> **Note:** Only Pi-backed subagents are supported. Claude-backed runs will return an error.

---

## caller_ping — Child-to-Parent Help Request

The `caller_ping` tool lets a subagent request help from its parent agent. When called, the child session **exits** and the parent receives a notification with the help message. The parent can then **resume** the child session with a response using `subagent_resume`.

**`caller_ping` parameters:**
- `message` (required): What you need help with

**`subagent_resume` parameters:**
- `sessionPath` (required): Path to the child session `.jsonl` file
- `name` (optional): Display name for the resumed pane (defaults to `Resume`)
- `message` (optional): Follow-up prompt to send after resuming
- `autoExit` (optional): Whether the resumed session should auto-exit after its next response. Defaults to `true` for autonomous follow-up work; set `false` when resuming for an interactive handoff.

Results use the session's selected conversation branch. For resumed children, the returned answer must have been added after resume; if the selected branch has no new answer, the parent receives the exit status instead.

For ordinary Pi-backed children, `subagent_resume` restores the recorded working directory, directory for agent configuration, file containing role instructions, and active tool selection. The operator's later tool selection takes precedence over the definition's initial selection. Keep the original directories and any generated system-prompt file available; missing required resources cause an error before a pane opens.

**Interaction flow:**
1. Child calls `caller_ping({ message: "Not sure which schema to use" })`
2. Child session exits (like `subagent_done`)
3. Parent receives a steer notification: *"Sub-agent Worker needs help: Not sure which schema to use"*
4. Parent resumes the child session via `subagent_resume` with the response
5. Child picks up where it left off with the parent's guidance

**Example:**
```typescript
// Inside a worker subagent
await caller_ping({
  message: "Found two conflicting migration files — should I use v1 or v2?"
});
// Session exits here. Parent receives the ping, then resumes this session
// with guidance like "Use v2, v1 is deprecated"
```

> **Note:** `caller_ping` is only available inside subagent contexts. Calling it from a standalone pi session returns an error.

---

## Optional workflow prompts

The Markdown templates in [`examples/prompts/`](examples/prompts/) provide planning and focused-work workflows. Install the ones you want, then edit their instructions and names. From the extension checkout, install them for use across projects:

```bash
prompt_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/prompts"
mkdir -p "$prompt_dir"
cp -i examples/prompts/plan.md examples/prompts/iterate.md "$prompt_dir/"
```

For one project, copy the selected files into that project's `.pi/prompts/` directory instead. Run `/reload` in an active Pi session after installing or editing templates. Project templates load after you trust the project in Pi.

```text
/plan Add a dark mode toggle to the settings page
/iterate Fix the off-by-one error in the pagination logic
```

The planning example uses marked, user-installed `scout`, `planner`, `worker`, and `reviewer` definitions and the `todo` tool. Install those roles or edit the names to match your definitions. The planner can also use a `researcher` role for external research. It gathers context, creates a plan with the user, then coordinates implementation and review.

The `iterate.md` template sets `fork: true` to give the child the current conversation and leaves it open for user interaction. Its task argument is optional. Close the child or call `subagent_done` when you want to return its results to the parent.

The filename defines the command name: copy `iterate.md` as `focus.md` to invoke it with `/focus`. Remove an installed file and run `/reload` to remove that command. You can also write your own `plan.md` or `iterate.md`.

---

## Custom Agents

Place a `.md` file in `.pi/agents/` under the current working directory (project) or `<agent-dir>/agents/` (global). The global root is `PI_CODING_AGENT_DIR`, defaulting to `~/.pi/agent`. Add the exact scalar frontmatter value `extension: pi-interactive-subagents` to each definition you want Pi Interactive Subagents (PIS) to use. Valid files with another value or no marker belong outside PIS discovery; other extensions can share these directories and apply their own rules.

```markdown
---
extension: pi-interactive-subagents
name: my-agent
description: Does something specific
model: anthropic/claude-sonnet-4-6
thinking: minimal
tools: read, bash, edit, write
session-mode: lineage-only
spawning: false
---

# My Agent

You are a specialized agent that does X...
```

The canonical agent name is the frontmatter `name`, or the filename without `.md` when `name` is omitted. Names are nonempty tokens with no whitespace. Invocation uses the exact name, including case; completion matches prefixes case-insensitively. A file named `role.md` with `name: my-agent` is invoked as `my-agent`.

A marked project definition replaces the entire global definition with the same canonical name. Duplicate names within one directory are errors. Add the marker and move any definitions you keep in the extension's `agents/` directory into an active directory to use them.

Malformed frontmatter, invalid marked fields, and unreadable definitions stop listing, completion, and named launches across both directories. Submission errors identify the file to correct; unavailable names report the searched directories. This includes malformed files belonging to other extensions because their marker cannot be parsed. Correct the file and repeat the operation. An unavailable explicit name, including an empty string, fails before a child is created; omit `agent` to launch a bare child.

### Frontmatter Reference

Use YAML scalar values for the fields below. Null values, arrays, and mappings produce errors in marked definitions. Leave optional fields out to use launch defaults, and quote strings containing YAML punctuation, such as `model: "provider/model # literal"`.

| Field         | Type    | Description                                                                                                                                                                                                                                                                 |
| ------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `extension` | string | Required exact value: `pi-interactive-subagents` |
| `name` | scalar | Canonical invocation name; defaults to the filename stem |
| `description` | string  | Shown in `subagents_list` output                                                                                                                                                                                                                                            |
| `model`       | string  | Default model (e.g. `anthropic/claude-sonnet-4-6`)                                                                                                                                                                                                                          |
| `thinking`    | string  | Explicit thinking level, including `off`; passed through `--thinking` so it overrides a model suffix |
| `system-prompt` | string | `append` adds the definition body to the system prompt; `replace` replaces the default preamble. Context files and appendices are separate resources. |
| `profile` | string | `conversation` runs a fresh, tool-free Pi session with only the supplied role instructions and input |
| `tools` | string | Initial comma-separated tool selection for Pi-backed sessions; completion controls are included |
| `skills`      | string  | Comma-separated skill names to auto-load                                                                                                                                                                                                                                    |
| `session-mode` | string | Default child-session mode: `standalone`, `lineage-only`, or `fork` |
| `spawning` | boolean | Set `false` to disable all subagent lifecycle tools initially |
| `deny-tools` | string | Comma-separated tool names to disable initially |
| `auto-exit`   | boolean | Pi-backed sessions: exit after Pi settles and deliver the result automatically. Overridden by the tool's `autoExit` argument. Interrupted turns stay open. Also determines the derived `interactive` default. |
| `interactive` | boolean | derived        | Override whether blocked/stall/recovery transitions wake the parent session. Defaults to the inverse of `auto-exit`: autonomous agents (`auto-exit: true`) are non-interactive and receive status notifications; agents without `auto-exit` are interactive and stay quiet. Explicit values take precedence. |
| `cwd`         | string  | Default working directory (absolute or relative to project root)                                                                                                                                                                                                            |
| `disable-model-invocation` | boolean | Hide this agent from model-facing discovery such as `subagents_list`. It remains available by explicit name and in manual `/subagent` completion. |

---

Discovery resolves precedence before visibility filtering. If a hidden project agent has the same canonical name as a visible global agent, the hidden project agent wins. It remains available through manual completion and explicit invocation.

### `session-mode`

Choose how a subagent session starts:

- `standalone` — default fresh session with no lineage link to the caller
- `lineage-only` — fresh blank child session with `parentSession` linkage, but no copied turns from the caller
- `fork` — linked child session seeded with the caller's prior conversation context

`lineage-only` is useful when you want session discovery and fork lineage UX to show the relationship later, but you do **not** want the child to inherit the parent's turns.

`fork: true` on the tool call always forces the `fork` mode for that specific spawn. The optional iterate template uses this override.

```yaml
---
name: planner
session-mode: lineage-only
---
```

### Conversation profile

Use `profile: conversation` for a model that should answer from supplied text rather than operate tools. It requires an explicit model, a nonempty definition body, and `system-prompt: replace`. Use `standalone` or `lineage-only`; conversation forks, skill prompts, tool overrides, and the Claude CLI launch path are rejected.

```yaml
---
name: analyst
model: example/text-model
thinking: off
profile: conversation
system-prompt: replace
session-mode: lineage-only
auto-exit: true
---
Analyze the supplied material and return your complete answer directly.
```

The profile disables tool declarations and discovery of context files, skills, prompt templates, and other extensions. It also suppresses `APPEND_SYSTEM.md`. The lifecycle extension still records progress and completion, but its tools are disabled. Pi retains working-directory metadata; the definition supplies the role instructions. Providers configured through Pi's model configuration remain available; providers that require another extension are not loaded by this profile.

Pass source documents using `inputFiles`, not paths that the model would need a tool to read. The parent receives the answer through the usual completion result, and the full text remains in the session transcript. The caller owns any separate output-file export. Resuming through `subagent_resume` restores the recorded model, thinking level, configuration directory, working directory, and system-prompt file together with the conversation restrictions. Keep that system-prompt file while the session may be resumed; a missing file is an error.

### `auto-exit`

The `auto-exit` definition field determines whether Pi-backed children exit automatically; the tool's `autoExit` argument overrides it. With automatic exit disabled, children stay open after a response. Write role and completion instructions in the body of your agent definition or the task you pass to `subagent`. You can continue the conversation in the child's pane, use `subagent_done` to return its results, or close the session manually.

When set to `true`, the agent session shuts down automatically after Pi finishes the run, including automatic recovery and queued work. Auto-exit requires a Pi runtime that emits `agent_settled`.

**Behavior:**

- The session closes on `agent_settled`, after the final response
- Provider failures and output-token-limit truncation are reported to the parent as errors; partial responses remain in the session transcript
- Interrupting a turn leaves the session open for inspection or resumption; a later completed turn can still auto-exit

**When to use:**

- ✅ Autonomous agents (scout, worker, reviewer) that run to completion
- ❌ Interactive agents (planner, iterate) where the user drives the session

```yaml
---
name: scout
auto-exit: true
---
```

### `interactive`

Controls whether status transitions (`blocked`, `stalled`, `recovered`) wake the parent session with a steer message.

**Default:** the definition's explicit `interactive` field, otherwise the inverse of the effective exit policy. A bare launch defaults to interactive unless `autoExit: true` is supplied. The tool's `interactive` argument overrides these defaults and controls notifications about blocked dialogs, stalls, and recovery.

**Why it exists:** Interactive agents can run for minutes or hours while the user thinks, types, and reads in the subagent's pane. The widget shows their status; completion and help requests notify the parent.

**When to override:**

- Set `interactive: false` on an agent that doesn't auto-exit but needs parent attention for blocked dialogs or stalls
- Set `interactive: true` on an autonomous agent you'd rather check on yourself

```yaml
---
name: planner
# interactive defaults to true because auto-exit is not set
---
```

Or per spawn:

```typescript
subagent({ name: "Scout", agent: "scout", interactive: true, task: "..." });
```

---

## Tool Access Control

By default, every sub-agent can spawn further sub-agents. Control this with frontmatter:

For Pi-backed children, these fields choose the initial active tools. The operator can enable or disable tools within the child session using a tool-selection control provided by an extension. PIS saves those selections immediately and restores them on resume. The active selection is also saved when the child quits or reloads.

### `spawning: false`

Initially disables all subagent lifecycle tools (`subagent`, `subagent_interrupt`, `subagents_list`, `subagent_resume`):

```yaml
---
name: worker
spawning: false
---
```

### `deny-tools`

Fine-grained control over individual extension tools:

```yaml
---
name: focused-agent
deny-tools: subagent
---
```

### Recommended Configuration

| Agent      | `spawning`  | Rationale                                    |
| ---------- | ----------- | -------------------------------------------- |
| planner    | _(default)_ | Legitimately spawns scouts for investigation |
| worker     | `false`     | Should implement tasks, not delegate         |
| researcher | `false`     | Should research, not spawn                   |
| reviewer   | `false`     | Should review, not spawn                     |
| scout      | `false`     | Should gather context, not spawn             |

---

## Role Folders

The `cwd` parameter lets sub-agents start in a specific directory with its own configuration:

```
project/
├── agents/
│   ├── game-designer/
│   │   └── CLAUDE.md          ← "You are a game designer..."
│   ├── sre/
│   │   ├── CLAUDE.md          ← "You are an SRE specialist..."
│   │   └── .pi/skills/        ← SRE-specific skills
│   └── narrative/
│       └── CLAUDE.md          ← "You are a narrative designer..."
```

```typescript
subagent({ name: "Game Designer", cwd: "agents/game-designer", task: "Design the combat system" });
subagent({ name: "SRE", cwd: "agents/sre", task: "Review deployment pipeline" });
```

Set a default `cwd` in agent frontmatter:

```yaml
---
name: game-designer
cwd: ./agents/game-designer
spawning: false
---
```

---

## Tools Widget

Every sub-agent session displays a compact tools widget showing available and denied tools. Toggle with `Ctrl+J`:

```
[scout] — 12 tools · 4 denied  (Ctrl+J)              ← collapsed
[scout] — 12 available  (Ctrl+J to collapse)          ← expanded
  read, bash, edit, write, todo, ...
  denied: subagent, subagents_list, ...
```

---

## Requirements

- [Pi 1.1.0 or newer](https://github.com/earendil-works/pi), the coding agent
- One supported multiplexer:
  - [cmux](https://github.com/manaflow-ai/cmux)
  - [tmux](https://github.com/tmux/tmux)
  - [zellij](https://zellij.dev)
  - [WezTerm](https://wezfurlong.org/wezterm/)
  - [Orca](https://github.com/stablyai/orca) (AI orchestrator with built-in terminal multiplexing)

```bash
cmux pi
# or
tmux new -A -s pi 'pi'
# or
zellij --session pi   # then run: pi
# or
# just run pi inside WezTerm
# or
# open a local Orca worktree terminal, then run: pi
```

Optional backend override:

```bash
export PI_SUBAGENT_MUX=cmux   # or tmux, zellij, wezterm, orca
```

---

## Acknowledgements

The sub-agent status supervision and turn-only interruption features were inspired by [RepoPrompt](https://repoprompt.com/)'s sub-agent snapshot polling and run cancellation features.

---

## License

MIT
