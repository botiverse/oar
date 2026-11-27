import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { awaitTurnEnd, codexRuntime, SessionNotFoundError } from "../../packages/oar/src/index.js";
import { removeFixtureDirectory } from "../harness/fixture-directory-cleanup.js";
import { startCodexAimock } from "../harness/aimock.js";
import { expectAvailable, runTurn } from "./support/asserts.js";

async function hasRolloutFile(codexHome: string, threadId: string): Promise<boolean> {
  const entries = await readdir(codexHome, { recursive: true, withFileTypes: true });
  return entries.some((entry) => entry.isFile() && entry.name.endsWith(`${threadId}.jsonl`));
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex ephemeral sessions", () => {
  test("ephemeral thread/start supports prompt, steer, adapter-held queue/withdraw, abort, compact, and writes no rollout", async () => {
    let holdText: string | null = null;
    let entered = Promise.withResolvers<void>();
    let release = Promise.withResolvers<void>();
    const armHold = (marker: string): void => {
      holdText = marker;
      entered = Promise.withResolvers<void>();
      release = Promise.withResolvers<void>();
    };
    const env = await startCodexAimock((mock) => {
      mock.on({ predicate: () => true }, async (request) => {
        const latest = JSON.stringify(request.messages.findLast((message) => message.role === "user") ?? "");
        if (holdText !== null && latest.includes(holdText)) {
          entered.resolve();
          await release.promise;
        }
        return {
          content: `EPHEMERAL_OK ${"Summary padding for compaction context. ".repeat(40)}`,
          usage: { input_tokens: 1000, output_tokens: 400 },
        };
      });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-codex-ephem-start-"));
    const sessionEnv = env.env ?? {};
    const codexHome = String(sessionEnv.CODEX_HOME);
    try {
      const installation = await codexRuntime.installation();
      expectAvailable(installation, "codex");
      const session = await codexRuntime.session(installation, { cwd, env: sessionEnv, ephemeral: true });
      const threadId = session.id;
      try {
        expect("nativeSessionFile" in session).toBe(false);
        expect(session.capabilities.queue.durable).toBe(false);
        expect("withdraw" in session).toBe(true);

        // Plain prompt.
        expect(await runTurn(session, "EPHEM_PLAIN_PROMPT")).toEqual({ kind: "completed" });

        // Steer into an active turn.
        armHold("EPHEM_HOLD_STEER");
        const steerBase = await session.prompt("EPHEM_HOLD_STEER");
        expect(steerBase.kind).toBe("accepted");
        await entered.promise;
        const steered = await session.steer?.("EPHEM_STEER_NOTE");
        expect(steered?.kind).toBe("accepted");
        holdText = null;
        release.resolve();
        expect(await awaitTurnEnd(session, steerBase.request.seq)).toEqual({ kind: "completed" });

        // Adapter-held queue + withdraw during an active turn.
        armHold("EPHEM_HOLD_QUEUE");
        const queueBase = await session.prompt("EPHEM_HOLD_QUEUE");
        expect(queueBase.kind).toBe("accepted");
        await entered.promise;
        const dropId = "00000000-0000-4000-8000-000000000101";
        const runId = "00000000-0000-4000-8000-000000000102";
        const qDrop = await session.queue("EPHEM_QUEUED_WITHDRAWN", { inputId: dropId });
        const qRun = await session.queue("EPHEM_QUEUED_DRAINED", { inputId: runId });
        expect(qDrop.response.body).toEqual({ kind: "accepted", queued: "adapter" });
        expect(qRun.response.body).toEqual({ kind: "accepted", queued: "adapter" });
        expect(await session.withdraw?.(dropId)).toMatchObject({ kind: "accepted" });
        const waitingDrain = awaitTurnEnd(session, qRun.request.seq, runId);
        holdText = null;
        release.resolve();
        expect(await awaitTurnEnd(session, queueBase.request.seq)).toEqual({ kind: "completed" });
        expect(await waitingDrain).toEqual({ kind: "completed" });
        expect(await session.withdraw?.(runId)).toMatchObject({ kind: "rejected", code: "not_queued" });

        const seen = env.mock.getRequests().map((request) => JSON.stringify(request));
        expect(seen.some((body) => body.includes("EPHEM_QUEUED_DRAINED"))).toBe(true);
        expect(seen.some((body) => body.includes("EPHEM_QUEUED_WITHDRAWN"))).toBe(false);

        // Abort an active turn.
        armHold("EPHEM_HOLD_ABORT");
        const abortBase = await session.prompt("EPHEM_HOLD_ABORT");
        expect(abortBase.kind).toBe("accepted");
        await entered.promise;
        expect(await session.abort()).toMatchObject({ kind: "accepted" });
        expect(await awaitTurnEnd(session, abortBase.request.seq)).toEqual({ kind: "aborted" });
        holdText = null;
        release.resolve();

        // Manual compaction on an ephemeral thread.
        const compacted = await session.compact?.({ timeoutMs: 30_000 });
        expect(compacted).toMatchObject({ kind: "completed" });
      } finally {
        holdText = null;
        release.resolve();
        await session.dispose();
      }

      // No rollout materialized on disk and resume fails with SessionNotFoundError.
      expect(await hasRolloutFile(codexHome, threadId)).toBe(false);
      await expect(codexRuntime.session(installation, { cwd, env: sessionEnv, resume: threadId })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      await removeFixtureDirectory(cwd, "codex-ephemeral-start");
      await env.stop();
    }
  }, 120_000);

  test("ephemeral thread/fork carries source history, applies effort via thread/settings/update, writes no rollout, and cannot resume", async () => {
    const env = await startCodexAimock((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "FORK_OK" });
    });
    const cwd = await mkdtemp(path.join(tmpdir(), "oar-codex-ephem-fork-"));
    const sessionEnv = env.env ?? {};
    const codexHome = String(sessionEnv.CODEX_HOME);
    try {
      const installation = await codexRuntime.installation();
      expectAvailable(installation, "codex");

      const source = await codexRuntime.session(installation, { cwd, env: sessionEnv });
      const sourceId = source.id;
      try {
        expect(await runTurn(source, "remember EPHEMERAL-FORK-TOKEN")).toEqual({ kind: "completed" });
      } finally {
        await source.dispose();
      }
      expect(await hasRolloutFile(codexHome, sourceId)).toBe(true);

      const forked = await codexRuntime.session(installation, {
        cwd,
        env: sessionEnv,
        resume: sourceId,
        fork: {},
        ephemeral: true,
        effort: "low",
      });
      const forkId = forked.id;
      try {
        expect(forkId).not.toBe(sourceId);
        expect("nativeSessionFile" in forked).toBe(false);
        expect(forked.capabilities.queue.durable).toBe(false);
        expect("withdraw" in forked).toBe(true);
        expect(forked.effort().value).toBe("low");
        expect(await runTurn(forked, "EPHEM_FORK_QUESTION")).toEqual({ kind: "completed" });
      } finally {
        await forked.dispose();
      }

      const forkRequest = env.mock.getRequests().find((request) => JSON.stringify(request).includes("EPHEM_FORK_QUESTION"));
      expect(JSON.stringify(forkRequest)).toContain("EPHEMERAL-FORK-TOKEN");
      expect(await hasRolloutFile(codexHome, forkId)).toBe(false);
      await expect(codexRuntime.session(installation, { cwd, env: sessionEnv, resume: forkId })).rejects.toBeInstanceOf(SessionNotFoundError);
    } finally {
      await removeFixtureDirectory(cwd, "codex-ephemeral-fork");
      await env.stop();
    }
  }, 120_000);
});
