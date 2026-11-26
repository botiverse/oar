import { expect, test, vi } from "vitest";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

test("open RPC replies retain their receipt times when attached to the confirmed session", () => {
  const now = vi.spyOn(Date, "now").mockReturnValue(300).mockReturnValueOnce(100).mockReturnValueOnce(200);
  try {
    const recorder = createAcpRecorder(createUsageUpdateGate());
    recorder.step("initialize", {});
    recorder.step("session/resume", {});
    const kernel = createSessionKernel("native");
    recorder.bind(kernel);
    expect(kernel.records().map(({ receivedAt }) => receivedAt)).toEqual([100, 200]);
  } finally {
    now.mockRestore();
  }
});
