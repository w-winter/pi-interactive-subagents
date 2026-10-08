import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  let getContext: () => ExtensionContext = () => { throw new Error("Session has not started"); };
  pi.on("session_start", (_event, ctx) => { getContext = () => ctx; });
  pi.registerProvider("launch-audit", {
    api: "openai-responses", apiKey: "fixture-only", baseUrl: "http://127.0.0.1:1",
    models: [{
      id: "snapshot", name: "Launch snapshot", reasoning: false, input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100000, maxTokens: 1000,
    }],
    streamSimple(model) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant", content: [{ type: "text", text: JSON.stringify({
          declaredTools: pi.getActiveTools().sort(),
          registeredTools: pi.getAllTools().map((tool) => tool.name).sort(),
          systemPrompt: getContext().getSystemPrompt(), cwd: getContext().cwd,
          agentDir: process.env.PI_CODING_AGENT_DIR,
        }) }],
        api: model.api, provider: model.provider, model: model.id,
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        stopReason: "stop", timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
}
