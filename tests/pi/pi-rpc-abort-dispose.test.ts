/* oxlint-disable eslint/max-statements -- Each test drives one Pi RPC abort/dispose lifecycle. */
import { setImmediate as settle } from "node:timers/promises";
import { afterEach, expect, test, vi } from "vitest";
import type { RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { createPiRpcSession } from "../../packages/oar/src/runtimes/pi/rpc/session.js";
import { fakeLineProcess } from "../fixtures/fake-line-process.js";

const noop = (): void => {};
const mocks = vi.hoisted(() => ({ openPiRpc: vi.fn() }));
vi.mock("../../packages/oar/src/runtimes/pi/rpc/open.js", () => ({ openPiRpc: mocks.openPiRpc }));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

async function openRpc(options: { readonly abortFails?: boolean; readonly holdStats?: PromiseWithResolvers<RpcResponse> } = {}) {
  const child = fakeLineProcess();
  let emit: (message: Record<string, unknown>) => void = noop;
  const state = {
    sessionId: "rpc-abort", thinkingLevel: "off", isStreaming: false, isCompacting: false,
    steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0,
  } as const;
  let seq = 0;
  mocks.openPiRpc.mockImplementationOnce(async (_opts: unknown, _creds: unknown, receive: typeof emit) => {
    emit = receive;
    await Promise.resolve();
    return {
      child, directory: { path: "/fixture", remove() {} }, state,
      control: {
        request: async (command: RpcCommand, issued?: (id: string) => void): Promise<RpcResponse> => {
          const id = `cmd-${String(seq++)}`;
          issued?.(id);
          if (command.type === "abort") {
            const response: RpcResponse = options.abortFails === true
              ? { type: "response", command: "abort", success: false, error: "not abortable", id }
              : { type: "response", command: "abort", success: true, id };
            receive(response);
            return response;
          }
          if (command.type === "get_session_stats" && options.holdStats !== undefined) {
            return { ...await options.holdStats.promise, id };
          }
          const response: RpcResponse = { type: "response", command: "prompt", success: true, data: { disposition: "started" }, id };
          receive(response);
          receive({ type: "agent_start" });
          return response;
        },
      },
    };
  });
  const session = await createPiRpcSession({ execution: "subprocess" })({ kind: "available", via: "bundled" }, { cwd: "/work" });
  return { session, child, emit: (message: Record<string, unknown>) => { emit(message); } };
}

test("Pi RPC native abort refusal disarms the 10 s fallback kill", async () => {
  const { session, child } = await openRpc({ abortFails: true });
  const kill = vi.spyOn(child, "kill");
  try {
    await session.prompt("run");
    vi.useFakeTimers();
    expect(await session.abort()).toMatchObject({ kind: "accepted" });
    await vi.advanceTimersByTimeAsync(10_001);
    expect(kill).not.toHaveBeenCalled();
    expect(session.records().some(record => record.kind === "frame" && record.body.type === "pi/abort_rejected")).toBe(true);
  } finally {
    vi.useRealTimers();
    child.end(0);
    await session.dispose();
  }
});

test("Pi RPC dispose after process exit answers without leaving a dangling dispose request", async () => {
  const holdStats = Promise.withResolvers<RpcResponse>();
  const { session, child, emit } = await openRpc({ holdStats });
  await session.prompt("run");
  emit({ type: "agent_settled", aborted: false });
  child.end(1);
  // Dispose races while onExit is still awaiting pump/stats.
  const disposing = session.dispose();
  holdStats.resolve({ type: "response", command: "get_session_stats", success: false, error: "exited" });
  await disposing;
  await settle();
  const disposeReq = session.records().find(record => record.kind === "request" && record.body.kind === "dispose");
  expect(disposeReq?.kind).toBe("request");
  expect(session.records().some(record => record.kind === "response" && record.requestId === (disposeReq?.kind === "request" ? disposeReq.id : "") && (record.body.kind === "exited" || record.body.kind === "accepted"))).toBe(true);
});
