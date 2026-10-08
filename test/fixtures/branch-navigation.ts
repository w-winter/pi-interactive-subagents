import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerCommand("branch-result-select", {
    description: "Select a session entry without generating a branch summary",
    async handler(entryId, ctx) {
      const result = await ctx.navigateTree(entryId, { summarize: false });
      if (result.cancelled) throw new Error("Branch selection was cancelled");
    },
  });
}
