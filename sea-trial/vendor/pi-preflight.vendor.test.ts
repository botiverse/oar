/* oxlint-disable max-statements -- Each test follows native preflight through refusal, queued dispatch and recovery. */
import { expect, test, vi } from "vitest";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { isPiBackend } from "./support/pi-runtime.js";
import { piPreflightNative } from "./support/pi-preflight.js";

test.skipIf(!isPiBackend)("native Pi missing-key refusal drains queued work and leaves the next prompt usable", async () => {
  const f = await piPreflightNative(); const { session } = f;
  try {
    const first = session.prompt("A"); await f.entered(); await session.queue("B"); await f.release();
    const refused = await first;
    expect(refused).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    expect(refused.response.body.kind === "rejected" && refused.response.body.reason).toMatch(/No API key/iu);
    await vi.waitFor(() => { expect(session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toHaveLength(1); }, { timeout: 10_000 });
    expect(f.requests).toHaveLength(0);
    expect(await session.abort()).toMatchObject({ kind: "rejected", code: "no_active_turn" });
    const recovered = await promptAndWait(session, "C", { timeoutMs: 15_000 });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 45_000);
