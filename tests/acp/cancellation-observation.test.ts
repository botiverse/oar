import { setImmediate as nextTurn } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { acpSession } from "../../packages/oar/src/shared/acp/session.js";
import type { ProcessTableObservation } from "../../packages/oar/src/shared/executable/process-tree.js";
// oxlint-disable-next-line import/no-namespace -- Keep the real protocol while controlling only the process-table observation.
import * as tables from "../../packages/oar/src/shared/executable/process-table-async.js";

afterEach(() => { vi.restoreAllMocks(); });
const failure: ProcessTableObservation = { ok: false, source: "windows", reason: "timeout", elapsedMs: 1000, timeoutMs: 1000 };
const fixture = fileURLToPath(new URL("../fixtures/fake-acp-interrupt.mjs", import.meta.url));

// oxlint-disable-next-line max-statements -- Both pending input kinds follow one shared observation and one native cancellation.
test("isolated ACP prompt and steer wait for cancellation observation, including repeated abort", async () => {
  const session = await acpSession({ args: [fixture, "", "ignore-cancel"], steerParams: () => ({}),
    capabilities: { queue: { durable: false }, attribution: "opaque" } })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() });
  const entered = Promise.withResolvers<void>(), gate = Promise.withResolvers<ProcessTableObservation>();
  try {
    await session.prompt("work");
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockImplementationOnce(async () => { entered.resolve(); return gate.promise; });
    const first = session.abort(); await entered.promise;
    const second = session.abort();
    const settled: string[] = [];
    const prompt = async () => { const result = await session.prompt("B"); settled.push("prompt"); return result; };
    const steer = async () => { const result = await session.steer?.("C"); settled.push("steer"); return result; };
    const prompted = prompt(), steered = steer();
    await nextTurn();
    expect(settled).toEqual([]); expect(read).toHaveBeenCalledOnce();
    gate.resolve(failure);
    const aborts = await Promise.all([first, second]);
    expect(aborts.map(result => result.kind)).toEqual(["accepted", "accepted"]);
    const promptedResult = await prompted, steeredResult = await steered;
    expect(promptedResult.response.body).toEqual({ kind: "rejected", code: "busy", reason: "busy" });
    expect(steeredResult?.kind).toBe("accepted");
    expect(read).toHaveBeenCalledOnce();
  } finally { gate.resolve(failure); vi.restoreAllMocks(); await session.dispose(); }
});

// oxlint-disable-next-line max-statements -- A prompt must establish its turn before an immediately following abort.
test("isolated ACP keeps synchronous prompt dispatch outside the observation window", async () => {
  const session = await acpSession({ args: [fixture, "", "ignore-cancel"],
    capabilities: { queue: { durable: false }, attribution: "opaque" } })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() });
  try {
    const read = vi.spyOn(tables, "observeProcessTableAsync").mockResolvedValue(failure);
    const prompt = session.prompt("work");
    const abort = session.abort();
    const prompted = await prompt;
    const aborted = await abort;
    expect(prompted.kind).toBe("accepted");
    expect(aborted.kind).toBe("accepted");
    expect(read).toHaveBeenCalledOnce();
  } finally { vi.restoreAllMocks(); await session.dispose(); }
});
