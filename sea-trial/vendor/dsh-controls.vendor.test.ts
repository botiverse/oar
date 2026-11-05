/* oxlint-disable import/max-dependencies -- One native suite of controls, with the fixture its missing-method case builds by hand. */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { dshInstallation, dshRuntime, RuntimeFailureError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { parseJson } from "../../packages/oar/src/shared/json.js";
import { startDshAimock } from "../harness/dsh-aimock.js";
import { dshEnabled, eventsOf, nativeOf, posix, reportsSelection, say, untilCount, untilEvent, withDshFixture } from "./support/dsh-fixture.js";
import { lastInput, startDshProvider, toolResults, type Reply } from "./support/dsh-provider.js";

const held = (request: Parameters<typeof lastInput>[0]): Reply => lastInput(request).includes("HOLD") ? { kind: "hold", text: "partial" } : say("fine");

async function ownedBridgeDirectories(): Promise<readonly string[]> {
  const names = await readdir(tmpdir());
  return names.filter((name) => name.startsWith(`oar-dsh-${String(process.pid)}-`));
}

describe.skipIf(!dshEnabled)("DSH native controls", () => {
  test("steer joins the running turn at the next step and reaches the model", async () => {
    await withDshFixture(held, async ({ provider, open }) => {
      const session = await open();
      const started = await session.prompt("HOLD this");
      await provider.held();
      const steer = session.steer?.bind(session);
      assert.ok(steer !== undefined);
      const steered = await steer("STEER_MARKER");
      expect(steered.kind).toBe("accepted");
      assert.ok(steered.request.body.kind === "steer");
      const { inputId } = steered.request.body;
      provider.release();
      expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
      expect(provider.sent("STEER_MARKER")).toBe(true);
      expect(eventsOf(session.records()).filter((event) => event.kind === "turn_ended")).toHaveLength(1);
      expect(eventsOf(session.records()).filter((event) => event.kind === "user_message" && event.inputId === inputId)).toHaveLength(1);
      expect(await steer("too late")).toMatchObject({ kind: "rejected", code: "no_active_turn" });
      await session.dispose();
    });
  }, 60_000);

  test("a queued input runs as its own turn; a withdrawn one never reaches the provider", async () => {
    await withDshFixture(held, async ({ provider, open }) => {
      const session = await open();
      const started = await session.prompt("HOLD this");
      await provider.held();
      expect(await session.prompt("second")).toMatchObject({ kind: "rejected", code: "busy", reason: "busy" });
      const kept = await session.queue("QUEUED_KEEP");
      const removed = await session.queue("QUEUED_REMOVE");
      expect(kept.kind).toBe("accepted");
      assert.ok(removed.request.body.kind === "queue" && kept.request.body.kind === "queue");
      const { inputId } = removed.request.body;
      const keptId = kept.request.body.inputId;
      assert.ok(inputId !== undefined);
      const withdraw = session.withdraw?.bind(session);
      assert.ok(withdraw !== undefined);
      const taken = await withdraw(inputId);
      expect(taken.kind).toBe("accepted");
      expect(await withdraw(inputId)).toMatchObject({ kind: "rejected", code: "not_queued" });
      provider.release();
      await awaitTurnEnd(session, started.seq);
      await untilEvent(session, (event) => event.kind === "turn_active" && event.inputId === keptId);
      await untilEvent(session, (event) => event.kind === "user_message" && event.input === "QUEUED_KEEP");
      const ends = (): number => eventsOf(session.records()).filter((event) => event.kind === "turn_ended").length;
      await untilCount(ends, 2);
      expect(ends()).toBe(2);
      expect(provider.sent("QUEUED_KEEP")).toBe(true);
      expect(provider.sent("QUEUED_REMOVE")).toBe(false);
      expect(eventsOf(session.records()).filter((event) => event.kind === "input_dropped")).toEqual([]);
      await session.dispose();
    });
  }, 60_000);

  test("abort ends the turn with the native report and hands queued and steered input back", async () => {
    await withDshFixture(held, async ({ provider, open }) => {
      const session = await open();
      const started = await session.prompt("HOLD this");
      await provider.held();
      const queued = await session.queue("QUEUED_LOST");
      const steered = await session.steer?.("STEER_LOST");
      assert.ok(steered !== undefined && queued.request.body.kind === "queue" && steered.request.body.kind === "steer");
      const aborted = await session.abort();
      expect(aborted.kind).toBe("accepted");
      expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "aborted" });
      expect(session.status().value.kind).toBe("idle");
      expect(eventsOf(session.records()).filter((event) => event.kind === "input_dropped")).toEqual([
        { kind: "input_dropped", inputId: steered.request.body.inputId, reason: "turn_interrupted" },
        { kind: "input_dropped", inputId: queued.request.body.inputId, reason: "turn_interrupted" },
      ]);
      expect(nativeOf(session, "session/event:turn/end").at(-1)).toMatchObject({ data: { reason: { kind: "aborted", reason: { kind: "user" } } } });
      expect(provider.sent("QUEUED_LOST")).toBe(false);
      expect(await session.abort()).toMatchObject({ kind: "rejected", code: "no_active_turn" });
      const after = await session.prompt("next");
      expect(after.kind).toBe("accepted");
      await awaitTurnEnd(session, after.seq);
      await session.dispose();
    });
  }, 60_000);

  test("dispose mid-turn answers with the process exit and leaves no bridge directory", async () => {
    await withDshFixture(() => ({ kind: "hold", text: "partial" }), async ({ provider, open }) => {
      const session = await open();
      expect(await ownedBridgeDirectories()).toHaveLength(1);
      const started = await session.prompt("hold");
      expect(started.kind).toBe("accepted");
      await provider.held();
      await session.dispose();
      expect(nativeOf(session, "session/event:turn/end").at(-1)).toMatchObject({ data: { reason: { kind: "aborted", reason: { kind: "disposed" } } } });
      const answer = session.records().find((record) => record.kind === "response" && record.body.kind === "exited");
      assert.ok(answer?.kind === "response" && answer.body.kind === "exited");
      expect(answer.body.code).toBe(0);
      expect(await session.resources?.()).toBeNull();
      expect(await ownedBridgeDirectories()).toEqual([]);
      expect(await session.prompt("after")).toMatchObject({ kind: "rejected", code: "runtime_exited" });
    });
  }, 60_000);

  test.skipIf(!posix)("a process that dies mid-turn is an exited response and a failed turn", async () => {
    await withDshFixture((request) => toolResults(request) === 0 ? { kind: "tool", name: "bash", arguments: { description: "die", command: "kill -9 $PPID" } } : say("never"), async ({ open }) => {
      const session = await open();
      const started = await session.prompt("die");
      expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "failed", failure: "runtime_exited" });
      expect(await session.prompt("after")).toMatchObject({ kind: "rejected", code: "runtime_exited" });
    });
  }, 60_000);

  test("provider failures keep the runtime's words and its class", async () => {
    const replies: Readonly<Record<string, Reply>> = {
      AUTH_CASE: { kind: "error", status: 401, body: { message: "bad key", code: "invalid_api_key" } },
      BAD_CASE: { kind: "error", status: 400, body: { message: "bad request" } },
      PAY_CASE: { kind: "error", status: 402, body: { message: "pay" } },
      LENGTH_CASE: { kind: "length", text: "truncated" },
    };
    await withDshFixture((request) => {
      const name = Object.keys(replies).find((key) => lastInput(request).includes(key));
      return (name === undefined ? undefined : replies[name]) ?? say("ok");
    }, async ({ open }) => {
      const session = await open();
      const outcomes: unknown[] = [];
      for (const name of Object.keys(replies)) {
        // oxlint-disable-next-line no-await-in-loop -- One turn at a time keeps each outcome attributable.
        const started = await session.prompt(name);
        // oxlint-disable-next-line no-await-in-loop -- As above.
        outcomes.push(await awaitTurnEnd(session, started.seq));
      }
      expect(outcomes).toEqual([
        { kind: "failed", failure: "auth", reason: `401: ${JSON.stringify({ message: "bad key", code: "invalid_api_key" })}` },
        { kind: "failed", failure: "invalid_request", reason: `400: ${JSON.stringify({ message: "bad request" })}` },
        { kind: "failed", failure: "unknown", reason: `402: ${JSON.stringify({ message: "pay" })}` },
        { kind: "failed", failure: "limit_reached", reason: "DSH ended the turn at its output-token limit" },
      ]);
      await session.dispose();
    });
  }, 90_000);

  test("a model or effort the route cannot run is refused at open, before any request", async () => {
    await withDshFixture(() => say("never"), async ({ provider, open }) => {
      expect(await open({ model: "aimock/no-such-model" }).catch((error: unknown) => error)).toBeInstanceOf(RuntimeFailureError);
      expect(await open({ model: "no-such-provider/m" }).catch((error: unknown) => error)).toMatchObject({ failure: "model_unavailable" });
      const effort = await open({ effort: "oar-no-such-effort" }).catch((error: unknown) => error);
      expect(effort).toBeInstanceOf(UnsupportedOptionError);
      expect(effort).toMatchObject({ option: "effort" });
      expect(String(effort)).toContain("oar-no-such-effort");
      const bare = await open({ model: "no-provider" }).catch((error: unknown) => error);
      expect(bare).toBeInstanceOf(UnsupportedOptionError);
      expect(bare).toMatchObject({ option: "model" });
      expect(provider.requests).toEqual([]);
    });
  }, 60_000);

  test("a listed effort reaches the request, reads back from native frames, and can change on resume", async () => {
    await withDshFixture(() => say("ok"), async ({ provider, open }) => {
      const first = await open({ effort: "high" });
      expect(first.effort().value).toBe(reportsSelection(first) ? "high" : null);
      const started = await first.prompt("hello");
      expect(await awaitTurnEnd(first, started.seq)).toEqual({ kind: "completed" });
      expect(first.effort().value).toBe("high");
      expect(provider.requests.at(-1)?.body.reasoning_effort).toBe("high");
      await first.dispose();
      const resumed = await open({ resume: first.id, effort: "low" });
      const again = await resumed.prompt("hello again");
      expect(await awaitTurnEnd(resumed, again.seq)).toEqual({ kind: "completed" });
      expect(resumed.effort().value).toBe("low");
      expect(provider.requests.at(-1)?.body.reasoning_effort).toBe("low");
      await resumed.dispose();
    }, { models: [{ id: "aimock-model", contextWindow: 128_000, maxTokens: 4096, reasoningEfforts: { low: "low", high: "high" } }] });
  }, 90_000);

  test("a different model on resume is the model that runs", async () => {
    await withDshFixture(() => say("ok"), async ({ provider, open }) => {
      const first = await open({ model: "aimock/aimock-model" });
      const started = await first.prompt("hello");
      await awaitTurnEnd(first, started.seq);
      expect(provider.requests.at(-1)?.body.model).toBe("aimock-model");
      await first.dispose();
      const resumed = await open({ resume: first.id, model: "aimock/other-model" });
      const again = await resumed.prompt("hello again");
      expect(await awaitTurnEnd(resumed, again.seq)).toEqual({ kind: "completed" });
      expect(provider.requests.at(-1)?.body.model).toBe("other-model");
      expect(resumed.model().value).toBe("aimock/other-model");
      await resumed.dispose();
    }, { models: [{ id: "aimock-model", contextWindow: 128_000, maxTokens: 4096 }, { id: "other-model", contextWindow: 128_000, maxTokens: 4096 }] });
  }, 90_000);

  test("a missing native method makes its control refused with the reason, in the real process", async () => {
    const provider = await startDshProvider(() => say("never"));
    const dir = await startDshAimock({ providerUrl: provider.url });
    const plugin = path.join(dir.cwd, "strip-methods.mjs");
    await writeFile(plugin, `export const name = "oar-test-strip-methods";
export function apply(ctx) {
  void (async () => {
    await ctx.get("loader").await();
    const agents = ctx.get("agents");
    const create = agents.create.bind(agents);
    const wrapped = async (options) => {
      const handle = await create(options);
      for (const key of ["steer", "followup", "cancel"]) { Object.defineProperty(handle.agent, key, { value: undefined }); }
      Object.defineProperty(handle.agent.inbox, "remove", { value: undefined });
      return handle;
    };
    Object.getPrototypeOf(agents).create = wrapped;
    agents.create = wrapped;
  })();
}
`);
    const patch = path.join(dir.home, "cordis.patch.yml");
    const parsed: unknown = parseJson(await readFile(patch, "utf8"));
    assert.ok(Array.isArray(parsed));
    const rows: readonly unknown[] = parsed;
    await writeFile(patch, `${JSON.stringify([...rows, { insert: [{ id: "oar-test-strip-methods", name: plugin }] }])}\n`);
    try {
      const installation = await dshInstallation();
      assert.ok(installation.kind === "available");
      const session = await dshRuntime.session(installation, { cwd: dir.cwd, env: dir.env });
      expect(nativeOf(session, "dsh/opened")[0]).toMatchObject({ methods: { steer: false, followup: false, cancel: false }, inboxMethods: { remove: false } });
      expect(session.steer === undefined).toBe(true);
      expect(session.withdraw === undefined).toBe(true);
      expect(await session.prompt("hello")).toMatchObject({ kind: "rejected", code: "unsupported", reason: "This DSH does not provide followup(), which prompt requires" });
      expect(await session.queue("hello")).toMatchObject({ kind: "rejected", code: "unsupported", reason: "This DSH does not provide followup(), which queue requires" });
      expect(await session.abort()).toMatchObject({ kind: "rejected", code: "unsupported", reason: "This DSH does not provide cancel(), which abort requires" });
      expect(provider.requests).toEqual([]);
      await session.dispose();
    } finally { await dir.stop(); await provider.stop(); }
  }, 60_000);
});
