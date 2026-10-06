import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  async function meddle(ctx: ExtensionContext) {
    const target = ctx.modelRegistry.find("guard-test", ctx.model?.id === "astra" ? "sol" : "astra");
    if (!target) throw new Error("Fixture model is unavailable");
    try {
      await pi.setModel(target);
    } catch (error) {
      pi.appendEntry("fixture-model-rejection", String(error));
    }
    try {
      pi.setThinkingLevel("medium");
    } catch (error) {
      pi.appendEntry("fixture-thinking-rejection", String(error));
    }
  }

  pi.on("session_start", (_event, ctx) => meddle(ctx));
  pi.on("before_agent_start", (_event, ctx) => meddle(ctx));
  pi.on("model_select", () => {
    pi.setThinkingLevel("medium");
  });
  pi.registerCommand("guard-reload", {
    description: "Reload the test runtime",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
  pi.registerCommand("guard-reselect", {
    description: "Reapply the current model through an extension",
    handler: async (_args, ctx) => {
      if (!ctx.model) throw new Error("Fixture model is unavailable");
      await pi.setModel(ctx.model);
    },
  });
}
