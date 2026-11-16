import { describe, expect, test } from "vitest";
import { awaitIdle, promptAndWait } from "../../packages/oar/src/observe/index.js";
import { bootstrapCompaction } from "./support/pi-bootstrap.js";
import { fixture, ends, until } from "./support/pi-input-disposition.js";
import { isPiBackend, piRpc } from "./support/pi-runtime.js";

describe.skipIf(!isPiBackend || piRpc)("Pi SDK bootstrap admission", () => {
  test("startup settlement refuses prompt before native deferral and holds queue through compaction", async () => {
    const f = await bootstrapCompaction();
    try {
      expect(f.session.status().value.kind).toBe("running");
      expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "agent_start")).toHaveLength(1);
      expect(await f.session.prompt("D")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(await f.session.queue("QUEUED")).toMatchObject({ kind: "accepted", response: { body: { kind: "accepted", queued: "adapter" } } });
      expect(f.requests).toHaveLength(1);
      await f.release();
      expect(await f.compacted()).toBe(true);
      expect(await until(() => f.requests.includes("QUEUED") && f.session.status().value.kind === "idle")).toBe(true);
      expect(ends(f.session)).toEqual([
        { kind: "turn_ended", outcome: { kind: "completed" } },
        { kind: "turn_ended", outcome: { kind: "completed" } },
      ]);
      const hooks = await f.hooks();
      expect(hooks).not.toContain("D");
      expect(hooks.filter(value => value === "QUEUED")).toHaveLength(1);
      expect(f.session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped"))).toBe(false);
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 15_000);

  test("a run completed during session_start retains its real start and end without owning the next input", async () => {
    const f = await fixture(`let settled = false;
      pi.on("agent_settled", () => { settled = true; });
      pi.on("session_start", async () => { pi.sendUserMessage("BOOT"); while (!settled) await delay(10); });`);
    try {
      expect(f.session.status().value.kind).toBe("idle");
      expect(ends(f.session)).toEqual([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
      expect(f.session.records().filter(record => record.kind === "frame" && record.body.type === "agent_start")).toHaveLength(1);
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(f.requests).toEqual(["BOOT", "NEXT"]);
    } finally { await f.close(); }
  }, 15_000);

  test("abort of the startup run keeps its own outcome and does not cancel the next prompt", async () => {
    const f = await fixture('pi.on("session_start", () => { pi.sendUserMessage("BOOT"); });', /^BOOT$/u);
    try {
      expect(await until(() => f.requests.includes("BOOT"))).toBe(true);
      expect(f.session.status().value.kind).toBe("running");
      expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
      expect(await awaitIdle(f.session)).toEqual({ kind: "aborted" });
      expect(ends(f.session)).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 15_000);
});
