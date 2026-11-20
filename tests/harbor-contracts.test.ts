import { expect, test } from "vitest";
import type { Event, Session } from "../packages/oar/src/index.js";
import { Contracts } from "../apps/harbor/contracts.js";
import type { Store } from "../apps/harbor/store.js";

const storeStandIn = { journal: (): void => undefined };
// oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Contracts only journals.
const store = storeStandIn as unknown as Store;

function sessionWith(tokens: number | null, total: number): Session {
  const standIn = {
    steer: async () => ({}), stopTask: async () => ({}), compact: async () => ({}),
    capabilities: { images: true },
    usage: () => ({ value: { total: { input: total, output: 0 } } }),
    contextUsage: () => ({ value: { tokens, contextWindow: 1000, percent: null } }),
  };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only the members Contracts reads.
  return standIn as unknown as Session;
}

function event(kind: string, seq: number): Event {
  const standIn = { kind, seq, outcome: { kind: "completed" }, agentPath: [] };
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/consistent-type-assertions -- Only kind, seq and outcome are read.
  return standIn as unknown as Event;
}

function contracts(findings: string[]): Contracts {
  return new Contracts({
    name: "a", store, stallMs: 60_000, session: () => null, opens: () => 1,
    finding: (check) => {
      findings.push(check);
    },
  });
}

test("a completed turn without the declared context size is a finding, unless it compacted", () => {
  const findings: string[] = [];
  const checks = contracts(findings);
  const unknown = sessionWith(null, 10);
  checks.opened(unknown, { contextUsage: { tokens: true, contextWindow: true } });
  // A manual compact: the context is unknown until the next model response.
  checks.event(unknown, event("compaction_ended", 1));
  checks.event(unknown, event("turn_ended", 2));
  expect(findings).toEqual([]);
  checks.event(unknown, event("turn_ended", 3));
  expect(findings).toEqual(["context_usage_missing"]);
});

test("usage that goes down is a finding", () => {
  const findings: string[] = [];
  const checks = contracts(findings);
  checks.opened(sessionWith(5, 10), {});
  checks.event(sessionWith(5, 10), event("turn_ended", 1));
  checks.event(sessionWith(5, 4), event("turn_ended", 2));
  expect(findings).toEqual(["usage_decreased"]);
});
