/* oxlint-disable max-statements -- Separate startup, dispatch, admission and native answer in one scenario. */
import { setImmediate } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { grokCompaction } from "../../packages/oar/src/runtimes/grok/compaction.js";
import { opencodeCompaction } from "../../packages/oar/src/runtimes/opencode/compaction.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import type { AcpProcess } from "../../packages/oar/src/shared/acp/process.js";

test.each([grokCompaction, opencodeCompaction])("%s admits only after SDK dispatch, never while waiting for spawn", async create => {
  const spawn = Promise.withResolvers<void>();
  const native = Promise.withResolvers<object>();
  const send = vi.fn(async () => native.promise);
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Only the real withAcpDeadline transport slice is used here.
  const runtime = { spawned: spawn.promise, closed: false, connection: { agent: { request: send } } } as unknown as AcpProcess;
  const kernel = createSessionKernel("root");
  const operation = create(kernel, runtime, () => null);
  const request = kernel.request("toRuntime", { kind: "compact", settledBy: "native_response" });
  const reply = vi.fn(() => { expect(send).toHaveBeenCalledTimes(1); });
  const waiting = operation.start(request, reply);
  await setImmediate(); expect(reply).not.toHaveBeenCalled(); expect(send).not.toHaveBeenCalled();
  spawn.resolve(); await setImmediate(); expect(reply).toHaveBeenCalledWith({ kind: "accepted" });
  native.resolve({}); await waiting;
  expect(kernel.records().at(-1)).toMatchObject({ kind: "frame", body: { responseTo: request.id } });
});
