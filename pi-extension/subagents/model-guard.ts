import { ExtensionRunner, SessionManager } from "@mariozechner/pi-coding-agent";
import { readLaunchSettings } from "./launch-settings.ts";

const GUARD_KEY = Symbol.for("pi-subagents/model-guard");

/** Protect model/thinking choices and persist tool selections made through extension controls. */
export function installSubagentModelGuard(): void {
  const originalBindCore = ExtensionRunner.prototype.bindCore;
  if (GUARD_KEY in originalBindCore) return;

  // Pi binds every extension's setters here before startup; native selectors use the session directly.
  function bindCore(this: ExtensionRunner, ...args: Parameters<ExtensionRunner["bindCore"]>): void {
    const [actions, contextActions, providerActions] = args;

    function reject(field: "model" | "thinking", selected: string | null, requested: string): never {
      const diagnostic = { field, selected, requested };
      actions.appendEntry("subagent-selection-rejected", diagnostic);
      console.warn(`[subagents:model-guard] ${JSON.stringify(diagnostic)}`);
      throw new Error(
        `Subagent ${field} override rejected: selected ${selected}, requested ${requested}. ` +
        `Use /${field} to change the selection manually.`,
      );
    }

    originalBindCore.call(this, {
      ...actions,
      async setModel(model) {
        const selected = contextActions.getModel();
        if (selected?.provider === model.provider && selected.id === model.id) return true;
        reject("model", selected ? `${selected.provider}/${selected.id}` : null, `${model.provider}/${model.id}`);
      },
      setThinkingLevel(level) {
        const selected = actions.getThinkingLevel();
        if (level !== selected) reject("thinking", selected, level);
      },
      setActiveTools: (tools) => {
        actions.setActiveTools(tools);
        const { sessionManager } = this.createContext();
        const settings = readLaunchSettings(sessionManager.getBranch(), sessionManager.getSessionId());
        if (settings) actions.appendEntry("subagent-launch", { ...settings, tools: actions.getActiveTools() });
      },
    }, contextActions, providerActions);

    const { sessionManager } = this.createContext();
    if (!(sessionManager instanceof SessionManager)) throw new Error("Subagent model guard requires Pi's native session manager");
    // The registry is ready at session_start; restore before selectors apply operator overrides.
    const emit = this.emit.bind(this);
    this.emit = async (event) => {
      if (event.type === "session_start") {
        const launch = readLaunchSettings(sessionManager.getBranch(), sessionManager.getSessionId());
        if (launch) actions.setActiveTools(launch.tools);
      }
      return emit(event);
    };
    // Record CLI overrides of inherited fork history before any startup handler can run.
    const branch = sessionManager.getBranch();
    const model = contextActions.getModel();
    const previousModel = branch.findLast((entry) => entry.type === "model_change");
    if (model && (previousModel?.provider !== model.provider || previousModel.modelId !== model.id)) {
      sessionManager.appendModelChange(model.provider, model.id);
    }
    const thinking = actions.getThinkingLevel();
    if (branch.findLast((entry) => entry.type === "thinking_level_change")?.thinkingLevel !== thinking) {
      sessionManager.appendThinkingLevelChange(thinking);
    }
  }

  Object.defineProperty(bindCore, GUARD_KEY, { value: true });
  ExtensionRunner.prototype.bindCore = bindCore;
}
