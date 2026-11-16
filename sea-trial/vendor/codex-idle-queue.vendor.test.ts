import { describe, expect, test } from "vitest";
import { awaitTurnEnd, defineRuntime, codexRuntime } from "../../packages/oar/src/index.js";

import { startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";

const codexInstallation = codexRuntime.installation;
const codexSession = codexRuntime.session;

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex idle queue admission", () => {
  test("queue after a completed turn starts and finishes without a later prompt", async () => {
    const env = await startCodexAimock();
    try {
      const subject = runtimeUnderTest(defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation }), env.env);
      const session = await subject.startSession();
      try {
        expect(await runTurn(session, "first")).toEqual({ kind: "completed" });
        const queued = await session.queue("queued while idle", { inputId: "00000000-0000-4000-8000-000000000001" });
        expect(queued.response.body).toMatchObject({ kind: "accepted", native: { queuedSubmission: { clientUserMessageId: "00000000-0000-4000-8000-000000000001" } } });
        expect(await awaitTurnEnd(session, queued.request.seq, "00000000-0000-4000-8000-000000000001")).toEqual({ kind: "completed" });
        const requests = session.records().filter((record) => record.kind === "request").map((record) => record.body.kind);
        expect(requests).toEqual(["open", "prompt", "queue"]);
        expect(env.mock.getRequests().some((request) => JSON.stringify(request).includes("queued while idle"))).toBe(true);
      } finally { await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);

  test("queue after native interrupted completion refuses and a new prompt restores queuing", async () => {
    const waiting = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const env = await startCodexAimock((mock) => {
      mock.on({ predicate: () => true }, async (request) => {
        const latest = request.messages.findLast((message) => message.role === "user");
        if (JSON.stringify(latest).includes("hold turn")) { waiting.resolve(); await release.promise; }
        return { content: "done" };
      });
    });
    try {
      const subject = runtimeUnderTest(defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation }), env.env);
      const session = await subject.startSession();
      try {
        const held = await session.prompt("hold turn");
        expect(held.response.body.kind).toBe("accepted");
        await waiting.promise;
        const aborted = await session.abort();
        expect(aborted.response.body.kind).toBe("accepted");
        expect(await awaitTurnEnd(session, held.request.seq)).toEqual({ kind: "aborted" });
        release.resolve();
        const queued = await session.queue("must not be silently parked", { inputId: "00000000-0000-4000-8000-000000000002" });
        expect(queued.request.body).toMatchObject({ kind: "queue", inputId: "00000000-0000-4000-8000-000000000002" });
        expect(queued.response.body).toEqual({ kind: "rejected", code: "no_active_turn", reason: "Codex does not automatically consume queued input after interruption; use prompt to start a new turn" });
        expect(await runTurn(session, "resume with prompt")).toEqual({ kind: "completed" });
        const next = await session.queue("queue works again", { inputId: "00000000-0000-4000-8000-000000000003" });
        expect(next.response.body.kind).toBe("accepted");
        expect(await awaitTurnEnd(session, next.request.seq, "00000000-0000-4000-8000-000000000003")).toEqual({ kind: "completed" });
      } finally { release.resolve(); await session.dispose(); }
    } finally { await env.stop(); }
  }, 60_000);
});
