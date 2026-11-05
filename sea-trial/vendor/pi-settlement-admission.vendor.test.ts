import { describe, expect, test } from "vitest";
import { awaitIdle, awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/index.js";
import { isPiBackend, piRpc } from "./support/pi-runtime.js";
import { inputId, until, ends, fixture } from "./support/pi-input-disposition.js";

describe.skipIf(!isPiBackend)("Pi settlement and native admission", () => {
  test.skipIf(piRpc).each([0, 150])("SDK keeps extension input before held input with a %i ms hook", async latency => {
    const f = await fixture(`let count = 0;
      pi.on("agent_settled", () => { if (count++ === 0) pi.sendUserMessage("EXT"); });
      pi.on("input", async event => { if (event.text === "EXT" && ${latency} > 0) await delay(${latency}); });`, /^(A|EXT|B)$/u);
    try {
      await f.session.prompt("A");
      expect(await until(() => f.requests.includes("A"))).toBe(true);
      const b = await f.session.queue("B", { inputId: inputId(2) });
      const finished = awaitTurnEnd(f.session, b.seq, inputId(2));
      f.gate("A").resolve();
      expect(await until(() => f.requests.includes("EXT"))).toBe(true);
      expect(f.requests).toEqual(["A", "EXT"]);
      f.gate("EXT").resolve();
      expect(await until(() => f.requests.includes("B"))).toBe(true);
      f.gate("B").resolve();
      expect(await finished).toEqual({ kind: "completed" });
      expect(f.requests).toEqual(["A", "EXT", "B"]);
      expect(await f.hooks()).toEqual(["A", "EXT", "B"]);
      expect(ends(f.session)).toHaveLength(3);
    } finally { await f.close(); }
  }, 15_000);

  test.skipIf(piRpc).each([0, 150])("SDK drains after an independent run and its %i ms extension hook", async latency => {
    const f = await fixture(`let count = 0;
      pi.on("session_start", () => { pi.sendUserMessage("BOOT"); });
      pi.on("agent_settled", () => { if (count++ === 0) pi.sendUserMessage("EXT"); });
      pi.on("input", async event => { if (event.text === "EXT" && ${latency} > 0) await delay(${latency}); });`, /^(BOOT|EXT|B)$/u);
    try {
      expect(await until(() => f.requests.includes("BOOT"))).toBe(true);
      const b = await f.session.queue("B", { inputId: inputId(2) });
      const finished = awaitTurnEnd(f.session, b.seq, inputId(2));
      f.gate("BOOT").resolve();
      expect(await until(() => f.requests.includes("EXT"))).toBe(true);
      expect(f.requests).toEqual(["BOOT", "EXT"]);
      f.gate("EXT").resolve();
      expect(await until(() => f.requests.includes("B"))).toBe(true);
      f.gate("B").resolve();
      expect(await finished).toEqual({ kind: "completed" });
      expect(f.requests).toEqual(["BOOT", "EXT", "B"]);
      expect(await f.hooks()).toEqual(["BOOT", "EXT", "B"]);
      expect(ends(f.session)).toHaveLength(3);
    } finally { await f.close(); }
  }, 15_000);

  test.skipIf(piRpc)("SDK settles a bootstrap run whose agent_start preceded subscription", async () => {
    const f = await fixture('pi.on("session_start", () => { pi.sendUserMessage("BOOT"); });', /^BOOT$/u);
    try {
      expect(await until(() => f.requests.includes("BOOT"))).toBe(true);
      expect(f.session.records().some(record => record.kind === "frame" && record.body.type === "agent_start")).toBe(false);
      const captured: { idle?: ReturnType<typeof awaitIdle> } = {};
      f.session.rawEvents(record => {
        if (captured.idle === undefined && record.kind === "frame" && record.body.events.some(event => event.kind === "text_delta")) {
          expect(f.session.status().value.kind).toBe("running");
          captured.idle = awaitIdle(f.session);
        }
      });
      f.gate("BOOT").resolve();
      expect(await until(() => captured.idle !== undefined)).toBe(true);
      expect(await captured.idle).toEqual({ kind: "completed" });
      expect(f.session.status().value.kind).toBe("idle");
      expect(ends(f.session)).toHaveLength(1);
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 15_000);

  test("a preflight abort ends at the handled receipt; a later extension run needs its own abort", async () => {
    const f = await fixture(`pi.registerCommand("spawnreturn", { description: "probe", handler: async () => {
      note({ text: "command-entered" }); await delay(200); pi.sendUserMessage("EXT");
    } });
    pi.on("before_agent_start", async event => { if (event.prompt === "EXT") await delay(150); });`, /^EXT$/u);
    try {
      const pending = promptAndWait(f.session, "/spawnreturn", { inputId: inputId(1) });
      expect(await until(async () => { const hooks = await f.hooks(); return hooks.includes("command-entered"); })).toBe(true);
      expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
      expect(await pending).toMatchObject({ kind: "handled" });
      expect(await until(() => f.requests.includes("EXT"))).toBe(true);
      expect(ends(f.session)).toHaveLength(0);
      expect(f.session.status().value.kind).toBe("running");
      const idle = awaitIdle(f.session);
      expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
      expect(await idle).toEqual({ kind: "aborted" });
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 15_000);
});
