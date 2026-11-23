import type { FrameBody, TokenTotals } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { RecordAt } from "../../shared/session-kernel.js";

export interface KapPendingInteraction {
  readonly interactionId: string;
  readonly kind: "approval" | "question";
  readonly agentId: string;
  readonly toolCallId?: string;
  readonly native: JsonRecord;
}

export interface KapTurnRef {
  readonly turnId: string;
  readonly agentId: string;
  readonly steeredFromTurnId?: string;
  readonly steeredFromPromptId?: string;
}

export interface KapEndedTurnRef {
  readonly turnId: string;
  readonly agentId: string;
  readonly outcome: "completed" | "aborted" | "failed";
}

export interface KapProjectedFrame {
  readonly at: RecordAt;
  readonly body: FrameBody;
  readonly skipFrame?: true;
  readonly subscribeAgents?: readonly string[];
  readonly pendingInteraction?: KapPendingInteraction;
  readonly endedInteractionId?: string;
  readonly openedTurn?: KapTurnRef;
  readonly endedTurn?: KapEndedTurnRef;
  readonly rootUserPromptIds?: readonly string[];
}

export interface KapProjectionOptions {
  readonly manualCompactionActive: boolean;
  readonly pendingToAppInteractions?: ReadonlySet<string>;
}

export interface KapProjectionState {
  readonly rootSessionId: string;
  readonly agentPaths: Map<string, readonly string[]>;
  readonly subscribedAgents: Set<string>;
  readonly seenInitialTurns: Set<string>;
  readonly historicalTurnIds: Set<string>;
  readonly systemTurnIds: Set<string>;
  readonly startedTurnIds: Set<string>;
  readonly endedTurnIds: Set<string>;
  readonly activeTurnByAgent: Map<string, string>;
  readonly turnPromptIds: Map<string, string[]>;
  readonly stepUsageByTurn: Map<string, Map<number, TokenTotals>>;
  readonly cumulativeTokensByAgent: Map<string, TokenTotals>;
  readonly lastModelByAgent: Map<string, string>;
  readonly lastEffortByAgent: Map<string, string>;
  readonly emittedUserMessageIds: Set<string>;
  readonly itemTypes: Map<string, string>;
  readonly emittedTextLength: Map<string, number>;
  readonly startedToolCalls: Set<string>;
  readonly endedToolCalls: Set<string>;
  readonly emittedCompleteToolInputs: Map<string, string>;
  readonly startedTaskIds: Set<string>;
  readonly endedTaskIds: Set<string>;
  readonly startedCompactions: Set<string>;
  readonly endedCompactions: Set<string>;
  readonly seenPendingInteractions: Set<string>;
}

export function createKapProjection(rootSessionId: string): KapProjectionState {
  return {
    rootSessionId,
    agentPaths: new Map([["main", []]]),
    subscribedAgents: new Set(["main"]),
    seenInitialTurns: new Set(),
    historicalTurnIds: new Set(),
    systemTurnIds: new Set(),
    startedTurnIds: new Set(),
    endedTurnIds: new Set(),
    activeTurnByAgent: new Map(),
    turnPromptIds: new Map(),
    stepUsageByTurn: new Map(),
    cumulativeTokensByAgent: new Map(),
    lastModelByAgent: new Map(),
    lastEffortByAgent: new Map(),
    emittedUserMessageIds: new Set(),
    itemTypes: new Map(),
    emittedTextLength: new Map(),
    startedToolCalls: new Set(),
    endedToolCalls: new Set(),
    emittedCompleteToolInputs: new Map(),
    startedTaskIds: new Set(),
    endedTaskIds: new Set(),
    startedCompactions: new Set(),
    endedCompactions: new Set(),
    seenPendingInteractions: new Set(),
  };
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

export function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) { return []; }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") { out.push(entry); }
  }
  return out;
}

export function stringifyToolInput(value: unknown): string | undefined {
  if (typeof value === "string") { return value; }
  if (value === undefined || value === null) { return undefined; }
  try {
    return JSON.stringify(value);
  } catch {
    return typeof value === "symbol" ? String(value) : undefined;
  }
}
