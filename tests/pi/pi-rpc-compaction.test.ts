import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import type { RpcResponse } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import { openPiRpc } from "../../packages/oar/src/runtimes/pi/rpc/open.js";
import { createPiRpcSession } from "../../packages/oar/src/runtimes/pi/rpc/session.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

vi.mock("../../packages/oar/src/runtimes/pi/rpc/open.js", () => ({ openPiRpc: vi.fn() }));
afterEach(() => { vi.mocked(openPiRpc).mockReset(); });

// oxlint-disable-next-line max-statements -- Transport rejection must precede exit to distinguish it from a native failure.
test("RPC transport rejection after compaction starts waits for exit without inventing a native failure", async () => {
  const child = fakeLineProcess();
  const response = Promise.withResolvers<RpcResponse>();
  let receiveNative: (message: Record<string, unknown>) => void = vi.fn<(message: Record<string, unknown>) => void>();
  vi.mocked(openPiRpc).mockImplementation(async (_options, _credentials, receive) => {
    receiveNative = receive;
    return { child, directory: { path: "/fixture", remove() {} },
      control: { request: async (command) => { expect(command).toEqual({ type: "compact" }); return response.promise; } },
      state: { sessionId: "rpc", thinkingLevel: "off", isStreaming: false, isCompacting: false,
        steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 },
    };
  });
  const session = await createPiRpcSession({ execution: "subprocess" })({ kind: "available", via: "bundled" }, { cwd: "/work" });
  try {
    assert.ok(session.compact !== undefined);
    const compact = session.compact.bind(session);
    let settled = false;
    const waiting = (async () => { const result = await compact(); settled = true; return result; })();
    receiveNative({ type: "compaction_start", reason: "manual" });
    await setImmediate();
    expect(session.status().value).toMatchObject({ kind: "running", phase: "compacting", compaction: { started: true } });
    response.reject(new Error("RPC transport lost"));
    await setImmediate();
    expect(settled).toBe(false);
    expect(session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "compaction_ended"))).toBe(false);
    child.end(1);
    expect(await waiting).toMatchObject({ kind: "unconfirmed", code: "runtime_exited" });
    expect(session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "compaction_ended"))).toBe(false);
  } finally { await session.dispose(); }
});
