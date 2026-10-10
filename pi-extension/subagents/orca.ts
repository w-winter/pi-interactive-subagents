import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";

const execFileAsync = promisify(execFile);
const Handle = Type.String({ minLength: 1 });
const Parent = Type.Object({ terminal: Type.Object({ worktreeId: Handle, executionHostId: Type.Literal("local") }) });
const Created = Type.Object({ terminal: Type.Object({ handle: Handle, surface: Type.String() }) });
const Sent = Type.Object({ send: Type.Object({ accepted: Type.Boolean() }) });
const Screen = Type.Object({ terminal: Type.Object({ source: Type.Literal("screen"), tail: Type.Array(Type.String()) }) });
const Lifecycle = Type.Object({ terminal: Type.Object({
  exitCause: Type.Optional(Type.Object({ kind: Type.Union([
    Type.Literal("operator_close"), Type.Literal("exited"), Type.Literal("signaled"), Type.Literal("unknown"),
  ]) })),
}) });

/** Target the current Orca runtime: honor `ORCA_CLI_COMMAND`, use `orca-dev` in a development session, and otherwise use `orca`. */
export function cliCommand(): string {
  if (process.env.ORCA_CLI_COMMAND) return process.env.ORCA_CLI_COMMAND;
  if (process.env.ORCA_DEV_REPO_ROOT) return "orca-dev";
  return "orca";
}

function currentHandle(): string {
  const handle = process.env.ORCA_TERMINAL_HANDLE;
  if (!handle) throw new Error("ORCA_TERMINAL_HANDLE not set");
  return handle;
}

function decode<T extends TSchema>(output: string, schema: T): Static<T> {
  const envelope = Type.Object({ ok: Type.Literal(true), result: Type.Unknown() });
  const value: unknown = JSON.parse(output);
  if (!Value.Check(envelope, value)) {
    const issues = [...Value.Errors(envelope, value)].map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Orca returned an unsuccessful or unexpected response: ${issues}`);
  }
  const result = value.result;
  if (!Value.Check(schema, result)) {
    const issues = [...Value.Errors(schema, result)].map((issue) => `${issue.path}: ${issue.message}`).join("; ");
    throw new Error(`Orca returned an unexpected result: ${issues}`);
  }
  return result;
}

function call<T extends TSchema>(args: string[], schema: T): Static<T> {
  return decode(execFileSync(cliCommand(), ["terminal", ...args, "--json"], { encoding: "utf8" }), schema);
}

async function callAsync<T extends TSchema>(args: string[], schema: T): Promise<Static<T>> {
  const { stdout } = await execFileAsync(cliCommand(), ["terminal", ...args, "--json"], { encoding: "utf8" });
  return decode(stdout, schema);
}

/** Create a visible terminal tab in the caller's local worktree without taking focus. */
export function createTab(name: string): string {
  const parent = call(["show", "--terminal", currentHandle()], Parent).terminal;
  const child = call(["create", "--worktree", `id:${parent.worktreeId}`, "--title", name], Created).terminal;
  if (child.surface !== "visible") {
    closeTab(child.handle);
    throw new Error("Orca could not create a visible subagent tab.");
  }
  return child.handle;
}

export function renameTab(title: string): void {
  call(["rename", "--terminal", currentHandle(), "--title", title], Type.Object({}));
}

export function sendCommand(handle: string, command: string): void {
  const result = call(["send", "--terminal", handle, "--text", command, "--enter"], Sent);
  if (!result.send.accepted) throw new Error("Orca returned explicit input rejection");
}

/** Send Escape without Enter to interrupt the current Pi turn. */
export function sendEscape(handle: string): void {
  const result = call(["send", "--terminal", handle, "--text", "\u001b"], Sent);
  if (!result.send.accepted) throw new Error("Orca returned explicit Escape rejection");
}

export function readScreen(handle: string, lines: number): string {
  return call(["read", "--terminal", handle, "--screen", "--limit", String(lines)], Screen).terminal.tail.join("\n");
}

export async function readScreenAsync(handle: string, lines: number): Promise<string> {
  const result = await callAsync(["read", "--terminal", handle, "--screen", "--limit", String(lines)], Screen);
  return result.terminal.tail.join("\n");
}

/** True only when Orca confirms an operator-requested close; query failures reject. */
export async function isTabClosed(handle: string): Promise<boolean> {
  const result = await callAsync(["show", "--terminal", handle], Lifecycle);
  return result.terminal.exitCause?.kind === "operator_close";
}

/** Close the addressed pane, leaving sibling splits open; an operator-closed pane needs no further close. */
export function closeTab(handle: string): void {
  const result = call(["show", "--terminal", handle], Lifecycle);
  if (result.terminal.exitCause?.kind === "operator_close") return;
  call(["close", "--terminal", handle], Type.Object({}));
}
