/* oxlint-disable max-statements, no-await-in-loop -- Serial probes must preserve the same active run. */
/* oxlint-disable require-await -- Offline replacements preserve native async API signatures without performing IO. */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentPlatform } from "@cursor/sdk";

const directory = await mkdtemp(join(tmpdir(), "cursor-summary-force-"));
let networkCalls = 0;
let executorCalls = 0;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (): Promise<Response> => { networkCalls += 1; throw new Error("Offline probe forbids network access"); };
try {
  const platform = await createAgentPlatform({ stateRoot: directory, workspaceRef: directory });
  platform.resolveLocalModelSelection = async (selection): ReturnType<typeof platform.resolveLocalModelSelection> => selection;
  platform.acquireLocalExecutor = async (): ReturnType<typeof platform.acquireLocalExecutor> => { executorCalls += 1; throw new Error("Offline probe forbids executor launch"); };
  const { agent: stored, run } = await platform.store.createAgent({ workspaceRef: directory, model: { id: "fixture-model" } });
  await platform.store.patchCheckpoint(stored.agentId, run.runId, { blobId: "fixture-checkpoint", storeKind: "fixture" });
  await platform.store.markRunStarting(stored.agentId, run.runId);
  const agent = await platform.resumeAgent(stored.agentId, { model: { id: "fixture-model" }, apiKey: "offline-synthetic-key", local: { cwd: directory } });
  const results = [];
  for (const options of [undefined, { local: { force: true } }]) {
    let failure: unknown = null;
    try { await Reflect.apply(agent.summarize.bind(agent), agent, [options]); } catch (error) { failure = error; }
    assert.ok(failure instanceof Error);
    results.push({ suppliedForce: options !== undefined, errorName: failure.name, causeName: failure.cause instanceof Error ? failure.cause.name : undefined, message: failure.message.replaceAll(stored.agentId, "<agent>").replaceAll(run.runId, "<run>").replaceAll(directory, "<directory>") });
  }
  const after = await platform.store.getAgent(stored.agentId);
  assert.equal(after?.activeRunId, run.runId);
  assert.equal(executorCalls, 0);
  assert.ok(results.every(result => result.errorName === "UnknownAgentError" && result.message === "Agent <agent> already has active run"));
  console.log(JSON.stringify({ sdk: "1.2.0", syntheticStorage: true, catalogStubbed: true, results, activeRunUnchanged: true, executorCalls, blockedFetchCalls: networkCalls }, null, 2));
  agent.close();
} finally {
  globalThis.fetch = originalFetch;
  await rm(directory, { recursive: true, force: true });
}
