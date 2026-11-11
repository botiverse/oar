// BYOK change: Modified from OAR 95c6547 to type the caller-injected line process (Apache-2.0).
import type { LineProcess } from "../../runtimes/codex/app-server-client.js"; // BYOK change: the injected line process type.
import type { RequestRecord } from "../../contracts/session.js";
import type { StreamJsonPartials } from "./content.js";

/** Protocol bookkeeping only; each runtime adds its own usage, failure and readback state. */
export interface StreamJsonProjectionState {
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
  agents: new Map(),
  partials: new Map(),
};

export function streamJsonAbortRequested<S extends StreamJsonProjectionState>(state: S): S {
  return { ...state, abortRequested: true };
}

export interface StreamJsonSessionState<S extends StreamJsonProjectionState> {
  child: LineProcess;
  /** The prompt request whose turn is running; null while idle. Spontaneous turns (a drained queue message) run with no request. */
  active: RequestRecord | null;
  /** True while the runtime is executing a turn we did not prompt (queue drain or task notification). */
  spontaneous: boolean;
  projection: S;
  disposed: boolean;
}
