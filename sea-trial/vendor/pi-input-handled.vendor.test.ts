import { describe, expect, test } from "vitest";
import { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter, conversationOf, viewOf,
  initialStatus, reduceStatus, statusValue } from "../../packages/oar/src/observe/index.js";
import { isPiBackend, piRpc } from "./support/pi-runtime.js";
import { inputId, until, ends, fixture } from "./support/pi-input-disposition.js";

describe.skipIf(!isPiBackend)("Pi native input dispositions", () => {
  test("handled input resolves without a model turn, including an already aborted caller signal", async () => {
    const f = await fixture('pi.on("input", event => { if (event.text === "HANDLE") return { action: "handled" }; });');
    try {
      const result = await promptAndWait(f.session, "HANDLE", { inputId: inputId(1), signal: AbortSignal.abort() });
      expect(result.kind).toBe("handled");
      expect(f.requests).toEqual([]); expect(ends(f.session)).toHaveLength(0);
      expect(f.session.status().value.kind).toBe("idle");
      expect(await awaitIdle(f.session)).toBeNull();
      expect(f.session.records().some(record => record.kind === "request" && record.body.kind === "abort")).toBe(false);
      const replay = statusValue(f.session.records().reduce((state, record) => reduceStatus(state, record, f.session.id), initialStatus));
      expect(replay).toEqual(f.session.status().value);
      expect(viewOf(f.session.records()).messages.map(message => message.kind)).toEqual(["input"]);
      const next = await promptAndWait(f.session, "NEXT");
      expect(next.kind).toBe("ended");
    } finally { await f.close(); }
  }, 15_000);

  test("a handled adapter-held input has one bubble and releases the following queue entry", async () => {
    const f = await fixture('pi.on("input", event => { if (event.text === "HANDLE") return { action: "handled" }; });', /^(A|C)$/u);
    try {
      await f.session.prompt("A", { inputId: inputId(1) });
      expect(await until(() => f.requests.includes("A"))).toBe(true);
      const held = await f.session.queue("HANDLE", { inputId: inputId(2) });
      await f.session.queue("C", { inputId: inputId(3) });
      expect(held.response.body).toEqual({ kind: "accepted", queued: "adapter" });
      const handled = awaitTurnEnd(f.session, held.seq, inputId(2));
      f.gate("A").resolve();
      expect(await handled).toMatchObject({ kind: "handled" });
      expect(await until(() => f.requests.includes("C"))).toBe(true);
      expect(f.requests).toEqual(["A", "C"]); expect(ends(f.session)).toHaveLength(1);
      const inputs = viewOf(f.session.records()).messages.filter(message => message.kind === "input");
      expect(inputs.map(message => message.input.input)).toEqual(["A", "HANDLE", "C"]);
      expect(inputs[1]?.input).toMatchObject({ state: "accepted", disposition: { kind: "handled" } });
      expect(f.session.status().value.kind).toBe("running");
      const idle = awaitIdle(f.session); f.gate("C").resolve(); await idle;
      expect(f.session.status().value.kind).toBe("idle");
    } finally { await f.close(); }
  }, 15_000);

  test.skipIf(!piRpc)("an extension run competing with queued preflight is kept; a native refusal is recorded without retry", async () => {
    const f = await fixture(`let count = 0;
      pi.on("agent_settled", () => { if (count++ === 0) pi.sendUserMessage("EXT"); });
      pi.on("input", async event => { if (event.text === "B") await delay(180); return { action: "continue" }; });`, /^EXT$/u);
    try {
      await f.session.prompt("A", { inputId: inputId(1) });
      const queued = await f.session.queue("B", { inputId: inputId(2) });
      expect(await until(() => f.requests.includes("EXT"))).toBe(true);
      expect(await until(() => f.session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped")))).toBe(true);
      expect(turnEndAfter(f.session.records(), queued.seq, f.session.id, inputId(2))).toMatchObject({ kind: "failed" });
      expect([...conversationOf(f.session.records()).inputs.values()].find(input => input.inputId === inputId(2)))
        .toMatchObject({ state: "dropped", reason: "runtime_refused" });
      expect(f.session.status().value.kind).toBe("running");
      expect(await f.session.prompt("C")).toMatchObject({ kind: "rejected", code: "busy" });
      f.gate("EXT").resolve();
      expect(await until(() => f.session.status().value.kind === "idle")).toBe(true);
      expect(f.requests).toEqual(["A", "EXT"]);
      const hooks = await f.hooks();
      expect(hooks.filter(text => text === "B")).toHaveLength(1);
      const next = await promptAndWait(f.session, "NEXT");
      expect(next.kind).toBe("ended");
    } finally { await f.close(); }
  }, 15_000);

  test("a handled command's independent extension run has no command input identity", async () => {
    const f = await fixture('pi.registerCommand("spawn", { description: "probe", handler: async () => { pi.sendUserMessage("EXT"); } });', /^EXT$/u);
    try {
      const result = await promptAndWait(f.session, "/spawn", { inputId: inputId(1) });
      expect(result.kind).toBe("handled");
      expect(await until(() => f.requests.includes("EXT"))).toBe(true);
      expect(f.session.status().value).toMatchObject({ kind: "running" });
      expect(f.session.status().value).not.toHaveProperty("requestId");
      expect(f.session.status().value).not.toHaveProperty("inputId");
      expect(ends(f.session)).toHaveLength(0);
      expect(await f.session.prompt("C")).toMatchObject({ kind: "rejected", code: "busy" });
      const idle = awaitIdle(f.session); f.gate("EXT").resolve(); await idle;
      expect(ends(f.session)).toHaveLength(1);
      expect(viewOf(f.session.records()).messages.filter(message => message.kind === "turn").every(turn => turn.openedBy === undefined)).toBe(true);
    } finally { await f.close(); }
  }, 15_000);

  test("handling after an independent extension run ended keeps its outcome separate", async () => {
    const f = await fixture(`let finished;
      pi.on("agent_settled", () => { finished?.(); });
      pi.registerCommand("spawnwait", { description: "probe", handler: async () => {
        await new Promise(resolve => { finished = resolve; pi.sendUserMessage("EXT"); });
        await delay(200);
      } });`);
    try {
      const pending = promptAndWait(f.session, "/spawnwait", { inputId: inputId(1) });
      expect(await until(() => ends(f.session).length === 1)).toBe(true);
      expect(f.session.status().value.kind).toBe("running");
      expect(await f.session.prompt("cannot overtake pending handler")).toMatchObject({ kind: "rejected", code: "busy" });
      const result = await pending;
      expect(result.kind).toBe("handled");
      expect(f.requests).toEqual(["EXT"]); expect(ends(f.session)).toHaveLength(1);
      expect(await awaitTurnEnd(f.session, result.result.seq, inputId(1))).toMatchObject({ kind: "handled" });
      const turn = viewOf(f.session.records()).messages.find(message => message.kind === "turn");
      expect(turn).not.toHaveProperty("openedBy");
      expect(turn).toMatchObject({ outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 15_000);

  test("handled steer preserves the active run and its identity", async () => {
    const f = await fixture('pi.on("input", event => { if (event.text === "HANDLE") return { action: "handled" }; });', /^A$/u);
    try {
      const original = await f.session.prompt("A", { inputId: inputId(1) });
      expect(await until(() => f.requests.includes("A"))).toBe(true);
      if (f.session.steer === undefined) { throw new Error("Pi must expose native steer"); }
      const handled = await f.session.steer("HANDLE", { inputId: inputId(2) });
      expect(await awaitTurnEnd(f.session, handled.seq, inputId(2))).toMatchObject({ kind: "handled", requestId: handled.requestId });
      expect(f.session.status().value).toMatchObject({ kind: "running", requestId: original.requestId });
      expect(await f.session.prompt("NEXT")).toMatchObject({ kind: "rejected", code: "busy" });
      expect(ends(f.session)).toHaveLength(0); expect(f.requests).toEqual(["A"]);
    } finally { await f.close(); }
  }, 15_000);

  test("handled command errors remain separate native facts, never a successful turn", async () => {
    const f = await fixture('pi.registerCommand("fail", { description: "probe", handler: async () => { throw new Error("PROBE_HANDLER_FAILED"); } });');
    try {
      const result = await promptAndWait(f.session, "/fail");
      expect(result.kind).toBe("handled");
      expect(f.requests).toEqual([]); expect(ends(f.session)).toHaveLength(0);
      expect(f.session.status().value.kind).toBe("idle");
      expect(f.session.records().some(record => record.kind === "frame" && JSON.stringify(record.body.native).includes("PROBE_HANDLER_FAILED"))).toBe(true);
    } finally { await f.close(); }
  }, 15_000);
  test("abort accepted during a command preflight cancels the run started by that command", async () => {
    const f = await fixture(`let done;
      pi.on("agent_settled", () => { done?.(); });
      pi.registerCommand("spawndelay", { description: "probe", handler: async () => {
        note({ text: "command-entered" }); await delay(200);
        await new Promise(resolve => { done = resolve; pi.sendUserMessage("EXT"); });
      } });`, /^EXT$/u);
    try {
      const pending = promptAndWait(f.session, "/spawndelay", { inputId: inputId(1) });
      expect(await until(async () => { const hooks = await f.hooks(); return hooks.includes("command-entered"); })).toBe(true);
      expect(await f.session.abort()).toMatchObject({ kind: "accepted" });
      expect(await pending).toMatchObject({ kind: "handled" });
      expect(await until(() => f.session.status().value.kind === "idle")).toBe(true);
      expect(ends(f.session)).toEqual([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
      expect(f.session.records().some(record => record.kind === "response" && record.body.kind === "exited")).toBe(false);
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 20_000);

  test("settlement-triggered compaction refuses held inputs with their own receipts and reaches idle", async () => {
    const f = await fixture(`let count = 0;
      pi.on("session_before_compact", async () => { await delay(500); });
      pi.on("agent_settled", (_event, ctx) => { if (++count === 3) ctx.compact(); });`, /^A$/u, 30,
      { compaction: { keepRecentTokens: 10 } });
    try {
      await promptAndWait(f.session, `history one ${"padding ".repeat(400)}`);
      await promptAndWait(f.session, `history two ${"padding ".repeat(400)}`);
      await f.session.prompt("A");
      expect(await until(() => f.requests.includes("A"))).toBe(true);
      const b = await f.session.queue("B", { inputId: inputId(2) });
      await f.session.queue("C", { inputId: inputId(3) });
      const idle = awaitIdle(f.session);
      const rejected = awaitTurnEnd(f.session, b.seq, inputId(2));
      f.gate("A").resolve();
      expect(await rejected).toMatchObject({ kind: "failed" });
      await idle;
      expect(await until(() => f.session.status().value.kind === "idle")).toBe(true);
      expect([...conversationOf(f.session.records()).inputs.values()].find(input => input.inputId === inputId(2)))
        .toMatchObject({ state: "dropped", reason: "runtime_refused" });
      expect(f.requests).not.toContain("B");
      expect(await until(() => f.session.records().some(record => record.kind === "frame" && record.body.type === "compaction_end"))).toBe(true);
      expect(await promptAndWait(f.session, "NEXT")).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
    } finally { await f.close(); }
  }, 20_000);

});
