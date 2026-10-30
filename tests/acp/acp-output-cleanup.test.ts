import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import { createAcpClient, startAcpProcess } from "../../packages/oar/src/shared/acp/process.js";
import { createAcpOpening } from "../../packages/oar/src/shared/acp/opening.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Delay one real observation to expose cancellation during capture.
import * as tables from "../../packages/oar/src/shared/executable/process-table-async.js";
import { gone } from "../fixtures/process-tree.js";

afterEach(() => { vi.restoreAllMocks(); });

// Windows ordinary ACP disposal uses taskkill without an asynchronous capture.
// oxlint-disable-next-line eslint/max-statements -- Exercise the SDK cancellation, native output and detached tool as one shutdown.
test.skipIf(process.platform === "win32")("ACP cancellation drains ongoing output through capture and cleans a tool outside the process group", async () => {
  const ready = Promise.withResolvers<number>();
  let parsed = 0, pulses = 0;
  const app = createAcpClient({ name: "cleanup" })
    .onNotification("fixture/ready", (value) => asRecord(value) ?? {}, ({ params }) => { if (typeof params.tool === "number") { ready.resolve(params.tool); } })
    .onNotification("fixture/pulse", (value) => asRecord(value) ?? {}, () => { pulses += 1; });
  const child = startAcpProcess(process.execPath, [fileURLToPath(new URL("../fixtures/acp-output-tree.mjs", import.meta.url))], app, {
    opening: createAcpOpening(), incoming: (message) => { parsed += 1; return message; },
  });
  let tool: number | undefined = undefined;
  try {
    tool = await ready.promise;
    await vi.waitFor(() => { expect(pulses).toBeGreaterThan(0); });
    expect(await gone(tool, 50)).toBe(false);
    const nativeRead = tables.observeProcessTableAsync;
    vi.spyOn(tables, "observeProcessTableAsync").mockImplementationOnce(async () => { await delay(100); return nativeRead(); });
    child.kill();
    const atStop = { pulses, parsed };
    expect(await child.exited, child.diagnostics().stderr).toBe(0);
    expect({ pulses, parsed }).toEqual(atStop);
    expect(child.diagnostics().stderr).toContain("native-shutdown-hook");
    expect(child.diagnostics().stderr).not.toMatch(/EPIPE|SIGPIPE/u);
    expect(child.diagnostics().cleanup).toMatchObject({ status: "observed", observations: [{ ok: true, phase: "before_eof" }, { ok: true, phase: "after_exit" }] });
    expect(await gone(tool)).toBe(true);
  } finally {
    vi.restoreAllMocks(); child.kill(); await child.exited;
    if (tool !== undefined) { try { process.kill(tool, "SIGKILL"); } catch { /* Already reclaimed. */ } }
  }
});
