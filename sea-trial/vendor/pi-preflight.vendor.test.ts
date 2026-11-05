/* oxlint-disable max-statements -- Each test follows native preflight through refusal, queued dispatch and recovery. */
import { expect, test, vi } from "vitest";
import type { ControlResult } from "../../packages/oar/src/contracts/session.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { isPiBackend } from "./support/pi-runtime.js";
import { piPreflightNative } from "./support/pi-preflight.js";

test.skipIf(!isPiBackend)("native Pi missing-key refusal drains queued work and leaves the next prompt usable", async () => {
  const f = await piPreflightNative("missing"); const { session } = f;
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

test.skipIf(!isPiBackend)("native Pi refuses the terminal observer's missing-key prompt before reporting acceptance", async () => {
  const f = await piPreflightNative("reentry"); const { session } = f;
  const observed = Promise.withResolvers<ControlResult>(); let used = false;
  try {
    session.rawEvents(record => {
      if (used || record.kind !== "frame" || !record.body.events.some(event => event.kind === "turn_ended")) { return; }
      used = true; void (async () => { observed.resolve(await session.prompt("B")); })();
    });
    expect(await promptAndWait(session, "A", { timeoutMs: 15_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    const refused = await observed.promise;
    expect(refused).toMatchObject({ kind: "rejected", code: "runtime_refused" });
    expect(refused.response.body.kind === "rejected" && refused.response.body.reason).toMatch(/No API key/iu);
    expect(f.requests).toHaveLength(1);
    const recovered = await promptAndWait(session, "C", { timeoutMs: 15_000 });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(f.requests).toHaveLength(2);
  } finally { await f.close(); }
}, 45_000);

test.skipIf(!isPiBackend)("native Pi extension-handled input releases its gate without inventing a turn", async () => {
  const f = await piPreflightNative("handled"); const { session } = f;
  try {
    expect(await session.prompt("HANDLED")).toMatchObject({ kind: "accepted" });
    expect(f.requests).toHaveLength(0);
    expect(session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "turn_ended"))).toBe(false);
    const recovered = await promptAndWait(session, "C", { timeoutMs: 15_000 });
    expect(recovered, JSON.stringify(recovered)).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    expect(f.requests).toHaveLength(1);
  } finally { await f.close(); }
}, 45_000);
