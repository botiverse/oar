/* oxlint-disable promise/prefer-await-to-then, promise/always-return, typescript/promise-function-async -- Observation must return the original native promise unchanged. */
import path from "node:path";
import type { codexInstallation } from "../../packages/oar/src/runtimes/codex/installation.js";
import type { codexSession } from "../../packages/oar/src/runtimes/codex/session.js";
import { afterAll, afterEach, beforeEach, expect, vi } from "vitest";
import { codexPhaseRecord, observeCodexPhase, setCodexPhaseContext } from "./codex-phases.js";

function context(): { file: string | null; test: string | null } {
  const state = expect.getState();
  return { file: state.testPath === undefined ? null : path.relative(process.cwd(), state.testPath), test: state.currentTestName ?? null };
}

setCodexPhaseContext(context);
codexPhaseRecord("worker_file_entered");
beforeEach(() => { codexPhaseRecord("case_entered"); });
afterEach(() => { codexPhaseRecord("case_hooks_finished"); });
afterAll(() => { codexPhaseRecord("worker_file_finished"); });

// These taps return the original native promise and Session. No synthetic
// provider, lifecycle, admission, or cleanup behavior replaces the adapter.
vi.mock("../../packages/oar/src/runtimes/codex/installation.js", async (original) => {
  const module = await original<{ codexInstallation: typeof codexInstallation }>();
  return { ...module, codexInstallation: (...args: Parameters<typeof module.codexInstallation>): ReturnType<typeof module.codexInstallation> => observeCodexPhase("installation", () => module.codexInstallation(...args)) };
});

vi.mock("../../packages/oar/src/runtimes/codex/session.js", async (original) => {
  const module = await original<{ codexSession: typeof codexSession }>();
  let sequence = 0;
  return {
    ...module,
    codexSession: (...args: Parameters<typeof module.codexSession>): ReturnType<typeof module.codexSession> => {
      const origin = { ...context(), observedSession: ++sequence };
      const pending = observeCodexPhase("session.open", () => module.codexSession(...args));
      void pending.then((session) => {
        session.rawEvents((record) => {
          if (record.kind === "request" && record.body.kind === "dispose") {
            codexPhaseRecord("session.dispose.request", { ...origin, seq: record.seq });
          } else if (record.kind === "response" && (record.body.kind === "exited" || record.body.kind === "rejected")) {
            codexPhaseRecord("session.response", { ...origin, seq: record.seq, response: record.body.kind });
          } else if (record.kind === "frame" && record.body.events.some(event => event.kind === "turn_active" || event.kind === "turn_ended")) {
            codexPhaseRecord("session.native", { ...origin, seq: record.seq, frameType: record.body.type, events: record.body.events.map(event => event.kind), outcomes: record.body.events.flatMap(event => event.kind === "turn_ended" ? [event.outcome.kind] : []) });
          }
        }, { sessionId: session.id, afterSeq: -1 });
      }).catch(() => { /* The original rejection still reaches the test. */ });
      return pending;
    },
  };
});
