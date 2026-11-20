import { afterEach, expect, test, vi } from "vitest";
import type { Session } from "../packages/oar/src/index.js";
import { Deliveries } from "../apps/harbor/deliveries.js";
import type { Message, Store, Undelivered } from "../apps/harbor/store.js";

afterEach(() => {
  vi.useRealTimers();
});

const storeStandIn = { journal: (): void => undefined };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Deliveries only journals.
const store = storeStandIn as unknown as Store;
const first: Message = { seq: 1, at: 0, from: "qa", text: "hello", to: ["a"] };

/** Runs `step` after `depth` microtask hops, so it lands at each point of the acknowledgment's resolution. */
function later(depth: number, step: () => void): void {
  if (depth === 0) {
    step();
    return;
  }
  queueMicrotask(() => {
    later(depth - 1, step);
  });
}

/** A session that closes in reaction to its own acknowledgment, `depth` hops after answering it. */
function closingOnAck(saved: Undelivered[][], depth: number): Deliveries {
  const box: { current: Session | null; deliveries?: Deliveries } = { current: null };
  const closing = {
    status: () => ({ value: { kind: "idle" } }),
    deliver: async () => {
      later(depth, () => {
        box.current = null;
        box.deliveries?.sessionGone("exited");
      });
      return { landed: "prompted", inputId: "input-1" };
    },
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only deliver and status are used.
  box.current = closing as unknown as Session;
  box.deliveries = new Deliveries({
    name: "a", cwd: "/work", bin: "/bin", store, current: () => box.current,
    finding: () => undefined,
    outstanding: (undelivered) => {
      saved.push([...undelivered]);
    },
  });
  return box.deliveries;
}

test("a session that closes while its acknowledgment resolves leaves the batch saved, at every point", async () => {
  vi.useFakeTimers();
  const last: (Undelivered[] | undefined)[] = [];
  for (const depth of [0, 1, 2, 3, 4, 5]) {
    const saved: Undelivered[][] = [];
    closingOnAck(saved, depth).add(first, true);
    // oxlint-disable-next-line no-await-in-loop -- Each depth runs to completion alone.
    await vi.runAllTimersAsync();
    last.push(saved.at(-1));
  }
  expect(last).toEqual(Array.from({ length: 6 }, () => [{ seq: 1, person: true }]));
});
