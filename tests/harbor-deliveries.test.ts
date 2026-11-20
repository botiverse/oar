import { afterEach, expect, test, vi } from "vitest";
import type { Event, Session } from "../packages/oar/src/index.js";
import { Deliveries } from "../apps/harbor/deliveries.js";
import type { Message, Store } from "../apps/harbor/store.js";

afterEach(() => {
  vi.useRealTimers();
});

const sessionStandIn = {
  deliver: async () => ({ landed: "prompted", inputId: "input-1" }),
  status: () => ({ value: { kind: "idle" } }),
};
const storeStandIn = { journal: (): void => undefined };
const endedStandIn = { kind: "turn_ended", seq: 7, inputIds: ["input-1"], outcome: { kind: "completed" } };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only deliver and status are used.
const session = sessionStandIn as unknown as Session;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Deliveries only journals.
const store = storeStandIn as unknown as Store;
const failedStandIn = { ...endedStandIn, outcome: { kind: "failed", reason: "provider limit" } };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only seq, inputIds and outcome are read.
const ended = endedStandIn as unknown as Extract<Event, { kind: "turn_ended" }>;
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only seq, inputIds and outcome are read.
const failed = failedStandIn as unknown as Extract<Event, { kind: "turn_ended" }>;

function harness(): { deliveries: Deliveries; findings: string[] } {
  const findings: string[] = [];
  const deliveries = new Deliveries({
    name: "a", cwd: "/work", bin: "/bin", store,
    current: () => session,
    finding: (check) => {
      findings.push(check);
    },
  });
  return { deliveries, findings };
}

function message(from: string): Message {
  return { seq: 1, at: 0, from, text: "hello", to: ["a"] };
}

test("going idle without answering a person is a no_reply finding", async () => {
  vi.useFakeTimers();
  const { deliveries, findings } = harness();
  deliveries.add(message("qa"), true);
  await vi.runAllTimersAsync();
  deliveries.turnEnded(ended);
  await vi.advanceTimersByTimeAsync(2000);
  expect(findings).toEqual(["no_reply"]);
});

test("a note from another agent needs no answer", async () => {
  vi.useFakeTimers();
  const { deliveries, findings } = harness();
  deliveries.add(message("b"), false);
  await vi.runAllTimersAsync();
  deliveries.turnEnded(ended);
  await vi.advanceTimersByTimeAsync(2000);
  expect(findings).toEqual([]);
});

test("a failed turn is reported once, as turn_failed, not again as no_reply", async () => {
  vi.useFakeTimers();
  const { deliveries, findings } = harness();
  deliveries.add(message("qa"), true);
  await vi.runAllTimersAsync();
  deliveries.turnEnded(failed);
  await vi.advanceTimersByTimeAsync(2000);
  expect(findings).toEqual([]);
});

function recordingHarness(sent: string[]): Deliveries {
  const recording = {
    ...sessionStandIn,
    deliver: async (text: string) => {
      sent.push(text);
      return { landed: "prompted", inputId: `input-${sent.length}` };
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only deliver and status are used.
  const recorded = recording as unknown as Session;
  return new Deliveries({ name: "a", cwd: "/work", bin: "/bin/harbor", store, current: () => recorded, finding: () => undefined });
}

async function deliverOne(deliveries: Deliveries, sent: string[]): Promise<void> {
  const before = sent.length;
  deliveries.add(message("qa"), true);
  await vi.waitFor(() => {
    expect(sent).toHaveLength(before + 1);
  });
}

test("the channel rules come back after a compaction, and every other delivery names the way to answer", async () => {
  const sent: string[] = [];
  const deliveries = recordingHarness(sent);
  deliveries.opened(true, false);
  await deliverOne(deliveries, sent);
  await deliverOne(deliveries, sent);
  deliveries.compacted();
  await deliverOne(deliveries, sent);
  expect(sent[0]).toMatch(/^You are @a, an agent working in harbor/u);
  expect(sent[1]).toMatch(/^\(harbor: answer only with \/bin\/harbor send; other chat tools here, such as `raft`, act as the person hosting you\)\n\[harbor msg=1 /u);
  expect(sent[2]).toMatch(/^You are @a, an agent working in harbor[\s\S]*such as `raft`/u);
});

test("rules in the system prompt are not repeated in messages", async () => {
  const sent: string[] = [];
  const deliveries = recordingHarness(sent);
  deliveries.opened(true, true);
  await deliverOne(deliveries, sent);
  deliveries.compacted();
  await deliverOne(deliveries, sent);
  expect(sent.every((text) => text.startsWith("[harbor msg=1 "))).toBe(true);
});

test("a resume that loses the system prompt gets the reminder, not silence", async () => {
  const sent: string[] = [];
  const deliveries = recordingHarness(sent);
  deliveries.opened(true, true);
  await deliverOne(deliveries, sent);
  deliveries.opened(false, false);
  await deliverOne(deliveries, sent);
  expect(sent[0]).toMatch(/^\[harbor msg=1 /u);
  expect(sent[1]).toMatch(/^\(harbor: answer only with /u);
});

test("a compaction while a delivery is in flight still brings the rules back", async () => {
  const sent: string[] = [];
  let deliveries: Deliveries | null = null;
  const compactingDuringDelivery = {
    ...sessionStandIn,
    deliver: async (text: string) => {
      sent.push(text);
      if (sent.length === 2) {
        deliveries?.compacted();
      }
      return { landed: "steered", inputId: `input-${sent.length}` };
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only deliver and status are used.
  const compacting = compactingDuringDelivery as unknown as Session;
  deliveries = new Deliveries({ name: "a", cwd: "/work", bin: "/bin/harbor", store, current: () => compacting, finding: () => undefined });
  deliveries.opened(true, false);
  for (let index = 0; index < 3; index += 1) {
    // eslint-disable-next-line no-await-in-loop -- Deliveries go one after another.
    await deliverOne(deliveries, sent);
  }
  expect([sent[1]?.slice(0, 7), sent[2]?.slice(0, 9)]).toEqual(["(harbor", "You are @"]);
});

test("a recycled session gets the handoff in its first delivery only", async () => {
  const sent: string[] = [];
  const deliveries = recordingHarness(sent);
  deliveries.opened(true, true, "HANDOFF");
  deliveries.add(message("qa"), true);
  await vi.waitFor(() => { expect(sent).toHaveLength(1); });
  deliveries.add({ ...message("qa"), seq: 2 }, true);
  await vi.waitFor(() => { expect(sent).toHaveLength(2); });
  expect(sent[0]?.startsWith("HANDOFF\n\n")).toBe(true);
  expect(sent[1]).not.toContain("HANDOFF");
});

function heldHarness(gate: { open: boolean }): { deliveries: Deliveries; sent: string[] } {
  const sent: string[] = [];
  const recording = { ...sessionStandIn, deliver: async (text: string) => { sent.push(text); return { landed: "queued", inputId: `input-${String(sent.length)}` }; } };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only deliver and status are used.
  const current = recording as unknown as Session;
  const deliveries = new Deliveries({ name: "a", cwd: "/work", bin: "/bin", store, current: () => current, ready: () => gate.open, finding: () => undefined });
  return { deliveries, sent };
}

test("a hold stops new sends without hiding the session, and resume sends each message once", async () => {
  const gate = { open: false };
  const { deliveries, sent } = heldHarness(gate);
  deliveries.add(message("qa"), true);
  await Promise.resolve();
  expect(sent).toHaveLength(0);
  gate.open = true;
  deliveries.resume();
  deliveries.resume();
  await vi.waitFor(() => { expect(sent).toHaveLength(1); });
  expect(deliveries.pending).toBe(0);
});
