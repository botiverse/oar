import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, createProvider } from "@earendil-works/pi-ai/models";
import { anthropicMessagesApi } from "@earendil-works/pi-ai/api/anthropic-messages.lazy";
import { createRegistry, Harness, MemoryStorage, type Storage, type Registry } from "@earendil-works/pi-durable";
import { LLMock } from "@copilotkit/aimock";
import { createPiDurableRuntime } from "../../packages/oar/src/runtimes/pi-durable/index.js";
import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";

export interface DurableFixture {
  readonly harness: Harness;
  readonly models: ReturnType<typeof createModels>;
  readonly registry: Registry;
  readonly mock: LLMock;
  readonly runtime: Runtime;
  close(): Promise<void>;
}

export async function startDurableFixture(configure?: (mock: LLMock) => void, storage: Storage = new MemoryStorage(), registry: Registry = createRegistry()): Promise<DurableFixture> {
  const mock = new LLMock({ port: 0 });
  if (configure === undefined) {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  } else { configure(mock); }
  await mock.start();
  const models = createModels();
  models.setProvider(createProvider({ id: "aimock", baseUrl: mock.url, api: anthropicMessagesApi(),
    auth: { apiKey: { name: "aimock", resolve: async () => { await Promise.resolve(); return { auth: { apiKey: "aimock" }, source: "test" }; } } },
    models: [{ api: "anthropic-messages", provider: "aimock", baseUrl: mock.url, id: "aimock-model", name: "aimock", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 200_000, maxTokens: 16_384 }],
  }));
  const harness = await Harness.open(storage, { models, registry, settings: { retry: { enabled: false }, progress: { partialIntervalMs: 0 } } }, BACKGROUND_CONTEXT);
  return { harness, models, registry, mock, runtime: createPiDurableRuntime({ harness, models }), close: async () => { await harness.close(BACKGROUND_CONTEXT); await mock.stop(); } };
}
