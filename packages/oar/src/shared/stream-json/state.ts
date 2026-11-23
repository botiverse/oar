import type { LineProcess } from "../executable/index.js";
import type { RequestRecord } from "../../contracts/session.js";
import type { StreamJsonPartials } from "./content.js";

/** Protocol bookkeeping only; each runtime adds its own usage, failure and readback state. */
export interface StreamJsonProjectionState {
  /** A dialect with a startup init reports turn inits after the opening handshake. */
  readonly startupInit?: "pending" | "received";
  readonly abortRequested: boolean;
  /** Prompt requests and root init/results delimit a turn, including native spontaneous turns. */
  readonly turnActive: boolean;
  /** Unlike the provisional prompt start, this is an observed init/started without a result. */
  readonly nativeTurnActive: boolean;
  /** Root init since this prompt write, not claimed by started or reported as spontaneous yet. */
  readonly unclaimedInit: boolean;
  /** Prompt identity and native queue evidence, retained across unrelated turns. */
  readonly promptInputId: string | null;
  /** Prompt-like writes, including queue drains; steers are never registered. */
  readonly promptInputs: ReadonlySet<string>;
  /** Written prompt inputs with no native started yet, including the pre-queued window. */
  readonly unstartedInputs: ReadonlySet<string>;
  /** Prompt-like writes with neither queued nor started since THIS write; reset when an id is reused. */
  readonly unacknowledgedInputs: ReadonlySet<string>;
  readonly pendingInputId: string | null;
  /** Agent paths with a native compacting status, until its clear, boundary or result. */
  readonly compactingAgents: ReadonlySet<string>;
  readonly childModels: ReadonlyMap<string, string>;
  readonly agents: ReadonlyMap<string, readonly string[]>;
  readonly partials: StreamJsonPartials;
}

export const initialStreamJsonProjection: StreamJsonProjectionState = {
  abortRequested: false,
  turnActive: false,
  nativeTurnActive: false,
  unclaimedInit: false,
  promptInputId: null,
  promptInputs: new Set(),
  unstartedInputs: new Set(),
  unacknowledgedInputs: new Set(),
  pendingInputId: null,
  compactingAgents: new Set(),
  agents: new Map(),
  childModels: new Map(),
  partials: new Map(),
};

export function streamJsonAbortRequested<S extends StreamJsonProjectionState>(state: S): S {
  return { ...state, abortRequested: true };
}

export interface StreamJsonSessionState<S extends StreamJsonProjectionState> {
  child: LineProcess;
  /** The prompt request whose turn is running; null while idle. Spontaneous turns (a drained queue message) run with no request. */
  active: RequestRecord | null;
  projection: S;
}
