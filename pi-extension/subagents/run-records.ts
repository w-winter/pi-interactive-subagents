import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, linkSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import { findLastAssistantMessage, findLatestAssistantError, getBranchEntries, getNewEntries } from "./session.ts";

const Id = Type.String({ minLength: 1 });
const Timestamp = Type.Number({ minimum: 0 });
const Path = Type.String({ minLength: 1 });
const NullablePath = Type.Union([Path, Type.Null()]);
const PiFields = {
  sessionFile: Path, activityFile: NullablePath, stderrFile: NullablePath, autoExit: Type.Boolean(),
};
const OwnerSchema = Type.Object({ sessionId: Id, sessionFile: Path });
const RunSchema = Type.Object({
  id: Id, name: Type.String(), task: Type.String(), agent: Type.Union([Type.String(), Type.Null()]),
  startTime: Timestamp, interactive: Type.Boolean(), owner: OwnerSchema, runDir: Path,
  launch: Type.Union([
    Type.Object({ kind: Type.Literal("pi-fresh"), ...PiFields }),
    Type.Object({ kind: Type.Literal("pi-resume"), ...PiFields, entryCountBefore: Type.Integer({ minimum: 0 }) }),
    Type.Object({ kind: Type.Literal("claude") }),
  ]),
});
const ContextSchema = Type.Union([
  Type.Object({ cli: Type.Literal("pi"), runDir: Path, outputAfter: Type.Integer({ minimum: 0 }) }),
  Type.Object({ cli: Type.Literal("claude"), runDir: Path }),
]);
const ActorSchema = Type.Object({ pid: Type.Integer({ minimum: 1 }), started: Id });
const ClaimSchema = Type.Union([
  Type.Object({ kind: Type.Literal("claimed"), id: Id, executor: ActorSchema, supervisor: ActorSchema }),
  Type.Object({ kind: Type.Literal("not_started"), id: Id, observedAt: Timestamp,
    cause: Type.Union([Type.Literal("dispatch_failed"), Type.Literal("reopened"), Type.Literal("operator_close"), Type.Literal("bootstrap_failed")]) }),
]);
const OutputSchema = Type.Union([
  Type.Object({ cli: Type.Literal("pi"), text: Type.Union([Type.String(), Type.Null()]) }),
  Type.Object({ cli: Type.Literal("claude"), text: Type.Union([Type.String(), Type.Null()]), transcriptPath: NullablePath }),
]);
const OutcomeFields = { id: Id, recordedAt: Timestamp };
const OutcomeSchema = Type.Union([
  Type.Object({ ...OutcomeFields, reason: Type.Union([Type.Literal("done"), Type.Literal("quit")]), output: OutputSchema }),
  Type.Object({ ...OutcomeFields, reason: Type.Literal("ping"), name: Type.String(), message: Type.String() }),
  Type.Object({ ...OutcomeFields, reason: Type.Literal("error"), errorMessage: Type.String(),
    stopReason: Type.Union([Type.Literal("error"), Type.Literal("length")]) }),
  Type.Object({ ...OutcomeFields, reason: Type.Literal("sentinel"), exitCode: Type.Integer({ minimum: 0 }), output: OutputSchema }),
  Type.Object({ ...OutcomeFields, reason: Type.Literal("interrupted"), output: OutputSchema }),
]);
const ExitSchema = Type.Object({ id: Id, exitCode: Type.Integer({ minimum: 0 }), exitedAt: Timestamp, supervisor: ActorSchema });
const ResponseSchema = Type.Object({ id: Id, text: Type.String(), transcriptPath: Path });
const FileErrorSchema = Type.Object({ code: Type.String() });

export type ParentIdentity = Static<typeof OwnerSchema>;
export type RunRecord = Static<typeof RunSchema>;
export type RunContext =
  | { cli: "pi"; runDir: string; outputAfter: number; id: string; sessionFile: string }
  | { cli: "claude"; runDir: string; id: string };
export type ProcessClaim = Static<typeof ClaimSchema>;
export type ProcessActor = Static<typeof ActorSchema>;
export type RunOutcome = Static<typeof OutcomeSchema>;
export type CapturedOutput = Static<typeof OutputSchema>;
type ParentRunHistory = { runs: RunRecord[]; recorded: Set<string> };
export type CancelCause = Extract<ProcessClaim, { kind: "not_started" }>['cause'];
export const RUN_ENTRY_TYPE = "subagent-run";

function requireAbsolute(path: string): void {
  if (!isAbsolute(path)) throw new Error(`Subagent artifact path must be absolute: ${path}`);
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Filesystem exceptions are untyped until their errno is parsed here.
function errorCode(error: unknown): string | null {
  if (error instanceof Error && Value.Check(FileErrorSchema, error)) return error.code;
  return null;
}
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- This schema parser establishes the contract of persisted JSON.
function decode<T extends TSchema>(schema: T, value: unknown, path: string): Static<T> {
  if (!Value.Check(schema, value)) {
    const issue = Value.Errors(schema, value)[Symbol.iterator]().next().value;
    throw new Error(`Invalid subagent artifact ${path}: ${issue?.path}: ${issue?.message}`);
  }
  return value;
}
function readFact<T extends TSchema>(run: Pick<RunRecord, "id" | "runDir">, file: string, schema: T): Static<T> | null {
  const path = join(run.runDir, file);
  let text: string;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if (errorCode(error) === "ENOENT") return null; throw error; }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch (cause) {
    const diagnostic = new Error(`Invalid subagent JSON: ${path}`, { cause });
    throw diagnostic;
  }
  const value = decode(schema, data, path);
  const identity = decode(Type.Object({ id: Id }), data, path);
  if (identity.id !== run.id) throw new Error(`Wrong subagent identity in ${path}`);
  return value;
}

/** Publish a complete immutable fact. A collision returns the validated original winner. */
function publish<T extends TSchema>(run: Pick<RunRecord, "id" | "runDir">, file: string, schema: T, value: Static<T>): Static<T> {
  decode(schema, value, file);
  const path = join(run.runDir, file);
  const temporary = join(run.runDir, `.${file}.${randomUUID()}.tmp`);
  writeFileSync(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  try {
    try { linkSync(temporary, path); }
    catch (error) { if (errorCode(error) !== "EEXIST") throw error; }
    const winner = readFact(run, file, schema);
    if (!winner) throw new Error(`Subagent publication disappeared: ${path}`);
    return winner;
  } finally { unlinkSync(temporary); }
}

/** Parse the single managed context; identity and Pi session path remain in their existing variables. */
export function readRunContext(): RunContext | null {
  const text = process.env.PI_SUBAGENT_RUN;
  if (!text) {
    if (process.env.PI_SUBAGENT_SESSION) throw new Error("Managed subagent requires PI_SUBAGENT_RUN");
    return null;
  }
  let data: unknown;
  try { data = JSON.parse(text); }
  catch (cause) {
    const diagnostic = new Error("Invalid PI_SUBAGENT_RUN JSON", { cause });
    throw diagnostic;
  }
  const context = decode(ContextSchema, data, "PI_SUBAGENT_RUN");
  requireAbsolute(context.runDir);
  const id = process.env.PI_SUBAGENT_ID;
  if (!id) throw new Error("Managed subagent requires PI_SUBAGENT_ID");
  if (context.cli === "pi") {
    const path = process.env.PI_SUBAGENT_SESSION;
    if (!path) throw new Error("Managed Pi subagent requires PI_SUBAGENT_SESSION");
    requireAbsolute(path);
    return { ...context, id, sessionFile: path };
  }
  return { ...context, id };
}

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Native custom-entry payloads are unstructured until RunSchema accepts them.
export function decodeRun(data: unknown): RunRecord {
  const run = decode(RunSchema, data, RUN_ENTRY_TYPE);
  requireAbsolute(run.runDir); requireAbsolute(run.owner.sessionFile);
  if (run.launch.kind !== "claude") {
    requireAbsolute(run.launch.sessionFile);
    for (const path of [run.launch.activityFile, run.launch.stderrFile]) if (path !== null) requireAbsolute(path);
  }
  return run;
}

/** Session-wide owned executions and native recording receipts, including abandoned parent branches. */
// oxlint-disable-next-line sonarjs/cognitive-complexity -- One physical pass joins owned launches and recording receipts across branches.
export function readParentRuns(owner: ParentIdentity): ParentRunHistory {
  const runs = new Map<string, RunRecord>();
  const recorded = new Set<string>();
  if (!existsSync(owner.sessionFile)) return { runs: [], recorded };
  const Owned = Type.Object({ owner: OwnerSchema });
  const Receipt = Type.Object({ id: Id, parentSessionId: Id, parentSessionFile: Path });
  let entries: ReturnType<typeof getNewEntries>;
  try { entries = getNewEntries(owner.sessionFile, 0); }
  catch (cause) {
    const diagnostic = new Error(`Cannot read subagent parent history: ${owner.sessionFile}`, { cause });
    throw diagnostic;
  }
  for (const entry of entries) {
    if (entry.type === "custom" && entry.customType === RUN_ENTRY_TYPE) {
      const binding = decode(Owned, entry.data, entry.id);
      if (binding.owner.sessionId !== owner.sessionId || binding.owner.sessionFile !== owner.sessionFile) continue;
      const run = decodeRun(entry.data);
      if (runs.has(run.id)) throw new Error(`Duplicate subagent run id: ${run.id}`);
      runs.set(run.id, run);
    }
    if (entry.type === "custom_message" && (entry.customType === "subagent_result" || entry.customType === "subagent_ping") && Value.Check(Receipt, entry.details)) {
      if (entry.details.parentSessionId === owner.sessionId && entry.details.parentSessionFile === owner.sessionFile) recorded.add(entry.details.id);
    }
  }
  return { runs: [...runs.values()], recorded };
}

export function readClaim(run: RunRecord): ProcessClaim | null { return readFact(run, "process.json", ClaimSchema); }
export function publishProcessClaim(run: Pick<RunRecord, "id" | "runDir">, claim: ProcessClaim): ProcessClaim {
  return publish(run, "process.json", ClaimSchema, claim);
}
export function cancelUnstarted(run: RunRecord, cause: CancelCause): ProcessClaim {
  return publishProcessClaim(run, { kind: "not_started", id: run.id, observedAt: Date.now(), cause });
}
export function readOutcome(run: Pick<RunRecord, "id" | "runDir">): RunOutcome | null { return readFact(run, "completion.json", OutcomeSchema); }
export function publishOutcome(run: Pick<RunRecord, "id" | "runDir">, outcome: RunOutcome): RunOutcome {
  return publish(run, "completion.json", OutcomeSchema, outcome);
}
export function readShellExit(run: RunRecord) { return readFact(run, "shell-exit.json", ExitSchema); }
export function captureOutput(run: Pick<RunRecord, "id" | "runDir" | "launch">): CapturedOutput {
  if (run.launch.kind === "claude") {
    const response = readFact(run, "response.json", ResponseSchema);
    if (response) requireAbsolute(response.transcriptPath);
    return { cli: "claude", text: response?.text ?? null, transcriptPath: response?.transcriptPath ?? null };
  }
  const after = run.launch.kind === "pi-resume" ? run.launch.entryCountBefore : 0;
  if (!existsSync(run.launch.sessionFile)) return { cli: "pi", text: null };
  return { cli: "pi", text: findLastAssistantMessage(getBranchEntries(run.launch.sessionFile, after)) };
}

export type ActorState = "live" | "gone";
/** Failed queries throw; only definite loss or reuse is gone. Stopped actors remain live. */
export function observeActor(actor: ProcessActor): ActorState {
  let output: string;
  try {
    output = execFileSync("/bin/ps", ["-p", String(actor.pid), "-o", "lstart=", "-o", "stat="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", TZ: "UTC" }, stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    if (error instanceof Error && "status" in error && error.status === 1 && "stdout" in error && error.stdout === "" && "stderr" in error && error.stderr === "") return "gone";
    throw new Error(`Subagent process query unavailable for PID ${actor.pid}`, { cause: error });
  }
  const match = output.trim().match(/^(.{24})\s+(\S+)$/);
  if (!match) throw new Error(`Unparseable subagent process identity for PID ${actor.pid}`);
  return match[1].trim() === actor.started && !match[2].startsWith("Z") ? "live" : "gone";
}

/** Freeze a shell-only outcome through the same selected-branch/error contracts as child settlement. */
export function captureShellOutcome(run: RunRecord): RunOutcome | null {
  const claim = readClaim(run);
  if (!claim || claim.kind === "not_started") return null;
  const shell = readShellExit(run);
  if (!shell) return null;
  if (shell.supervisor.pid !== claim.supervisor.pid || shell.supervisor.started !== claim.supervisor.started) {
    throw new Error(`Wrong supervisor in subagent shell receipt: ${run.runDir}`);
  }
  if (run.launch.kind !== "claude" && existsSync(run.launch.sessionFile)) {
    const after = run.launch.kind === "pi-resume" ? run.launch.entryCountBefore : 0;
    const messages = getBranchEntries(run.launch.sessionFile, after).filter((entry) => entry.type === "message").map((entry) => entry.message);
    const error = findLatestAssistantError(messages);
    if (error) return publishOutcome(run, { id: run.id, recordedAt: shell.exitedAt, reason: "error", ...error });
  }
  return publishOutcome(run, { id: run.id, recordedAt: shell.exitedAt, reason: "sentinel", exitCode: shell.exitCode, output: captureOutput(run) });
}
