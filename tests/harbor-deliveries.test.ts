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
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only seq and inputIds are read.
const ended = endedStandIn as unknown as Extract<Event, { kind: "turn_ended" }>;

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
