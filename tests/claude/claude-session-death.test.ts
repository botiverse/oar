import { afterEach, expect, test, vi } from "vitest";
import type { SessionRecord } from "../../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.268" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

function describe(record: SessionRecord): string {
  switch (record.kind) {
    case "event":
      return `event ${record.body.type}`;
    case "request":
      return `request ${record.body.kind}`;
    case "response":
      return record.body.kind === "exited"
        ? `response exited code=${String(record.body.code)} for=${JSON.stringify(record.requestId)}`
        : `response ${record.body.kind}`;
    default:
      return "?";
  }
}

// Pinned live on claude 2.1.268 (experiments/live-contract.ts kill-runtime,
// 2026-09-11): SIGKILL mid-turn yields an `exited` response pointing at no
// request, the turn ends as runtime_exited for observers, and every later
// control is rejected: a dead stdin must never take input over.
async function killedMidTurn(): Promise<{ session: Awaited<ReturnType<typeof claudeSession>>; promptSeq: number }> {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  const session = await claudeSession(installation, { cwd: "/work" });
  const started = await session.prompt("run something long");
  expect(started.response.body.kind).toBe("accepted");
  fake.end(null);
  return { session, promptSeq: started.request.seq };
}

test("an unrequested exit is recorded as an exit pointing at no request and ends the turn for observers", async () => {
  const { session, promptSeq } = await killedMidTurn();
  const last = session.records().at(-1);
  expect(last === undefined ? "none" : describe(last)).toBe('response exited code=null for=""');
  expect(await awaitTurnEnd(session, promptSeq)).toEqual({ kind: "failed", reason: "runtime exited", failure: "runtime_exited" });
  await session.dispose();
});

test("after an unrequested exit every control is rejected and a later dispose is answered", async () => {
  const { session } = await killedMidTurn();
  const bodies = await Promise.all([session.prompt("again"), session.steer("x"), session.queue("y"), session.abort()]);
  expect(bodies.map((result) => result.response.body)).toEqual(Array.from({ length: 4 }, () => ({ kind: "rejected", reason: "runtime exited" })));
  await session.dispose();
  expect(session.records().slice(-2).map((record) => describe(record))).toEqual(["request dispose", "response accepted"]);
});
