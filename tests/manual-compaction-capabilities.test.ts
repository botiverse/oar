import { expect, test } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { createPiRuntime } from "../packages/oar/src/runtimes/pi/index.js";
import { createPiDurableRuntime } from "../packages/oar/src/runtimes/pi-durable/index.js";
import type { Runtime } from "../packages/oar/src/contracts/runtime.js";
import { allRuntimes } from "../sea-trial/harness/runtimes.js";

// Supported entries need native controls in the two manual-compaction vendor files.
// Cursor uses SDK stand-ins in tests and a separately authorized account probe in experiments.
test("all manual compaction declarations distinguish unsupported from untested", async () => {
  const models = createModels();
  const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
  try {
    const runtimes = [
      ...allRuntimes.list().map((runtime) => ({ name: runtime.id, runtime })),
      { name: "pi-rpc", runtime: createPiRuntime({ execution: "subprocess" }) },
      { name: "pi-durable", runtime: createPiDurableRuntime({ harness, models }) },
    ];
    expect(Object.fromEntries(runtimes.map(({ name, runtime }) => [name, runtime.manualCompaction?.kind ?? null]))).toEqual({
      antigravity: "unsupported", claude: "supported", codebuddy: "unsupported", codex: "supported", cursor: "supported", dsh: null,
      grok: "supported", kimi: "unsupported", opencode: null, pi: "supported", "pi-rpc": "supported", "pi-durable": null, qoder: "supported", qwen: "unsupported",
    });
    for (const { runtime } of runtimes) { verifyPolicy(runtime); }
  } finally { await harness.close(BACKGROUND_CONTEXT); }
});

function verifyPolicy(runtime: Runtime): void {
  if (runtime.manualCompaction?.kind === "supported") { expect(runtime.manualCompaction.activeTurn).toBe("reject"); }
  if (runtime.manualCompaction?.kind === "unsupported") { expect(runtime.manualCompaction.reason.length).toBeGreaterThan(30); }
  expect(runtime.withPlacement("isolated").manualCompaction).toEqual(runtime.manualCompaction);
}
