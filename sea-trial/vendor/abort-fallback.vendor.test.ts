import type { spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";
import type { createAbortFallback } from "../../packages/oar/src/shared/abort-fallback.js";
import { expect, test, vi } from "vitest";
import { awaitTurnEnd, claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime } from "../../packages/oar/src/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { withProcessEnv } from "./support/asserts.js";

const fault = vi.hoisted(() => ({ interrupts: 0 }));

// Real binaries and real OS exit, with one transport fault: interrupt never
// reaches stdin. A delayed provider keeps the native turn busy. This pins
// the same failure boundary as a runtime stuck without reading stdin, on
// Windows too (where SIGSTOP is unavailable).
vi.mock("../../packages/oar/src/shared/executable/index.js", async (importOriginal) => {
  const actual = await importOriginal<{ spawnLineProcess: typeof spawnLineProcess }>();
  return {
    ...actual,
    spawnLineProcess: (...args: Parameters<typeof actual.spawnLineProcess>) => {
      const child = actual.spawnLineProcess(...args);
      return {
        ...child,
        write(text: string) {
          const message = asRecord(parseJson(text));
          if (message?.method === "turn/interrupt" || asRecord(message?.request)?.subtype === "interrupt") {
            fault.interrupts += 1;
            return;
          }
          child.write(text);
        },
      };
    },
  };
});

vi.mock("../../packages/oar/src/shared/abort-fallback.js", async (importOriginal) => {
  const actual = await importOriginal<{ createAbortFallback: typeof createAbortFallback }>();
  return { createAbortFallback: (kill: () => void) => actual.createAbortFallback(kill, 200) };
});

const runtimes = [
  { id: "claude-aimock", session: claudeSession, installation: claudeInstallation, environment: startClaudeAimock },
  { id: "codex-aimock", session: codexSession, installation: codexInstallation, environment: startCodexAimock },
] as const;

for (const runtime of runtimes) {
  test.skipIf(process.env.OAR_TEST !== runtime.id)(`${runtime.id}: unanswered interrupt kills the stuck turn and settles exactly once`, async () => {
    fault.interrupts = 0;
    const env = await runtime.environment((mock) => {
      mock.onMessage(/[\s\S]*/u, { content: "too late" }, { latency: 10_000 });
    });
    try {
      await withProcessEnv({ OAR_KILL_GRACE_MS: "200" }, async () => {
        const session = await runtimeUnderTest(defineRuntime(runtime), env.env).startSession();
        try {
          const prompt = await session.prompt("hold this turn");
          expect(prompt.response.body.kind).toBe("accepted");
          await vi.waitFor(() => { expect(env.mock.getRequests().length).toBeGreaterThan(0); }, { timeout: 30_000 });
          const abort = await session.abort();
          expect(fault.interrupts).toBe(1);
          expect(abort.response.body).toMatchObject({ kind: "rejected", code: "runtime_exited" });
          expect(session.records().filter((record) => record.kind === "response" && record.requestId === abort.request.id))
            .toEqual([abort.response]);
          expect(session.records().filter((record) => record.kind === "response" && record.body.kind === "exited")).toHaveLength(1);
          expect(await awaitTurnEnd(session, prompt.request.seq)).toEqual({ kind: "failed", failure: "runtime_exited", reason: "runtime exited" });
        } finally { await session.dispose(); }
      });
    } finally { await env.stop(); }
  }, 60_000);
}
