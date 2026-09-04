import {
  parseCanonicalUtcInstant,
  type AgentViewUpdate,
  type HostEvent,
  type SessionEventView,
  type SessionEventBodyView,
  type SessionIdentity,
} from "../../../shared/ipc.js";
import type { AccountUsageSnapshot } from "@botiverse/oar";
import { initialRegattaState, reduceRegattaEvents, type RegattaState } from "./regatta-model.js";

const SMOKE_CWD = "~/play/oar-demo";
const SMOKE_STARTED = 1_756_500_000_000;

const identities: readonly SessionIdentity[] = [
  {
    laneId: "claude",
    runtimeId: "claude",
    sessionId: "smoke-claude",
    cwd: SMOKE_CWD,
    model: "sonnet",
  },
  {
    laneId: "codex",
    runtimeId: "codex",
    sessionId: "smoke-codex",
    cwd: SMOKE_CWD,
    model: "o4-mini",
  },
];

function event(
  identity: SessionIdentity,
  turnId: string,
  seq: number,
  receivedAt: number,
  body: SessionEventBodyView,
): SessionEventView {
  return { sessionId: identity.sessionId, turnId, seq, receivedAt, ...body };
}

const claudeTurn = "smoke-claude-turn-1";
const codexTurn = "smoke-codex-turn-1";
const codexErrorTurn = "smoke-codex-turn-2";
const claudeIdentity = identities[0];
const codexIdentity = identities[1];
if (claudeIdentity === undefined || codexIdentity === undefined) {
  throw new Error("Regatta smoke fixture is incomplete");
}

const smokeUsageReset = parseCanonicalUtcInstant("2026-08-23T19:39:00.000Z");
if (smokeUsageReset === null) {
  throw new Error("Regatta smoke usage reset fixture is invalid");
}
const SMOKE_USAGE_RESET = smokeUsageReset;

function usageBoundary(
  laneId: string,
  turnId: string,
  phase: "before" | "after",
  sampledAt: number,
  usedRatio: number,
): HostEvent {
  const usage: AccountUsageSnapshot = {
    kind: "available",
    plan: "Max",
    rateLimited: false,
    windows: [
      { label: "current session", usedRatio, resetsAt: SMOKE_USAGE_RESET },
      { label: "week · all models", usedRatio: usedRatio + 0.25 },
      {
        label: "daily burst",
        usedRatio: phase === "before" ? 0.82 : 0.12,
        resetsAt: SMOKE_USAGE_RESET,
      },
    ],
  };
  return {
    kind: "usage",
    laneId,
    boundary: {
      turnId,
      phase,
      sampledAt,
      result: {
        kind: "loaded",
        usage,
      },
    },
  };
}

function usageErrorBoundary(
  laneId: string,
  turnId: string,
  phase: "before" | "after",
  sampledAt: number,
): HostEvent {
  return {
    kind: "usage",
    laneId,
    boundary: {
      turnId,
      phase,
      sampledAt,
      result: { kind: "error", reason: "fixture quota probe failed" },
    },
  };
}

const events: readonly HostEvent[] = [
  {
    ...usageBoundary("codex", codexTurn, "before", SMOKE_STARTED + 105, 0.07),
  },
  {
    kind: "conversation",
    laneId: "claude",
    entry: {
      kind: "human",
      id: "smoke-human-claude",
      text: "Compare the two runtimes",
      receivedAt: SMOKE_STARTED + 100,
      delivery: "prompted",
    },
  },
  {
    kind: "conversation",
    laneId: "codex",
    entry: {
      kind: "human",
      id: "smoke-human-codex",
      text: "Compare the two runtimes",
      receivedAt: SMOKE_STARTED + 100,
      delivery: "prompted",
    },
  },
  {
    kind: "activity",
    laneId: "claude",
    event: event(claudeIdentity, claudeTurn, 0, SMOKE_STARTED + 110, { kind: "turn_started" }),
  },
  {
    kind: "agent_view",
    laneId: "claude",
    view: {
      status: {
        kind: "running",
        turnId: claudeTurn,
        phase: "thinking",
        lastEventAt: SMOKE_STARTED + 130,
      },
      stall: null,
      simple: "busy",
    } satisfies AgentViewUpdate,
  },
  {
    kind: "activity",
    laneId: "claude",
    event: event(claudeIdentity, claudeTurn, 1, SMOKE_STARTED + 130, {
      kind: "reasoning",
      content: { kind: "text", text: "Inspecting both lanes" },
    }),
  },
  {
    kind: "activity",
    laneId: "claude",
    event: event(claudeIdentity, claudeTurn, 2, SMOKE_STARTED + 180, {
      kind: "tool_call_started",
      callId: "smoke-tool-claude",
      tool: "Bash",
      input: "oar --version",
    }),
  },
  {
    kind: "activity",
    laneId: "codex",
    event: event(codexIdentity, codexTurn, 0, SMOKE_STARTED + 115, { kind: "turn_started" }),
  },
  {
    kind: "activity",
    laneId: "codex",
    event: event(codexIdentity, codexTurn, 1, SMOKE_STARTED + 145, {
      kind: "text_delta",
      text: "Codex is ready to compare the run.",
    }),
  },
  {
    kind: "agent_view",
    laneId: "codex",
    view: {
      status: { kind: "idle", lastTurnOutcome: { kind: "completed" } },
      stall: null,
      simple: "idle",
    } satisfies AgentViewUpdate,
  },
  {
    kind: "activity",
    laneId: "codex",
    event: event(codexIdentity, codexTurn, 2, SMOKE_STARTED + 200, {
      kind: "turn_ended",
      outcome: { kind: "completed" },
    }),
  },
  {
    // The deterministic smoke deliberately carries one contract breach so
    // the Codex lane opens Raw Activity and visually covers its alarm row.
    kind: "activity",
    laneId: "codex",
    event: event(codexIdentity, codexTurn, 3, SMOKE_STARTED + 205, {
      kind: "text_delta",
      text: "late fixture event",
    }),
  },
  {
    kind: "conversation",
    laneId: "codex",
    entry: {
      kind: "agent",
      id: "smoke-agent-codex",
      text: "Codex is ready to compare the run.",
      receivedAt: SMOKE_STARTED + 210,
    },
  },
  {
    kind: "conversation",
    laneId: "codex",
    entry: {
      kind: "outcome",
      id: "smoke-outcome-codex",
      turnId: codexTurn,
      receivedAt: SMOKE_STARTED + 220,
      outcome: { kind: "completed" },
    },
  },
  {
    ...usageBoundary("codex", codexTurn, "after", SMOKE_STARTED + 60_105, 0.11),
  },
  {
    ...usageErrorBoundary("codex", codexErrorTurn, "before", SMOKE_STARTED + 61_000),
  },
  {
    kind: "activity",
    laneId: "codex",
    event: event(codexIdentity, codexErrorTurn, 4, SMOKE_STARTED + 61_010, { kind: "turn_started" }),
  },
  {
    kind: "activity",
    laneId: "codex",
    event: event(codexIdentity, codexErrorTurn, 5, SMOKE_STARTED + 61_100, {
      kind: "turn_ended",
      outcome: { kind: "failed", failure: "provider", reason: "fixture provider failure" },
    }),
  },
  {
    kind: "conversation",
    laneId: "codex",
    entry: {
      kind: "outcome",
      id: "smoke-outcome-codex-error",
      turnId: codexErrorTurn,
      receivedAt: SMOKE_STARTED + 61_110,
      outcome: { kind: "failed", failure: "provider", reason: "fixture provider failure" },
    },
  },
  {
    ...usageErrorBoundary("codex", codexErrorTurn, "after", SMOKE_STARTED + 61_200),
  },
];

const initial = initialRegattaState(identities);

export interface RegattaFixture {
  readonly identities: readonly SessionIdentity[];
  readonly state: RegattaState;
}

export function smokeRegattaFixture(): RegattaFixture {
  return { identities, state: reduceRegattaEvents(initial, events) };
}
