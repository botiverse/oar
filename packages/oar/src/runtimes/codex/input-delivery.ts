import type { InputImage, RuntimeEventBody } from "../../contracts/session.js";
import { asRecord, type JsonRecord } from "../../shared/json.js";

interface TurnInputs {
  readonly steers: ReadonlySet<string>;
  readonly echoed: ReadonlySet<string>;
}
export type CodexInputs = ReadonlyMap<string, TurnInputs>;

/** Called synchronously at the accepted steer RPC reply, before subsequent notifications. */
export function acceptCodexSteer(inputs: CodexInputs, turnId: string, inputId: string): CodexInputs {
  const turn = inputs.get(turnId) ?? { steers: new Set<string>(), echoed: new Set<string>() };
  if (turn.echoed.has(inputId)) { return inputs; }
  return new Map(inputs).set(turnId, { ...turn, steers: new Set([...turn.steers, inputId]) });
}

/**
 * Root-thread native evidence only. Codex clears pending steering on abort;
 * its TUI restores precisely the unacknowledged steers at interrupted completion.
 * Source and native probe: docs/runtimes/codex.md, "Interrupted input".
 */
export function foldCodexInputs(inputs: CodexInputs, method: string, params: JsonRecord): {
  readonly inputs: CodexInputs;
  readonly events: readonly RuntimeEventBody[];
} {
  const turnId = typeof params.turnId === "string" ? params.turnId : asRecord(params.turn)?.id;
  if (typeof turnId !== "string") { return { inputs, events: [] }; }
  const next = new Map(inputs);
  const item = asRecord(params.item);
  if (method === "item/started" && item?.type === "userMessage" && typeof item.clientId === "string") {
    const turn = inputs.get(turnId) ?? { steers: new Set<string>(), echoed: new Set<string>() };
    const steers = new Set(turn.steers);
    steers.delete(item.clientId);
    next.set(turnId, { steers, echoed: new Set([...turn.echoed, item.clientId]) });
  } else if (method === "turn/completed") {
    const pending = asRecord(params.turn)?.status === "interrupted" ? inputs.get(turnId)?.steers ?? [] : [];
    next.delete(turnId);
    return { inputs: next, events: [...pending].map((inputId) => ({ kind: "input_dropped", inputId, reason: "turn_interrupted" })) };
  }
  return { inputs: next, events: [] };
}

/** Text followed by each local image, matching Codex's composer. */
export function codexUserInput(input: string, images: readonly InputImage[] = []): JsonRecord[] {
  return [...(input === "" ? [] : [{ type: "text", text: input }]), ...images.map((image) => ({ type: "localImage", path: image.path }))];
}
