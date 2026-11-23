import type { SessionKernel } from "../session-kernel.js";
import type { CompactionOperation } from "../manual-compaction.js";
import type { RuntimeEventBody, TurnOutcome, SessionCapabilities, Session, FrameBody, RequestRecord, ResponseBody } from "../../contracts/session.js";
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
  /** This dialect reports the start of compaction with system/status compacting. */
  readonly compactingStatus?: boolean;
  /** Keep the streamed prefix when a dialect emits its full assistant after message_stop. */
  readonly assistantAfterMessageStop?: boolean;
  /** The child's assistant message reports the model that produced it. */
  readonly childAssistantModel?: boolean;
  /** False when native partial events omit message_start and the API message id. */
  readonly partialMessageIds?: boolean;
  /** The next single-block assistant is the completed block's snapshot, even with a new id. */
  readonly assistantFollowsBlockStop?: boolean;
  /** CLI-generated errors have native records but no model content. */
  readonly isAssistantError?: (message: JsonRecord) => boolean;
  readonly assistant: (state: S, message: JsonRecord, agentPath: readonly string[]) => S;
  /** A `user` frame (tool results, replayed prompts), after the shared fold read it; absent leaves the state as is. */
  readonly user?: (state: S, message: JsonRecord, root: boolean) => S;
  readonly result: (state: S, message: JsonRecord, agentPath: readonly string[]) => {
    readonly state: S;
    readonly outcome: TurnOutcome;
    readonly before: readonly RuntimeEventBody[];
    /** The turn's `SessionOptions.fork.through` anchor, stamped on its `turn_ended`; absent where the dialect has none. */
    readonly forkAnchor?: string;
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
  /** The native control body for stopping one task, when this dialect supports it. */
  readonly stopTask?: (taskId: string) => JsonRecord;
  readonly compaction?: { readonly busyReason: string; readonly settledBy?: "native_response"; readonly responseTo?: (message: JsonRecord) => string | undefined; create(send: (request: RequestRecord) => ResponseBody): CompactionOperation };
  readonly userMessage?: (text: string, inputId?: string, images?: readonly LoadedImage[]) => string;
  readonly cancelQueuedCapability?: string;
  /** Private configuration/account responses must be consumed before public projection. */
  readonly consume: (message: JsonRecord) => boolean;
  readonly open: (projection: { current(): S; replace(state: S): void; report(body: FrameBody): void }) => Promise<void>;
  /** Read native settlement facts before publishing root turn end and draining queued input. Must settle on exit/disposal. */
  readonly beforeRootResult?: (kernel: SessionKernel, state: S) => Promise<void> | void;
  readonly exited: (code: number | null) => void;
  /** Why OAR terminated its owned process; absent for an independent native exit. */
  readonly exitReason?: () => string | undefined;
  readonly disposing: () => void;
  readonly close?: (active: boolean) => Promise<void>;
  readonly lastModelRequest?: Session["lastModelRequest"];
  readonly contextBreakdown?: Session["contextBreakdown"];
  /** A native allow response, already in the runtime's own wire shape; null leaves the request unanswered. */
  readonly permissionResponse?: (requestId: string, request: JsonRecord) => JsonRecord | null;
}
