import { afterEach, expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";
import { inputIdOf, withdraw } from "../fixtures/withdraw.js";

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));

const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.273" } as const;

afterEach(() => {
  spawnLineProcess.mockReset();
});

/** The user messages written to claude's stdin, by text. */
function sent(fake: FakeLineProcess): string[] {
  return fake.written.flatMap((line) => {
    const message = asRecord(parseJson(line));
    const content = asRecord(message?.message)?.content;
    if (message?.type !== "user" || !Array.isArray(content)) {
      return [];
    }
    return content.map((part: unknown) => asRecord(part)?.text).filter((text): text is string => typeof text === "string");
  });
}

async function open(): Promise<{ fake: FakeLineProcess; session: Awaited<ReturnType<typeof claudeSession>> }> {
  const fake = fakeLineProcess();
  spawnLineProcess.mockReturnValue(fake);
  return { fake, session: await claudeSession(installation, { cwd: "/work" }) };
}

// claude takes no later-turn input natively (a write while a turn runs steers),
// so the adapter holds queued input and writes the next one at each turn end.
// oxlint-disable-next-line eslint/max-statements -- one held queue, withdrawn, drained and asked again, in order.
test("a queued input withdrawn before the turn ends is never written to claude", async () => {
  const { fake, session } = await open();
  const first = await session.prompt("work");
  const withdrawn = await session.queue("withdrawn");
  const kept = await session.queue("kept");
  expect([withdrawn.kind, kept.kind]).toEqual(["accepted", "accepted"]);
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("accepted");
  expect(sent(fake)).toEqual(["work"]);
  fake.emit(`${JSON.stringify({ type: "result", subtype: "success", is_error: false })}\n`);
  expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
  // The drain wrote the next held input, carrying its inputId as claude's uuid.
  expect(sent(fake)).toEqual(["work", "kept"]);
  expect(fake.written.at(-1)).toContain(inputIdOf(kept));
  expect(await withdraw(session, inputIdOf(kept))).toBe("not_queued");
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("not_queued");
  expect(await withdraw(session, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe("not_queued");
  await session.dispose();
});

test("a queue while idle is written at once, so there is nothing to withdraw; after dispose the exit answers first", async () => {
  const { fake, session } = await open();
  const queued = await session.queue("now");
  expect(sent(fake)).toEqual(["now"]);
  expect(await withdraw(session, inputIdOf(queued))).toBe("not_queued");
  await session.prompt("work");
  const held = await session.queue("held");
  await session.dispose();
  // The fake process exits as dispose kills it, so the stream already holds the exit.
  expect(await withdraw(session, inputIdOf(held))).toBe("runtime_exited");
  expect(sent(fake)).toEqual(["now", "work"]);
});
