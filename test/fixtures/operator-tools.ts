import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("audit-enable", {
    description: "Enable tools through the operator's tool-selection API",
    handler: async (args) => {
      const names = args.split(",");
      const available = new Set(pi.getAllTools().map((tool) => tool.name));
      for (const name of names) {
        if (!available.has(name)) throw new Error(`Tool is unavailable: ${name}`);
      }
      pi.setActiveTools([...pi.getActiveTools(), ...names]);
      pi.appendEntry("tools-config", {
        version: 2, overrides: Object.fromEntries(names.map((name) => [name, "enabled"])),
      });
    },
  });
  pi.registerCommand("audit-quit", {
    description: "Close the isolated test session",
    handler: async (_args, ctx) => { ctx.shutdown(); },
  });
  pi.registerCommand("audit-reload", {
    description: "Reload the isolated test session's extensions",
    handler: async (_args, ctx) => { await ctx.reload(); },
  });
}
