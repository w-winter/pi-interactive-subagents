import { createAssistantMessageEventStream, type AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("guard-test", {
    api: "openai-responses",
    apiKey: "fixture-only",
    baseUrl: "http://127.0.0.1:1",
    models: ["astra", "sol"].map((id) => ({
      id, name: id, reasoning: true, input: ["text"],
      thinkingLevelMap: { xhigh: "xhigh" },
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 100000, maxTokens: 1000,
    })),
    streamSimple(model, _context, options) {
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        role: "assistant",
        content: [{ type: "text", text: JSON.stringify({ model: model.id, thinking: options?.reasoning ?? "off" }) }],
        api: model.api, provider: model.provider, model: model.id,
        usage: {
          input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop", timestamp: Date.now(),
      };
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    },
  });
}
