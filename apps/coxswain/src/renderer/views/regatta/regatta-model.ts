import type {
  AgentViewUpdate,
  ConversationEntry,
  HostEvent,
  SessionEventView,
  SessionIdentity,
  SubmitReceipt,
  UsageBoundaryView,
} from "../../../shared/ipc.js";
import { usageViewsByTurn, type TurnUsageView } from "../usage-helm/usage-model.js";

export interface RegattaLaneState {
  readonly identity: SessionIdentity;
  readonly agentView: AgentViewUpdate;
  readonly activity: readonly SessionEventView[];
  readonly conversation: readonly ConversationEntry[];
  readonly usage: readonly UsageBoundaryView[];
  readonly hostError: string | null;
}

export type RegattaState = readonly RegattaLaneState[];

export interface BroadcastReceipt {
  readonly accepted: number;
  readonly total: number;
  readonly rejected: readonly string[];
}

const INITIAL_AGENT_VIEW: AgentViewUpdate = {
  status: { kind: "idle" },
  stall: null,
  simple: "idle",
};

export function initialRegattaState(
  identities: readonly SessionIdentity[],
  views: ReadonlyMap<string, AgentViewUpdate> = new Map(),
): RegattaState {
  return identities.map((identity) => ({
    identity,
    agentView: views.get(identity.laneId) ?? INITIAL_AGENT_VIEW,
    activity: [],
    conversation: [],
    usage: [],
    hostError: null,
  }));
}

function updateLane(
  state: RegattaState,
  laneId: string,
  update: (lane: RegattaLaneState) => RegattaLaneState,
): RegattaState {
  const next = state.map((lane) => {
    if (lane.identity.laneId !== laneId) {
      return lane;
    }
    const updated = update(lane);
    return updated;
  });
  return next.some((lane, index) => lane !== state[index]) ? next : state;
}

/** Fold lane-tagged host events into independent Regatta columns. */
export function reduceRegattaEvent(state: RegattaState, event: HostEvent): RegattaState {
  if (event.laneId === undefined) {
    return state;
  }
  return updateLane(state, event.laneId, (lane) => {
    switch (event.kind) {
      case "activity":
        return { ...lane, activity: [...lane.activity, event.event] };
      case "agent_view":
        return { ...lane, agentView: event.view };
      case "conversation":
        return { ...lane, conversation: [...lane.conversation, event.entry] };
      case "usage":
        return { ...lane, usage: [...lane.usage, event.boundary] };
      case "host_error":
        return { ...lane, hostError: event.message };
      default:
        throw new Error("Unknown Regatta host event");
    }
  });
}

export function usageForLane(lane: RegattaLaneState): ReadonlyMap<string, TurnUsageView> {
  return usageViewsByTurn(lane.usage);
}

export function reduceRegattaEvents(
  state: RegattaState,
  events: readonly HostEvent[],
): RegattaState {
  return events.reduce((current, event) => reduceRegattaEvent(current, event), state);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "input could not be delivered";
}

/** Broadcast one prompt concurrently and retain per-lane failures. */
export async function broadcastRegattaPrompt(
  lanes: RegattaState,
  text: string,
  submit: (laneId: string, text: string) => Promise<SubmitReceipt>,
): Promise<BroadcastReceipt> {
  const results = await Promise.all(lanes.map(async (lane) => {
    try {
      return {
        runtimeId: lane.identity.runtimeId,
        receipt: await submit(lane.identity.laneId, text),
      } as const;
    } catch (error) {
      return {
        runtimeId: lane.identity.runtimeId,
        receipt: { landed: "rejected" as const, reason: errorMessage(error) },
      } as const;
    }
  }));
  const rejected = results.flatMap(({ runtimeId, receipt }) => receipt.landed === "rejected"
    ? [`${runtimeId}: ${receipt.reason}`]
    : []);
  return { accepted: results.length - rejected.length, total: results.length, rejected };
}
