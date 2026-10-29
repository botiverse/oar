import type { RuntimeEventBody, TurnOutcome, SessionCapabilities, Session, FrameBody } from "../../contracts/session.js";
import type { LoadedImage } from "../input-images.js";
import type { JsonRecord } from "../json.js";
import type { StreamJsonProjectionState } from "./state.js";

export interface StreamJsonUpdate<S> {
  readonly state: S;
  readonly events: readonly RuntimeEventBody[];
}

/** Runtime meanings, never selected by a runtime name inside the shared fold. */
export interface StreamJsonProjectionProfile<S extends StreamJsonProjectionState> {
  readonly name: string;
  readonly duplicateReason: string;
  /** Whether the native protocol acknowledges inputs with command_lifecycle frames. */
  readonly commandLifecycle?: boolean;
  /** Whether init starts a turn; false for dialects that emit it while idle and report command_lifecycle starts. */
  readonly initStartsTurn?: boolean;
  /** Keep the streamed prefix when a dialect emits its full assistant after message_stop. */
  readonly assistantAfterMessageStop?: boolean;
  /** False when native partial events omit message_start and the API message id. */
  readonly partialMessageIds?: boolean;
  readonly assistant: (state: S, message: JsonRecord, root: boolean) => S;
  readonly result: (state: S, message: JsonRecord, agentPath: readonly string[]) => {
    readonly state: S;
    readonly outcome: TurnOutcome;
    readonly before: readonly RuntimeEventBody[];
    readonly after: readonly RuntimeEventBody[];
  };
  readonly init: (message: JsonRecord) => readonly RuntimeEventBody[];
  readonly compacted: (state: S, root: boolean) => S;
  readonly system: (state: S, message: JsonRecord, agentPath: readonly string[]) => StreamJsonUpdate<S>;
  readonly other: (state: S, message: JsonRecord) => StreamJsonUpdate<S>;
}

/** Process-specific startup and capabilities; line framing and process ownership use LineProcess. */
export interface StreamJsonSessionProfile<S extends StreamJsonProjectionState> {
  readonly projection: StreamJsonProjectionProfile<S>;
  readonly initial: S;
  readonly capabilities: SessionCapabilities;
  readonly steer: boolean;
  readonly userMessage?: (text: string, inputId?: string, images?: readonly LoadedImage[]) => string;
  readonly cancelQueuedCapability?: string;
  /** Private configuration/account responses must be consumed before public projection. */
  readonly consume: (message: JsonRecord) => boolean;
  readonly open: (projection: { current(): S; replace(state: S): void; report(body: FrameBody): void }) => Promise<void>;
  readonly exited: (code: number | null) => void;
  /** Why OAR terminated its owned process; absent for an independent native exit. */
  readonly exitReason?: () => string | undefined;
  readonly disposing: () => void;
  readonly close?: (active: boolean) => Promise<void>;
  readonly contextBreakdown?: Session["contextBreakdown"];
  /** A native allow response, already in the runtime's own wire shape; null leaves the request unanswered. */
  readonly permissionResponse?: (requestId: string, request: JsonRecord) => JsonRecord | null;
}
