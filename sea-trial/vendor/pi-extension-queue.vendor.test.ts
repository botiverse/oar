/* oxlint-disable max-statements -- Hold both native runs while checking admission, FIFO and terminal evidence. */
import { expect, test, vi } from "vitest";
import { isPiBackend } from "./support/pi-runtime.js";
import { piExtensionQueue } from "./support/pi-extension-queue.js";

test.skipIf(!isPiBackend).each(["sync-settled", "async-settled", "spawn-command", "delayed-input"] as const)("native Pi %s preserves held input after the extension run", async mode => {
  const f = await piExtensionQueue(mode);
  const outcomes = () => f.session.records().flatMap(record => record.kind === "frame" ? record.body.events.flatMap(event => event.kind === "turn_ended" ? [event.outcome.kind] : []) : []);
  try {
    expect(await f.session.prompt("OAR_QUEUE_A")).toMatchObject({ kind: "accepted" });
    expect(await f.session.queue("OAR_QUEUE_B")).toMatchObject({ kind: "accepted" });
    f.releaseFirst();
    await f.entered();
    await vi.waitFor(() => { expect(f.requests).toEqual(["OAR_QUEUE_A", "OAR_QUEUE_EXT"]); }, { timeout: 10_000 });
    await f.releaseInput();
    expect(await f.session.prompt("cannot replace the extension run")).toMatchObject({ kind: "rejected", code: "busy" });
    f.releaseExtension();
    await vi.waitFor(() => { expect(outcomes(), JSON.stringify(f.session.records())).toEqual(["completed", "completed", "completed"]); }, { timeout: 10_000 });
    expect(f.requests).toEqual(["OAR_QUEUE_A", "OAR_QUEUE_EXT", "OAR_QUEUE_B"]);
    expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "pi/prompt_rejected")).toEqual([]);
  } finally { await f.close(); }
}, 45_000);
