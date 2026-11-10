import { expect, test, vi } from "vitest";
import { grokAcpProfile } from "../../packages/oar/src/runtimes/grok/session.js";
import type { AcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import { sendAcpSteerRequest } from "../../packages/oar/src/shared/acp/steer-request.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

// A turn that ends while the transport waits for its spawn must not receive
// the interjection: Grok would run it as a turn of its own (PR #716 review).
test("a steer request rechecks its turn after the transport's own spawn wait", async () => {
  let running = true;
  let spawnReads = 0;
  const request = vi.fn(async () => ({ result: { status: "queued" } }));
  const runtime = {
    get spawned() { spawnReads += 1; if (spawnReads === 2) { running = false; } return Promise.resolve(); },
    closed: false, exitCode: null, connection: { agent: { request } },
  };
  const kernel = createSessionKernel("root");
  const steer = kernel.request("toRuntime", { kind: "steer", input: "late" });
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- A process stand-in with only the members the steer path touches.
  const result = await sendAcpSteerRequest({ kernel, runtime: runtime as unknown as AcpProcess, profile: grokAcpProfile, capabilities: { images: false }, running: () => running }, steer, "late", undefined);
  expect(result).toMatchObject({ kind: "rejected", code: "no_active_turn" });
  expect(request).not.toHaveBeenCalled();
  expect(kernel.records().filter((record) => record.kind === "frame")).toEqual([]);
});
