import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getTextContent, type LLMock } from "@copilotkit/aimock";
import { describe, expect, test } from "vitest";
import { awaitIdle, awaitTurnEnd, promptAndWait, turnEndAfter, conversationOf, viewOf,
  initialStatus, reduceStatus, statusValue } from "../../packages/oar/src/observe/index.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { startPiAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { isPiBackend, piRpc, piTestRuntime } from "./support/pi-runtime.js";

const inputId = (n: number) => `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`;
async function until(ready: () => boolean, ms = 3000) {
  const end = Date.now() + ms;
  while (!ready() && Date.now() < end) { await sleep(10); }
  return ready();
}
const ends = (session: Session) => session.records().flatMap(record => record.kind === "frame"
  ? record.body.events.filter(event => event.kind === "turn_ended") : []);
async function fixture(extension: string, hold: RegExp | null = null, latency = 30) {
  const requests: string[] = [];
  const gates = new Map<string, PromiseWithResolvers<void>>();
  const gate = (text: string) => {
    let value = gates.get(text);
    if (!value) { value = Promise.withResolvers<void>(); gates.set(text, value); }
    return value;
  };
  const environment = await startPiAimock((mock: LLMock) => { mock.on({ predicate: () => true }, async request => {
    const text = getTextContent(request.messages.findLast(message => message.role === "user")?.content ?? null) ?? "";
    requests.push(text);
    await (hold?.test(text) === true ? gate(text).promise : sleep(latency));
    return { content: "reply" };
  }); });
  const dir = process.env.OAR_PI_AGENT_DIR;
  if (dir === undefined) { throw new Error("Missing isolated Pi agent directory"); }
  const hooklog = path.join(dir, "handled-hooks.log");
  await mkdir(path.join(dir, "extensions"), { recursive: true });
  await writeFile(path.join(dir, "extensions", "handled-probe.ts"), `
    import { appendFileSync } from "node:fs";
    import { setTimeout as delay } from "node:timers/promises";
    export default pi => {
      const note = value => appendFileSync(${JSON.stringify(hooklog)}, JSON.stringify(value) + "\\n");
      pi.on("input", event => { note({ type: "input", text: event.text }); });
      ${extension}
    }
  `);
  const session = await runtimeUnderTest(piTestRuntime).startSession({ model: "aimock/aimock-model" });
  return {
    session, requests, gate,
    hooks: async () => {
      const content = await readFile(hooklog, "utf8").catch(() => "");
      return content.trim().split("\n").filter(Boolean).map(line => {
        const hook: unknown = JSON.parse(line);
        return typeof hook === "object" && hook !== null && "text" in hook ? hook.text : undefined;
      });
    },
    close: async () => { for (const value of gates.values()) { value.resolve(); } await session.dispose(); await environment.stop(); },
  };
}

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

  test("an extension run competing with queued preflight is kept; a native refusal is recorded without retry", async () => {
    const f = await fixture(`let count = 0;
      pi.on("agent_settled", () => { if (count++ === 0) pi.sendUserMessage("EXT"); });
      pi.on("input", async event => { if (event.text === "B") await delay(180); return { action: "continue" }; });`, /^EXT$/u);
    try {
      await f.session.prompt("A", { inputId: inputId(1) });
      const queued = await f.session.queue("B", { inputId: inputId(2) });
      expect(await until(() => f.requests.includes("EXT"))).toBe(true);
      if (piRpc) {
        expect(await until(() => f.session.records().some(record => record.kind === "frame" && record.body.events.some(event => event.kind === "input_dropped")))).toBe(true);
        expect(turnEndAfter(f.session.records(), queued.seq, f.session.id, inputId(2))).toMatchObject({ kind: "failed" });
        expect([...conversationOf(f.session.records()).inputs.values()].find(input => input.inputId === inputId(2)))
          .toMatchObject({ state: "dropped", reason: "runtime_refused" });
      }
      expect(f.session.status().value.kind).toBe("running");
      expect(await f.session.prompt("C")).toMatchObject({ kind: "rejected", code: "busy" });
      f.gate("EXT").resolve();
      expect(await until(() => f.session.status().value.kind === "idle")).toBe(true);
      expect(f.requests).toEqual(piRpc ? ["A", "EXT"] : ["A", "EXT", "B"]);
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
});
