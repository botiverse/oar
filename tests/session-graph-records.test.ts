/* oxlint-disable eslint/max-statements, eslint/max-params -- Kernel fixtures pin ordered record sequences and their persistence checkpoints. */
import { expect, test } from "vitest";
import type { RawEvent, SessionEdge, UsageReport } from "../packages/oar/src/contracts/session.js";
import { eventsOf, graphOf, initialSessionView, reduceSessionView, reduceSessionViewEvent, usageOf, viewOf } from "../packages/oar/src/observe/index.js";
import { createSessionKernel, type SessionKernel } from "../packages/oar/src/shared/session-kernel.js";

function report(kernel: SessionKernel, sessionId: string, usage: UsageReport, agentPath: readonly string[] = []): void {
  kernel.frame({ type: "fixture/usage", native: usage, events: [{ kind: "usage", usage }] }, { sessionId, agentPath });
}

function link(kernel: SessionKernel, parent: string, child: string): void {
  const edge: SessionEdge = { parent, child, via: "tool_call" };
  kernel.frame({ type: "fixture/lineage", native: edge, events: [kernel.link(edge)] });
}

function replay(records: readonly RawEvent[]): RawEvent[] {
  // oxlint-disable-next-line typescript/no-unsafe-return, unicorn/prefer-structured-clone -- JSON round trip of typed records is the host's persistence boundary under test.
  return JSON.parse(JSON.stringify(records));
}

test("a graph is visible with its source frame, in live observers and a JSON replay", () => {
  const kernel = createSessionKernel("root");
  const seen: ReturnType<typeof graphOf>[] = [];
  kernel.rawEvents(() => { seen.push(kernel.graph()); });
  expect(kernel.graph()).toEqual(graphOf([]));
  link(kernel, "root", "child");
  link(kernel, "root", "child");
  expect(seen).toEqual([
    { nodes: [{ id: "root" }, { id: "child" }], edges: [{ parent: "root", child: "child", via: "tool_call" }] },
    { nodes: [{ id: "root" }, { id: "child" }], edges: [{ parent: "root", child: "child", via: "tool_call" }] },
  ]);
  const persisted = replay(kernel.records());
  expect(graphOf(persisted)).toEqual(kernel.graph());
  expect(kernel.records().flatMap((record) => eventsOf(record)).filter((event) => event.kind === "session_linked")).toHaveLength(2);
});

function family(kernel: SessionKernel): void {
  report(kernel, "root", { tokens: { input: 100, output: 10, cacheRead: 60 } });
  // Reports can precede lineage. Repeated totals replace, never add again.
  report(kernel, "a", { tokens: { input: 20, output: 2 } });
  report(kernel, "b", { tokens: { input: 3, output: 1 } });
  report(kernel, "c", { tokens: { input: 7, output: 1, cacheWrite: 2 } });
  report(kernel, "a", { tokens: { input: 30, output: 3 } });
  report(kernel, "stray", { tokens: { input: 1000, output: 100 } });
  for (const [parent, child] of [["root", "a"], ["root", "b"], ["a", "c"], ["b", "c"], ["a", "c"], ["c", "root"]] as const) {
    link(kernel, parent, child);
  }
}

test("query, incremental view and flat events count nested descendants once, even with duplicate edges and a cycle", () => {
  const kernel = createSessionKernel("root");
  let live = initialSessionView();
  const comparisons: boolean[] = [];
  kernel.rawEvents((record) => {
    live = reduceSessionView(live, record);
    const queried = usageOf(kernel.records(), "root").value;
    comparisons.push(JSON.stringify(live.usage) === JSON.stringify(queried));
  });
  family(kernel);
  expect(comparisons).not.toContain(false);
  const expected = { total: { input: 100, output: 10, cacheRead: 60 }, withChildren: { input: 140, output: 15, cacheRead: 60, cacheWrite: 2 } };
  expect(live.usage).toEqual(expected);
  const persisted = replay(kernel.records());
  expect(viewOf(persisted).usage).toEqual(expected);
  expect(kernel.records().flatMap((record) => eventsOf(record)).reduce((state, event) => reduceSessionViewEvent(state, event), initialSessionView()).usage).toEqual(expected);
  expect(live.sessionGraph).toEqual(graphOf(kernel.records()));
});

test("a view checkpoint retains totals received before lineage without mutating the earlier view", () => {
  const kernel = createSessionKernel("root");
  report(kernel, "root", { tokens: { input: 10, output: 1 } });
  report(kernel, "child", { tokens: { input: 20, output: 2 } });
  const prefix = viewOf(kernel.records());
  const checkpoint = structuredClone(prefix);
  const offset = kernel.records().length;
  report(kernel, "child", { tokens: { input: 30, output: 3 } });
  link(kernel, "root", "child");
  const continued = kernel.records().slice(offset).reduce((state, record) => reduceSessionView(state, record), checkpoint);
  expect(prefix.usage).toEqual({ total: { input: 10, output: 1 } });
  expect(prefix.usageBySession.get("child")?.agents.get("[]")?.tokens).toEqual({ input: 20, output: 2 });
  expect(continued.usage).toEqual({ total: { input: 10, output: 1 }, withChildren: { input: 40, output: 4 } });
  expect(continued).toEqual(viewOf(kernel.records()));
});

test("old records and unrelated ids never invent children, but an explicit graph still works", () => {
  const kernel = createSessionKernel("root");
  report(kernel, "root", { tokens: { input: 10, output: 1 } });
  report(kernel, "child", { tokens: { input: 20, output: 2 } });
  const recorded = replay(kernel.records());
  expect(graphOf(recorded)).toEqual({ nodes: [{ id: "root" }, { id: "child" }], edges: [] });
  expect(usageOf(recorded, "root").value).toEqual({ total: { input: 10, output: 1 } });
  expect(viewOf(recorded).usage).toEqual({ total: { input: 10, output: 1 } });
  expect(usageOf(recorded, "root", { nodes: [], edges: [{ parent: "root", child: "child", via: "tool_call" }] }).value.withChildren).toEqual({ input: 30, output: 3 });
});

test("unknown totals stay unknown; child agents sum once and a reported session total wins", () => {
  const kernel = createSessionKernel("root");
  link(kernel, "root", "child");
  report(kernel, "child", { tokens: { input: 20, output: 2 } });
  expect(viewOf(kernel.records()).usage).toEqual({ total: null });
  report(kernel, "root", { tokens: { input: 10, output: 1 } });
  report(kernel, "child", { tokens: { input: 5, output: 1 } }, ["agent"]);
  expect(viewOf(kernel.records()).usage.withChildren).toEqual({ input: 35, output: 4 });
  report(kernel, "child", { total: { input: 50, output: 5 } });
  report(kernel, "child", { context: { tokens: 999, contextWindow: 1000, percent: 99 } });
  expect(viewOf(kernel.records()).usage).toEqual({ total: { input: 10, output: 1 }, withChildren: { input: 60, output: 6 } });
  expect(viewOf(kernel.records()).usage).toEqual(usageOf(kernel.records(), "root").value);
  expect(viewOf(kernel.records()).context).toBeNull();
});


test("a lineage frame reported by a foreign session advances the usage cursor without counting its own usage", () => {
  const kernel = createSessionKernel("root");
  report(kernel, "root", { tokens: { input: 10, output: 1 } });
  report(kernel, "child", { tokens: { input: 20, output: 2 } });
  const source = kernel.frame({ type: "fixture/lineage", native: {}, events: [
    kernel.link({ parent: "root", child: "child", via: "tool_call" }),
    { kind: "usage", usage: { tokens: { input: 1000, output: 100 } } },
  ] }, { sessionId: "reporter" });
  expect(usageOf(kernel.records(), "root")).toEqual({ seq: source.seq, value: {
    total: { input: 10, output: 1 }, withChildren: { input: 30, output: 3 },
  } });
  expect(viewOf(kernel.records()).usage).toEqual(usageOf(kernel.records(), "root").value);
  expect(usageOf(kernel.records(), "root", kernel.graph())).toEqual(usageOf(kernel.records(), "root"));
  expect(usageOf(kernel.records(), "root", { nodes: [], edges: [] })).toEqual({ seq: 0, value: { total: { input: 10, output: 1 } } });
});
