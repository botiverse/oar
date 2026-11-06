import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { dshInstallation, dshRuntime, SessionNotFoundError, UnsupportedOptionError } from "../../packages/oar/src/index.js";
import { DSH_MINIMUM_VERSION, compareSemver } from "../../packages/oar/src/runtimes/dsh/version.js";
import { dshEnabled, eventsOf, expectedDirectory, nativeOf, nativeShell, reportsSelection, say, shellDirectory, untilCount, untilEvent, withDshFixture } from "./support/dsh-fixture.js";
import { resolveRunDir } from "../harness/trace.js";
import { durableEvents, lastInput, toolResults } from "./support/dsh-provider.js";

describe.skipIf(!dshEnabled)("DSH native sessions", () => {
  test("the installed version is at or above the floor, by semver", async () => {
    const installation = await dshInstallation();
    assert.ok(installation.kind === "available" && installation.via === "executable" && installation.version !== undefined, JSON.stringify(installation));
    assert.ok((compareSemver(installation.version, DSH_MINIMUM_VERSION) ?? -1) >= 0, installation.version);
  }, 30_000);

  test("listModels reads the native catalog of the configured route, with its effort menu and default", async () => {
    await withDshFixture(() => say("never"), async ({ aimock, installation, provider }) => {
      const listed = await dshRuntime.listModels(installation, { cwd: aimock.cwd, env: aimock.env });
      assert.ok(listed.kind === "ok", JSON.stringify(listed));
      expect(listed.models.find((model) => model.id === "aimock/aimock-model")).toMatchObject({ provider: { id: "aimock" }, effortLevels: ["low", "high"], default: true });
      expect(provider.requests).toEqual([]);
    });
  }, 60_000);

  test("open records the inventory, runs isolated, and writes nothing to the user's patch", async () => {
    await withDshFixture(() => say("hello"), async ({ aimock, open }) => {
      const patch = path.join(aimock.home, "cordis.patch.yml");
      const before = await readFile(patch);
      const session = await open();
      expect(session.placement).toBe("isolated");
      expect(session.capabilities).toEqual({ queue: { durable: false }, attribution: "nested", images: false });
      expect(nativeOf(session, "dsh/ready")[0]).toMatchObject({ protocol: 1, services: { agents: { create: true, resume: true }, sessionPersistence: { open: true, flush: true } } });
      expect(nativeOf(session, "dsh/opened")[0]).toMatchObject({ sessionId: session.id, header: { id: session.id }, methods: { followup: true, steer: true, cancel: true }, inboxMethods: { remove: true } });
      expect(typeof session.steer).toBe("function");
      expect(typeof session.withdraw).toBe("function");
      await session.dispose();
      expect(await readFile(patch)).toEqual(before);
    });
  }, 60_000);

  test("a tool turn: streamed arguments, native tool result, one copy of the text, native usage", async () => {
    const command = nativeShell.where;
    await withDshFixture((request) => toolResults(request) === 0
      ? { kind: "tool", name: nativeShell.tool, arguments: command, id: "call-pwd" }
      : { kind: "say", text: "the answer", reasoning: "thinking it over" }, async ({ aimock, open }) => {
      const session = await open();
      expect(session.model().value).toBe(reportsSelection(session) ? "aimock/aimock-model" : null);
      const started = await session.prompt("where are you");
      expect(started.kind).toBe("accepted");
      assert.ok(started.request.body.kind === "prompt");
      const { inputId } = started.request.body;
      expect(await awaitTurnEnd(session, started.seq, inputId)).toEqual({ kind: "completed" });
      const seen = eventsOf(session.records());
      expect(seen.filter((event) => event.kind === "user_message")).toEqual([{ kind: "user_message", input: "where are you", inputId, nativeMessageId: inputId, evidence: "turn_item" }]);
      expect(seen.find((event) => event.kind === "turn_active")).toEqual({ kind: "turn_active", inputId });
      const tools = seen.filter((event) => event.kind === "tool_call_started" || event.kind === "tool_call_ended");
      expect(tools).toEqual([
        { kind: "tool_call_started", callId: "call-pwd", tool: nativeShell.tool, input: JSON.stringify(command) },
        expect.objectContaining({ kind: "tool_call_ended", callId: "call-pwd", result: "ok" }),
      ]);
      const ended = tools[1];
      assert.ok(ended?.kind === "tool_call_ended");
      const output = ended.content?.[0];
      assert.ok(output?.type === "text");
      expect(shellDirectory(output.text)).toBe(expectedDirectory(aimock.cwd));
      const deltas = seen.flatMap((event) => event.kind === "tool_call_input_delta" ? [event.delta] : []);
      expect(deltas.join("")).toBe(JSON.stringify(command));
      expect(seen.flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")).toBe("the answer");
      expect(seen.some((event) => event.kind === "reasoning")).toBe(true);
      expect(session.model().value).toBe("aimock/aimock-model");
      // Two requests of 60 fresh plus 40 cached input and 12 output, as the provider reported them.
      expect(session.usage().value.total).toEqual({ input: 200, output: 24, cacheRead: 80 });
      expect(session.contextUsage().value).toEqual({ tokens: 112, contextWindow: 128_000, percent: 0 });
      expect(seen.filter((event) => event.kind === "turn_ended")).toHaveLength(1);
      await session.dispose();
    });
  }, 60_000);

  test("every forwarded durable event equals the native persisted log, in order", async () => {
    await withDshFixture((request) => toolResults(request) === 0
      ? { kind: "tool", name: nativeShell.tool, arguments: nativeShell.where }
      : say("the answer"), async ({ aimock, open }) => {
      const session = await open();
      const started = await session.prompt("persist me");
      await awaitTurnEnd(session, started.seq);
      await session.dispose();
      const forwarded = session.records().flatMap((record) => record.kind === "frame" && record.body.type.startsWith("session/event:") ? [record.body.native] : []);
      const durable = await durableEvents(aimock.home, session.id);
      expect(forwarded.length).toBeGreaterThan(5);
      expect(forwarded).toEqual(durable);
    });
  }, 60_000);

  test("resume keeps the id, the history, the saved directory and the saved model; another cwd is refused", async () => {
    await withDshFixture((request) => lastInput(request).includes("WHERE") && toolResults(request) === 0
      ? { kind: "tool", name: nativeShell.tool, arguments: nativeShell.where }
      : say("noted"), async ({ provider, aimock, open }) => {
      const first = await open();
      const prompted = await first.prompt("REMEMBER_MARKER");
      await awaitTurnEnd(first, prompted.seq);
      await first.dispose();
      const elsewhere = path.join(aimock.cwd, "elsewhere");
      await mkdir(elsewhere);
      const refused = await open({ resume: first.id, cwd: elsewhere }).catch((error: unknown) => error);
      expect(refused).toBeInstanceOf(UnsupportedOptionError);
      expect(refused).toMatchObject({ option: "cwd" });
      expect(String(refused)).toContain(aimock.cwd);
      const resumed = await open({ resume: first.id });
      expect(resumed.id).toBe(first.id);
      const asked = await resumed.prompt("WHERE are you");
      expect(await awaitTurnEnd(resumed, asked.seq)).toEqual({ kind: "completed" });
      expect(JSON.stringify(provider.requests.at(-1)?.messages)).toContain("REMEMBER_MARKER");
      expect(resumed.model().value).toBe("aimock/aimock-model");
      const ended = eventsOf(resumed.records()).find((event) => event.kind === "tool_call_ended");
      assert.ok(ended?.kind === "tool_call_ended");
      const output = ended.content?.[0];
      assert.ok(output?.type === "text");
      expect(shellDirectory(output.text)).toBe(expectedDirectory(aimock.cwd));
      await resumed.dispose();
    });
  }, 90_000);

  test("a session that was never saved is SessionNotFoundError, with no provider request", async () => {
    await withDshFixture(() => say("never"), async ({ provider, open }) => {
      const missing = "00000000-0000-4000-8000-000000000000";
      const failure = await open({ resume: missing }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(SessionNotFoundError);
      expect(failure).toMatchObject({ sessionId: missing, cause: { method: "sessionPersistence.open", native: { name: "SessionPersistenceNotFoundError" } } });
      expect(provider.requests).toEqual([]);
    });
  }, 60_000);

  test.each(["before-parent", "after-parent"] as const)("a native child settles %s and keeps its catalog edge", async (order) => {
    let heldParent = false;
    await withDshFixture((request) => {
      const input = lastInput(request);
      if (input.includes("CHILD_ONLY")) { return order === "after-parent" ? { kind: "hold", text: "child answer" } : say("child answer"); }
      if (input.includes("SPAWN") && toolResults(request) === 0) {
        return { kind: "tool", name: "subagent", arguments: { description: "kid", prompt: "CHILD_ONLY" } };
      }
      if (order === "before-parent" && !heldParent) { heldParent = true; return { kind: "hold", text: "parent answer" }; }
      return say("parent answer");
    }, async ({ open, provider }) => {
      const session = await open();
      try {
        const started = await session.prompt("SPAWN one");
        // DSH steers a running parent and queues a new turn only when it is idle.
        if (order === "after-parent") { expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" }); }
        await provider.held();
        if (order === "before-parent") { await untilEvent(session, (event) => event.kind === "task_ended"); }
        provider.release();
        expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "completed" });
        await untilEvent(session, (event) => event.kind === "task_ended");
        const task = eventsOf(session.records()).find((event) => event.kind === "task_started");
        assert.ok(task?.kind === "task_started" && task.childSessionId !== undefined);
        const child = task.childSessionId;
        expect(task).toMatchObject({ taskType: "agent", nativeType: "spawn", childSessionId: child });
        expect(eventsOf(session.records()).find((event) => event.kind === "task_ended")).toEqual({ kind: "task_ended", taskId: task.taskId, status: "completed" });
        expect(session.graph().edges).toEqual([{ parent: session.id, child, via: "tool_call" }]);
        expect(eventsOf(session.records(), child).flatMap((event) => event.kind === "text_delta" ? [event.text] : []).join("")).toBe("child answer");
        const rootEnds = () => session.records().filter((record) => record.kind === "frame" && record.sessionId === session.id && record.body.events.some((event) => event.kind === "turn_ended"));
        const wanted = order === "after-parent" ? 2 : 1;
        await untilCount(() => rootEnds().length, wanted);
        expect(rootEnds()).toHaveLength(wanted);
        const notice = session.records().find(record => record.kind === "frame" && record.sessionId === session.id && record.body.type === "session/event:user/message" && JSON.stringify(record.body.native).includes("subagent-settled"));
        const firstEnd = rootEnds()[0]; const lastEnd = rootEnds().at(-1);
        assert.ok(notice !== undefined && firstEnd !== undefined && lastEnd !== undefined);
        // The notice must have been consumed in the turn whose end we counted.
        expect(notice.seq).toBeLessThan(lastEnd.seq);
        if (order === "after-parent") { expect(notice.seq).toBeGreaterThan(firstEnd.seq); }
        expect(session.status().value.kind).toBe("idle");
        await session.dispose();
      } finally {
        await writeFile(path.join(resolveRunDir(), `dsh-child-${order}.json`), JSON.stringify({ order, requests: provider.requests, records: session.records() }, null, 2));
      }
    });
  }, 60_000);
});
