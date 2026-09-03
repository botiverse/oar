import type {
  AgentViewUpdate,
  HostEvent,
  SessionEventView,
  SessionEventBodyView,
  SessionIdentity,
} from "../../../shared/ipc.js";
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
const claudeIdentity = identities[0];
const codexIdentity = identities[1];
if (claudeIdentity === undefined || codexIdentity === undefined) {
  throw new Error("Regatta smoke fixture is incomplete");
}

const events: readonly HostEvent[] = [
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
];

const initial = initialRegattaState(identities);

export interface RegattaFixture {
  readonly identities: readonly SessionIdentity[];
  readonly state: RegattaState;
}

export function smokeRegattaFixture(): RegattaFixture {
  return { identities, state: reduceRegattaEvents(initial, events) };
}
