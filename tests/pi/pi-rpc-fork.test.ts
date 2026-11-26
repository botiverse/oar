import type { RpcResponse, RpcSessionState } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";
import { piRpcClone } from "../../packages/oar/src/runtimes/pi/rpc/open.js";

type Control = Parameters<typeof piRpcClone>[0];

const state = (sessionId: string): RpcSessionState => ({
  sessionId,
  thinkingLevel: "off",
  isStreaming: false,
  isCompacting: false,
  steeringMode: "all",
  followUpMode: "all",
  autoCompactionEnabled: true,
  messageCount: 1,
  pendingMessageCount: 0,
});

function control(...responses: RpcResponse[]): Control {
  let index = 0;
  return {
    request: async () => {
      const response = responses[index++];
      if (response === undefined) { throw new Error("unexpected RPC request"); }
      return response;
    },
  };
}

const cloneOk = (cancelled: boolean): RpcResponse => ({ id: "clone", type: "response", command: "clone", success: true, data: { cancelled } });
const stateOk = (sessionId: string): RpcResponse => ({ id: "state", type: "response", command: "get_state", success: true, data: state(sessionId) });

test("native clone requires a non-cancelled response and a new read-back id", async () => {
  const copied = piRpcClone(control(cloneOk(false), stateOk("copy")), "source");
  await expect(copied).resolves.toMatchObject({ sessionId: "copy" });
  const cancelled = piRpcClone(control(cloneOk(true)), "source");
  await expect(cancelled).rejects.toThrow("clone was cancelled");
  const sameId = piRpcClone(control(cloneOk(false), stateOk("source")), "source");
  await expect(sameId).rejects.toThrow("kept the source session id");
  const noId = piRpcClone(control(cloneOk(false), stateOk("  ")), "source");
  await expect(noId).rejects.toThrow("returned no session id");
});

test("a native clone failure is not converted into a session", async () => {
  const failed = piRpcClone(control({ id: "clone", type: "response", command: "clone", success: false, error: "native refused" }), "source");
  await expect(failed).rejects.toThrow("Pi RPC clone failed: native refused");
});
