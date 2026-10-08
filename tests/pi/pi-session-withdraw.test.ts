/* oxlint-disable eslint/max-classes-per-file -- one stand-in. */
import { setImmediate as settle } from "node:timers/promises";
import { expect, test, vi } from "vitest";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { piSession } from "../../packages/oar/src/runtimes/pi/session.js";
import { inputIdOf, withdraw } from "../fixtures/withdraw.js";

/**
 * A stand-in for the slice of pi's AgentSession (SDK 1.1.0) the adapter
 * drives: `prompt` starts a run (`agent_start`) that lasts until the test
 * ends it with pi's own `agent_end` then `agent_settled`.
 */
class FakePiSession {
  readonly sessionId = "pi-session-1";
  readonly thinkingLevel = "off";
  readonly model = undefined;
  readonly extensionRunner = { emit: async (): Promise<void> => {} };
  readonly prompts: string[] = [];
  deferStart = false;
  isStreaming = false;
  private readonly listeners: ((event: unknown) => void)[] = [];
  private finish: (() => void) | null = null;

  subscribe(listener: (event: unknown) => void): () => void {
    this.listeners.push(listener);
    return () => {};
  }

  getContextUsage(): undefined {
    return undefined;
  }

  async prompt(input: string): Promise<void> {
    this.prompts.push(input);
    const { promise, resolve } = Promise.withResolvers<void>();
    this.finish = resolve;
    if (!this.deferStart) { this.begin(); }
    await promise;
  }

  begin(): void {
    this.isStreaming = true;
    this.emit({ type: "agent_start" });
  }

  /** pi ends the run: `agent_end`, then `agent_settled`, the turn's end. */
  end(aborted = false): void {
    const { finish } = this;
    if (finish === null) {
      return;
    }
    this.finish = null;
    this.isStreaming = false;
    this.emit({ type: "agent_end", messages: [] });
    this.emit({ type: "agent_settled", aborted });
    finish();
  }

  async abort(): Promise<void> {
    this.end(true);
  }

  dispose(): void {}

  private emit(event: unknown): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}

const holder = vi.hoisted(() => {
  const opened: { current: FakePiSession | null } = { current: null };
  return opened;
});
vi.mock("../../packages/oar/src/runtimes/pi/open.js", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  openPiAgentSession: async () => {
    await Promise.resolve();
    holder.current = new FakePiSession();
    return holder.current;
  },
}));

async function open(): Promise<{ session: Awaited<ReturnType<typeof piSession>>; pi: FakePiSession }> {
  const session = await piSession({ kind: "available", via: "bundled" }, { cwd: process.cwd() });
  const pi = holder.current;
  expect(pi).not.toBeNull();
  return { session, pi: pi ?? new FakePiSession() };
}

// pi's native followUp would continue the running turn, so OAR holds queued
// input itself and prompts the next one when pi settles: until then it can
// be taken back.
// oxlint-disable-next-line eslint/max-statements -- one held queue, withdrawn, drained and asked again, in order.
test("a pi input withdrawn before the run settles is never prompted; the next held input still is", async () => {
  const { session, pi } = await open();
  const first = await session.prompt("first");
  const withdrawn = await session.queue("withdrawn");
  const kept = await session.queue("kept");
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("accepted");
  pi.end();
  expect(await awaitTurnEnd(session, first.seq)).toEqual({ kind: "completed" });
  await settle();
  expect(pi.prompts).toEqual(["first", "kept"]);
  expect(await withdraw(session, inputIdOf(kept))).toBe("not_queued");
  expect(await withdraw(session, inputIdOf(withdrawn))).toBe("not_queued");
  expect(await withdraw(session, "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee")).toBe("not_queued");
  pi.end();
  await session.dispose();
});

test("a queue while idle is prompted at once; after dispose a withdraw is refused disposed", async () => {
  const { session, pi } = await open();
  const idle = await session.queue("idle");
  expect(await withdraw(session, inputIdOf(idle))).toBe("not_queued");
  await settle();
  expect(pi.prompts).toEqual(["idle"]);
  const held = await session.queue("held");
  await session.dispose();
  expect(await withdraw(session, inputIdOf(held))).toBe("disposed");
  expect(pi.prompts).toEqual(["idle"]);
});

// oar#231: pi runs in the host process, so its memory is the host's own.
test("a pi session has no resources(): it has no process of its own", async () => {
  const { session } = await open();
  expect("resources" in session).toBe(false);
  await session.dispose();
});

test("an abort taken over before agent_start reaches the SDK when its run starts", async () => {
  const { session, pi } = await open();
  pi.deferStart = true;
  const starting = session.prompt("start later");
  await settle();
  expect(await session.abort()).toMatchObject({ response: { body: { kind: "accepted" } } });
  expect(session.records().some((record) => record.kind === "frame" && record.body.type === "agent_settled")).toBe(false);
  pi.begin();
  const started = await starting;
  expect(await awaitTurnEnd(session, started.seq)).toEqual({ kind: "aborted" });
  await session.dispose();
});
