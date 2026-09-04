import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  defineRuntime,
  type AccountUsageSnapshot,
  type AvailableInstallation,
  type Runtime,
  type Session,
  type SessionEventBody,
  type SessionEvent,
  type SessionObserver,
  type SessionOptions,
  type Turn,
  type TurnOutcome,
} from "@botiverse/oar";
import { AgentHost, type RuntimeCatalog } from "../src/main/agent.js";
import type { UsageBoundaryView } from "../src/shared/ipc.js";

interface FakeTurn {
  readonly turn: Turn;
  readonly emit: (event: SessionEventBody) => void;
  readonly settle: (outcome: TurnOutcome) => void;
}

interface FakeSession extends Session {
  readonly emitted: readonly SessionEvent[];
  readonly prompts: readonly string[];
  readonly active: () => FakeTurn | null;
  readonly spontaneous: () => FakeTurn | null;
}

function fakeSession(id: string, options: SessionOptions): FakeSession {
  void options;
  const observers = new Set<SessionObserver>();
  const emitted: SessionEvent[] = [];
  const prompts: string[] = [];
  let sequence = 0;
  let active: FakeTurn | null = null;

  const publish = (
    turnId: string,
    body: SessionEventBody,
  ): SessionEvent => {
    const event: SessionEvent = {
      sessionId: id,
      turnId,
      seq: sequence,
      receivedAt: 10_000 + sequence,
      ...body,
    };
    sequence += 1;
    emitted.push(event);
    for (const observer of observers) {
      observer(event);
    }
    return event;
  };

  const start = (input: string): FakeTurn | null => {
    if (active !== null) {
      return null;
    }
    const outcome = Promise.withResolvers<TurnOutcome>();
    const turnId = `${id}-turn-${prompts.length + 1}`;
    let settled = false;
    const fake: FakeTurn = {
      turn: {
        id: turnId,
        outcome: outcome.promise,
        abort: async (): Promise<void> => {
          if (!settled) {
            fake.settle({ kind: "aborted" });
          }
        },
        steer: async (): Promise<{ kind: "accepted" }> => ({ kind: "accepted" }),
      },
      emit: (body): void => {
        if (!settled) {
          publish(turnId, body);
        }
      },
      settle: (result): void => {
        if (settled) {
          return;
        }
        settled = true;
        publish(turnId, { kind: "turn_ended", outcome: result });
        active = null;
        outcome.resolve(result);
      },
    };
    active = fake;
    publish(turnId, { kind: "turn_started" });
    if (input.includes("synchronous")) {
      fake.emit({ kind: "text_delta", text: id });
    }
    return fake;
  };

  return {
    id,
    prompt(input) {
      prompts.push(input);
      const turn = start(input);
      return turn === null ? { kind: "busy" } : { kind: "turn", turn: turn.turn };
    },
    subscribe(observer) {
      observers.add(observer);
      return () => {
        observers.delete(observer);
      };
    },
    queue: {
      durable: false,
      add: async (): Promise<void> => {},
    },
    steerOrQueue: async (turn, input) => {
      const current = active;
      if (current === null || current.turn.id !== turn.id) {
        return { landed: "rejected", reason: "turn is not active" };
      }
      current.emit({ kind: "text_delta", text: input });
      return { landed: "steered" };
    },
    dispose: async (): Promise<void> => {
      active?.settle({ kind: "aborted" });
    },
    emitted,
    prompts,
    active: () => active,
    spontaneous: () => start("spontaneous"),
  };
}

function fakeCatalog(
  sessions: FakeSession[],
  failIds: ReadonlySet<string> = new Set(),
  wrapSession: (session: FakeSession) => Session = (session) => session,
  usageReader?: () => Promise<AccountUsageSnapshot>,
): RuntimeCatalog {
  const remainingFailures = new Set(failIds);
  const runtime: Runtime = defineRuntime({
    id: "fake",
    installation: async (): Promise<AvailableInstallation> => ({ kind: "available", via: "bundled" }),
    session: async (_installation, options): Promise<Session> => {
      const id = `session-${sessions.length + 1}`;
      if (remainingFailures.delete(id)) {
        throw new Error(`cannot start ${id}`);
      }
      const session = fakeSession(id, options);
      sessions.push(session);
      return wrapSession(session);
    },
    ...(usageReader === undefined ? {} : { accountUsage: usageReader }),
  });
  return {
    get: (id) => id === runtime.id ? runtime : undefined,
    list: () => [runtime],
    require: (id) => {
      if (id !== runtime.id) {
        throw new Error(`unknown runtime: ${id}`);
      }
      return runtime;
    },
  };
}

const tempDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirectories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function voyageLines(path: string): Promise<unknown[]> {
  const source = await readFile(path, "utf8");
  return source.trimEnd().split("\n").map((line): unknown => {
    const parsed: unknown = JSON.parse(line);
    return parsed;
  });
}

function eventSummary(event: { readonly laneId?: string; readonly kind: string }): {
  readonly laneId?: string;
  readonly kind: string;
} {
  return event.laneId === undefined
    ? { kind: event.kind }
    : { laneId: event.laneId, kind: event.kind };
}

function objectRecord(value: unknown): Readonly<Record<string, unknown>> {
  if (typeof value !== "object" || value === null) {
    throw new TypeError("expected JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

function kindOf(line: unknown): string {
  if (typeof line !== "object" || line === null) {
    return "invalid";
  }
  const kind = objectRecord(line).kind;
  return typeof kind === "string" ? kind : "invalid";
}

describe("AgentHost fleet", () => {
  test("launches independent lanes and fans out lane-tagged events", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-agent-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const host = new AgentHost({
      voyageDirectory: directory,
      now: () => 42,
      runtimeRegistry: fakeCatalog(sessions),
    });
    const allEvents: { readonly laneId?: string; readonly kind: string }[] = [];
    const laneEvents: { readonly laneId?: string; readonly kind: string }[] = [];
    host.subscribe((event): void => {
      allEvents.push(eventSummary(event));
    });

    const identities = await host.launchFleet({
      lanes: [
        { runtimeId: "fake", cwd: process.cwd(), laneId: "alpha" },
        { runtimeId: "fake", cwd: process.cwd() },
      ],
    });
    assert.deepEqual(identities.map(({ laneId }) => laneId), ["alpha", "lane-1"]);
    const unsubscribe = host.subscribeLane("alpha", (event) => {
      laneEvents.push(eventSummary(event));
    });

    const alphaReceipt = await host.submitToLane("alpha", "synchronous");
    assert.equal(alphaReceipt.landed, "prompted");
    const betaReceipt = await host.submitToLane("lane-1", "synchronous");
    assert.equal(betaReceipt.landed, "prompted");
    const alphaTurn = sessions[0]?.active();
    const betaTurn = sessions[1]?.active();
    alphaTurn?.settle({ kind: "completed" });
    betaTurn?.settle({ kind: "completed" });
    await Promise.all([alphaTurn?.turn.outcome, betaTurn?.turn.outcome]);

    assert.ok(allEvents.length > 0);
    assert.ok(allEvents.every((event) => event.laneId !== undefined));
    assert.ok(laneEvents.length > 0);
    assert.ok(laneEvents.every((event) => event.laneId === "alpha"));
    assert.deepEqual(host.fleet().lanes.map(({ identity }) => identity.laneId), ["alpha", "lane-1"]);
    unsubscribe();
    await host.dispose();
  });

  test("reserves duplicate ids and rolls back a failed fleet launch", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-agent-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const host = new AgentHost({
      voyageDirectory: directory,
      runtimeRegistry: fakeCatalog(sessions, new Set(["session-2"])),
    });

    await expect(host.launchFleet({
      lanes: [
        { runtimeId: "fake", cwd: process.cwd(), laneId: "first" },
        { runtimeId: "fake", cwd: process.cwd(), laneId: "second" },
      ],
    })).rejects.toThrow("cannot start session-2");
    assert.deepEqual(host.fleet(), { lanes: [] });
    await expect(host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "first" })).resolves.toMatchObject({
      laneId: "first",
    });
    await expect(host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "first" })).rejects.toThrow("lane already exists: first");
    await host.dispose();
  });

  test("closes without waiting forever for an unresolved steer receipt", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-agent-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const steerStarted = Promise.withResolvers<void>();
    const host = new AgentHost({
      voyageDirectory: directory,
      runtimeRegistry: fakeCatalog(sessions, new Set(), (session) => ({
        ...session,
        steerOrQueue: async () => {
          steerStarted.resolve();
          return new Promise(() => {});
        },
      })),
    });
    const identity = await host.launch({
      runtimeId: "fake",
      cwd: process.cwd(),
      laneId: "closing",
    });
    await host.submitToLane("closing", "start");
    const pending = host.submitToLane("closing", "unresolved steer");
    await steerStarted.promise;

    await expect(host.closeLane("closing")).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({
      landed: "rejected",
      reason: "The agent lane is closing",
    });
    expect(host.fleet()).toEqual({ lanes: [] });

    assert.ok(identity.voyagePath !== undefined);
    const lines = await voyageLines(identity.voyagePath);
    expect(lines.map((line) => kindOf(line))).toEqual([
      "header",
      "submission",
      "event",
      "submission",
      "event",
      "end",
    ]);
  });
});

describe("AgentHost usage boundaries", () => {
  test("samples account usage around a prompted turn and keeps steering out of the boundary pair", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-usage-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const calls: string[] = [];
    let read = 0;
    const host = new AgentHost({
      voyageDirectory: directory,
      now: () => 1000 + read,
      runtimeRegistry: fakeCatalog(sessions, new Set(), (session) => {
        const originalPrompt = session.prompt.bind(session);
        return {
          ...session,
          prompt(input) {
            calls.push("prompt");
            return originalPrompt(input);
          },
        };
      }, async () => {
        calls.push("usage");
        const current = read;
        read += 1;
        return {
          kind: "available",
          rateLimited: false,
          windows: [{ label: "session", usedRatio: current === 0 ? 0.2 : 0.3 }],
        };
      }),
    });
    const usage: UsageBoundaryView[] = [];
    host.subscribe((event) => {
      if (event.kind === "usage") {
        usage.push(event.boundary);
      }
    });

    await host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "usage" });
    const receipt = await host.submitToLane("usage", "hello");
    expect(receipt).toMatchObject({ landed: "prompted" });
    expect(calls.slice(0, 2)).toEqual(["usage", "prompt"]);
    const turn = sessions[0]?.active();
    if (turn === undefined || turn === null) {
      throw new Error("fake turn did not start");
    }
    const steer = await host.submitToLane("usage", "follow up");
    expect(steer).toMatchObject({ landed: "steered" });
    turn.settle({ kind: "completed" });
    await turn.turn.outcome;
    await host.closeLane("usage");

    expect(usage.map(({ phase, turnId }) => ({ phase, turnId }))).toEqual([
      { phase: "before", turnId: "session-1-turn-2" },
      { phase: "after", turnId: "session-1-turn-2" },
    ]);
    expect(calls).toEqual(["usage", "prompt", "usage"]);
    await host.dispose();
  });

  test("represents usage reader failures as an error boundary without blocking the turn", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-usage-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const host = new AgentHost({
      voyageDirectory: directory,
      runtimeRegistry: fakeCatalog(sessions, new Set(), (session) => session, async () => {
        throw new Error("quota endpoint unavailable");
      }),
    });
    const usage: UsageBoundaryView[] = [];
    host.subscribe((event) => {
      if (event.kind === "usage") {
        usage.push(event.boundary);
      }
    });
    await host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "failure" });
    await expect(host.submitToLane("failure", "hello")).resolves.toMatchObject({ landed: "prompted" });
    const turn = sessions[0]?.active();
    turn?.settle({ kind: "completed" });
    await turn?.turn.outcome;
    await host.closeLane("failure");
    expect(usage).toHaveLength(2);
    expect(usage.every(({ result }) => result.kind === "error")).toBe(true);
    expect(usage.map(({ phase }) => phase)).toEqual(["before", "after"]);
    await host.dispose();
  });

  test("lets lane close win over a usage reader that never settles", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-usage-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const usageStarted = Promise.withResolvers<void>();
    const host = new AgentHost({
      voyageDirectory: directory,
      runtimeRegistry: fakeCatalog(sessions, new Set(), (session) => session, async () => {
        usageStarted.resolve();
        return new Promise<AccountUsageSnapshot>(() => {});
      }),
    });
    const usage: UsageBoundaryView[] = [];
    host.subscribe((event) => {
      if (event.kind === "usage") {
        usage.push(event.boundary);
      }
    });

    await host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "hung-usage" });
    const pending = host.submitToLane("hung-usage", "hello");
    await usageStarted.promise;
    await expect(host.closeLane("hung-usage")).resolves.toBeUndefined();
    await expect(pending).resolves.toEqual({
      landed: "rejected",
      reason: "The agent lane is closing",
    });
    expect(usage).toEqual([]);
    expect(host.fleet()).toEqual({ lanes: [] });
    await host.dispose();
  });

  test("samples a spontaneous turn from public turn boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-usage-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    let read = 0;
    const usageStarted = Promise.withResolvers<void>();
    const host = new AgentHost({
      voyageDirectory: directory,
      now: () => 10_000 + read * 60_000,
      runtimeRegistry: fakeCatalog(sessions, new Set(), (session) => session, async () => {
        usageStarted.resolve();
        const current = read;
        read += 1;
        return {
          kind: "available",
          rateLimited: false,
          windows: [{ label: "session", usedRatio: current === 0 ? 0.1 : 0.2 }],
        };
      }),
    });
    const usage: UsageBoundaryView[] = [];
    host.subscribe((event) => {
      if (event.kind === "usage") {
        usage.push(event.boundary);
      }
    });

    await host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "spontaneous" });
    const turn = sessions[0]?.spontaneous();
    if (turn === undefined || turn === null) {
      throw new Error("fake spontaneous turn did not start");
    }
    await usageStarted.promise;
    turn.settle({ kind: "completed" });
    await turn.turn.outcome;
    await host.closeLane("spontaneous");

    expect(usage.map(({ phase, turnId }) => ({ phase, turnId }))).toEqual([
      { phase: "before", turnId: "session-1-turn-1" },
      { phase: "after", turnId: "session-1-turn-1" },
    ]);
    await host.dispose();
  });

  test("keeps a synchronously completed prompt paired with both usage boundaries", async () => {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-usage-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    let reads = 0;
    const host = new AgentHost({
      voyageDirectory: directory,
      runtimeRegistry: fakeCatalog(sessions, new Set(), (session) => ({
        ...session,
        prompt(input) {
          const result = session.prompt(input);
          if (result.kind === "turn" && input.includes("instant")) {
            session.active()?.settle({ kind: "completed" });
          }
          return result;
        },
      }), async () => ({
        kind: "available",
        rateLimited: false,
        windows: [{ label: "session", usedRatio: reads++ === 0 ? 0.1 : 0.2 }],
      })),
    });
    const usage: UsageBoundaryView[] = [];
    host.subscribe((event) => {
      if (event.kind === "usage") {
        usage.push(event.boundary);
      }
    });

    await host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "instant" });
    await expect(host.submitToLane("instant", "instant")).resolves.toMatchObject({
      landed: "prompted",
      turnId: "session-1-turn-2",
    });
    await host.closeLane("instant");
    expect(usage.map(({ phase, turnId }) => ({ phase, turnId }))).toEqual([
      { phase: "before", turnId: "session-1-turn-2" },
      { phase: "after", turnId: "session-1-turn-2" },
    ]);
    expect(usage.every(({ result }) => result.kind === "loaded")).toBe(true);
    expect(reads).toBe(2);
    await host.dispose();
  });
});

test("Voyage capture puts a submission before synchronous public events and closes cleanly", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(42);
  try {
    const directory = await mkdtemp(join(tmpdir(), "coxswain-agent-"));
    tempDirectories.push(directory);
    const sessions: FakeSession[] = [];
    const host = new AgentHost({
      voyageDirectory: directory,
      now: () => 42,
      runtimeRegistry: fakeCatalog(sessions),
    });
    const identity = await host.launch({ runtimeId: "fake", cwd: process.cwd(), laneId: "capture" });
    const receipt = await host.submitToLane("capture", "synchronous");
    assert.equal(receipt.landed, "prompted");
    sessions[0]?.active()?.settle({ kind: "completed" });
    await host.closeLane("capture");

    assert.ok(identity.voyagePath !== undefined);
    const lines = await voyageLines(identity.voyagePath);
    expect(lines.map((line) => kindOf(line))).toEqual(["header", "submission", "event", "event", "event", "end"]);
    const header = objectRecord(lines[0]);
    expect({ ...header, cwd: "<cwd>" }).toMatchInlineSnapshot(`
      {
        "cwd": "<cwd>",
        "format": "oar-voyage/1",
        "kind": "header",
        "recorder": "coxswain",
        "runtime": "fake",
        "sessionId": "session-1",
        "startedAt": 42,
      }
    `);
    const submission = objectRecord(lines[1]);
    expect(submission).toMatchInlineSnapshot(`
      {
        "at": 42,
        "kind": "submission",
        "text": "synchronous",
        "via": "prompt",
      }
    `);
    const eventRecord = objectRecord(lines[2]);
    assert.equal(eventRecord.kind, "event");
    assert.deepEqual(eventRecord.event, sessions[0]?.emitted[0]);
    assert.equal(objectRecord(lines.at(-1)).kind, "end");
    await host.dispose();
  } finally {
    vi.useRealTimers();
  }
});
