import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { existsSync, realpathSync } from "node:fs";
import {
  cancelUnstarted, observeActor, readClaim, readParentRuns, RUN_ENTRY_TYPE,
  type ParentIdentity, type RunRecord, type RunOutcome,
} from "./run-records.ts";
import { observeRun, pollForExit } from "./completion.ts";

export interface RecoveredChild {
  record: RunRecord;
  control: "current" | "recovered";
}
export interface ParentRunState<T extends RecoveredChild> {
  agents: Map<string, T>;
  records: Map<string, RunRecord>;
  submitted: Set<string>;
  owner: ParentIdentity | null;
}
type RecoveryCallbacks<T extends RecoveredChild> = {
  restore: (record: RunRecord) => T;
  message: (running: T, outcome: RunOutcome) => Parameters<ExtensionAPI["sendMessage"]>[0];
  update: (running: T) => void;
  cleanup: (running: T) => void;
  operatorClosed: (running: T) => (() => Promise<boolean>) | null;
};
const CHILD_POLL_INTERVAL_MS = 1000;

/** Own observation/submission for one parent API lifetime; shared state contains data only. */
export class ParentRunObserver<T extends RecoveredChild> {
  private readonly abort = new AbortController();
  private readonly observers = new Map<string, Promise<void>>();
  private closed = false;

  private readonly pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">;
  private readonly state: ParentRunState<T>;
  private readonly callbacks: RecoveryCallbacks<T>;
  constructor(pi: Pick<ExtensionAPI, "sendMessage" | "appendEntry">,
    state: ParentRunState<T>, callbacks: RecoveryCallbacks<T>) {
    this.pi = pi; this.state = state; this.callbacks = callbacks;
  }

  // oxlint-disable-next-line sonarjs/cognitive-complexity -- Ownership projection and observer attachment must finish before readiness is published.
  async start(ctx: ExtensionContext, reason: string): Promise<void> {
    try {
      const file = ctx.sessionManager.getSessionFile();
      const owner = file && existsSync(file) ? { sessionId: ctx.sessionManager.getSessionId(), sessionFile: realpathSync(file) } : null;
      const retained = reason === "reload" && owner !== null && owner.sessionId === this.state.owner?.sessionId && owner.sessionFile === this.state.owner.sessionFile;
      const counts = { recovered: 0, recorded: 0, cancelled: 0, unavailable: 0 };
      if (!retained) {
        this.state.agents.clear(); this.state.records.clear(); this.state.submitted.clear();
        this.state.owner = null;
        if (owner) {
          const history = readParentRuns(owner);
          for (const record of history.runs) this.state.records.set(record.id, record);
          for (const record of history.runs) {
            if (history.recorded.has(record.id)) { counts.recorded++; continue; }
            const running = this.callbacks.restore(record);
            this.state.agents.set(record.id, running);
            counts.recovered++;
          }
        }
      }
      let initializing = true;
      for (const running of this.state.agents.values()) this.observe(running, () => initializing,
        () => { if (initializing) counts.unavailable++; }, () => { if (initializing) counts.cancelled++; });
      // Finish immediate outcome continuations before retaining ownership across reload.
      await Promise.resolve();
      initializing = false;
      this.requireOpen();
      this.state.owner = owner;
      if (counts.recovered || counts.recorded) console.info(`[subagents:recovery] ${JSON.stringify({ event: "initialized", ...owner, ...counts })}`);
    } catch (error) {
      this.state.owner = null;
      const diagnostic = error instanceof Error ? error : new Error(String(error));
      console.error(`[subagents:recovery] ${JSON.stringify({ event: "initialization_failed", error: diagnostic.message })}`);
      throw diagnostic;
    }
  }

  requireOpen(): void {
    if (this.closed) throw new Error("Subagent parent runtime has closed");
  }

  recordLaunch(record: RunRecord): void {
    this.requireOpen();
    const previous = this.state.owner;
    if (previous && (previous.sessionId !== record.owner.sessionId || previous.sessionFile !== record.owner.sessionFile)) {
      throw new Error("Subagent launch belongs to another parent session");
    }
    this.state.owner = record.owner;
    this.pi.appendEntry(RUN_ENTRY_TYPE, record);
    this.state.records.set(record.id, record);
  }

  trackCurrent(running: T): void {
    this.requireOpen();
    this.state.agents.set(running.record.id, running);
    this.observe(running, () => false, () => {}, () => {});
  }

  resolveResumeAvailability(path: string): string | null {
    this.requireOpen();
    for (const record of this.state.records.values()) {
      if (record.launch.kind === "claude" || record.launch.sessionFile !== path) continue;
      const claim = readClaim(record);
      if (!claim) return "session is already running or awaiting its launch claim";
      if (claim.kind === "not_started") continue;
      if (observeActor(claim.executor) === "live" || observeActor(claim.supervisor) === "live") return "session is already running";
      observeRun(record);
    }
    return null;
  }

  private observe(running: T, duringStartup: () => boolean, onUnavailable: () => void, onCancelled: () => void): void {
    if (this.observers.has(running.record.id)) return;
    const work = pollForExit(running.record, this.abort.signal, {
      interval: CHILD_POLL_INTERVAL_MS, onTick: () => this.callbacks.update(running),
      onUnavailable,
      claimMissing: running.control === "recovered" ? () => {
        const claim = cancelUnstarted(running.record, "reopened");
        if (claim.kind === "not_started") onCancelled();
        return claim;
      } : null,
      operatorClosed: this.callbacks.operatorClosed(running),
    }).then((result) => { if (!this.closed) this.finish(running, result, duringStartup()); })
      .catch((error) => {
        if (!this.closed) console.warn(`[subagents:recovery] ${JSON.stringify({ id: running.record.id, event: "unavailable", error: error instanceof Error ? error.message : "Error" })}`);
      }).finally(() => { this.observers.delete(running.record.id); });
    this.observers.set(running.record.id, work);
  }

  private finish(running: T, result: Exclude<ReturnType<typeof observeRun>, { kind: "pending" }>, startup: boolean): void {
    if (this.closed) return;
    if (result.kind === "outcome" && !this.state.submitted.has(running.record.id)) {
      const message = this.callbacks.message(running, result.outcome);
      this.state.submitted.add(running.record.id);
      this.pi.sendMessage(message, startup ? { triggerTurn: false } : { triggerTurn: true, deliverAs: "steer" });
      console.info(`[subagents:recovery] ${JSON.stringify({ id: running.record.id, event: "submitted", parentSessionId: running.record.owner.sessionId })}`);
    }
    this.callbacks.cleanup(running);
    this.state.agents.delete(running.record.id);
    this.callbacks.update(running);
  }

  async detach(reason: string): Promise<void> {
    this.closed = true;
    this.abort.abort(reason);
    await Promise.all(this.observers.values());
    const count = this.state.agents.size;
    if (count) console.info(`[subagents:parent-lifecycle] ${JSON.stringify({ reason,
      ...(reason === "reload" ? { retainedChildren: count } : { detachedChildren: count }) })}`);
    if (reason !== "reload") {
      this.state.agents.clear(); this.state.records.clear(); this.state.submitted.clear(); this.state.owner = null;
    }
  }
}
