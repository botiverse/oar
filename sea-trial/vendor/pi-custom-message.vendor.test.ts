import { describe, expect, test } from "vitest";
import { awaitIdle, awaitTurnEnd, promptAndWait } from "../../packages/oar/src/observe/index.js";
import { isPiBackend } from "./support/pi-runtime.js";
import { ends, fixture, inputId, until } from "./support/pi-input-disposition.js";

const custom = 'pi.sendMessage({ customType: "notice", content: "idle notice", display: true }, { triggerTurn: false });';
const cases = [
  { name: "command", input: "/note", extension: `pi.registerCommand("note", { description: "probe", handler: async () => { ${custom} } });` },
  { name: "timer", input: "/note", extension: `pi.registerCommand("note", { description: "probe", handler: async () => { setTimeout(() => { ${custom} }, 50); } });` },
  { name: "input hook", input: "NOTE", extension: `pi.on("input", event => { if (event.text === "NOTE") { ${custom} return { action: "handled" }; } });` },
];

describe.skipIf(!isPiBackend)("Pi custom messages without a run", () => {
  test.each(cases)("$name leaves prompt and queue usable without a fabricated turn", async ({ input, extension }) => {
    const f = await fixture(extension);
    try {
      expect(await promptAndWait(f.session, input)).toMatchObject({ kind: "handled" });
      expect(await until(() => f.session.records().some(record => record.kind === "frame"
        && record.body.type === "message_end"))).toBe(true);
      expect(f.requests).toEqual([]);
      expect(ends(f.session)).toEqual([]);
      expect(f.session.status().value.kind).toBe("idle");
      expect(await awaitIdle(f.session)).toBeNull();
      expect(await f.session.abort()).toMatchObject({ kind: "rejected", code: "no_active_turn" });
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      const queued = await f.session.queue("LATER", { inputId: inputId(2) });
      expect(queued.kind).toBe("accepted");
      expect(await awaitTurnEnd(f.session, queued.seq, inputId(2))).toEqual({ kind: "completed" });
      expect(f.requests).toEqual(["NEXT", "LATER"]);
      expect(ends(f.session)).toHaveLength(2);
    } finally { await f.close(); }
  }, 15_000);

  test("preparation failure flushes a custom notice without retaining a run gate", async () => {
    const f = await fixture(`pi.on("before_agent_start", event => {
      if (event.prompt === "FAIL") {
        ${custom}
        // An invalid extension loadout fails native run preparation after
        // the non-triggering custom message has been held for safe append.
        event.systemPromptOptions.selectedTools = null;
      }
    });`);
    try {
      expect(await f.session.prompt("FAIL")).toMatchObject({ kind: "rejected", code: "runtime_refused" });
      expect(f.session.records().some(record => record.kind === "frame" && record.body.type === "message_end")).toBe(true);
      expect(f.requests).toEqual([]);
      expect(ends(f.session)).toEqual([]);
      expect(f.session.status().value.kind).toBe("idle");
      expect(await f.session.abort()).toMatchObject({ kind: "rejected", code: "no_active_turn" });
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
      expect(f.requests).toEqual(["NEXT"]);
    } finally { await f.close(); }
  }, 15_000);
});
