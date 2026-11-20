import { expect } from "vitest";
import type { Session, SessionOptions } from "../../../packages/oar/src/index.js";
import type { RawProviderRequest } from "../../harness/aimock.js";
import { runTurn } from "./asserts.js";
import { requestsForTurn } from "./resumed-prompts.js";

export const initialInstruction = "OAR_CONFIGURED_AT_START";
export const reopenedInstruction = "OAR_CONFIGURED_AT_REOPEN";
export const hostAppend = "OAR_HOST_APPEND_MARKER";

/**
 * Where the runtime places native configured instructions relative to the host append:
 * - `"system"`: both configured instructions and host append are in the system/developer prompt, configured first.
 * - `"user_context"`: host append is in the system prompt; native configured instructions travel in user-role context.
 */
export type ConfiguredPlacement = "system" | "user_context";

export interface ConfiguredAppendFixture {
  readonly raw: readonly RawProviderRequest[];
  readonly placement?: ConfiguredPlacement;
  readonly captureTurn?: (session: Session, prompt: string) => Promise<readonly RawProviderRequest[]>;
  configure(value: string): Promise<void>;
  open(options: Partial<SessionOptions>): Promise<Session>;
}

const MARKERS = /OAR_CONFIGURED_AT_START|OAR_CONFIGURED_AT_REOPEN|OAR_HOST_APPEND_MARKER/gu;

/** Assert presence, order, multiplicity and absence of stale text across a turn's captured provider requests. */
function assertConfiguredAppendRequests(
  requests: readonly { readonly system: string; readonly history: string }[],
  configured: string,
  placement: ConfiguredPlacement = "system",
): void {
  for (const { system, history } of requests) {
    if (placement === "system") {
      expect(system.match(MARKERS)).toEqual([configured, hostAppend]);
    } else {
      expect(system.match(MARKERS)).toEqual([hostAppend]);
      expect(history.match(MARKERS)).toEqual([configured]);
    }
  }
}

/** Check the model request, including order, multiplicity and stale configured text. */
export async function expectConfiguredAppend(
  session: Session,
  raw: readonly RawProviderRequest[],
  configured: string,
  options: { readonly placement?: ConfiguredPlacement; readonly captureTurn?: (session: Session, prompt: string) => Promise<readonly RawProviderRequest[]> } = {},
): Promise<void> {
  const prompt = "Check these instructions";
  const captureDefault = async (): Promise<readonly RawProviderRequest[]> => {
    const cursor = raw.length;
    expect(await runTurn(session, prompt)).toEqual({ kind: "completed" });
    return raw.slice(cursor);
  };
  const captured = options.captureTurn === undefined ? await captureDefault() : await options.captureTurn(session, prompt);
  const unmatched: string[] = [];
  const matched = requestsForTurn(captured, prompt, unmatched);
  if (matched.length === 0) {
    throw new Error(`Expected a provider request for ${JSON.stringify(prompt)}. Captured ${String(captured.length)} requests. Unmatched user prompts: ${JSON.stringify(unmatched)}`);
  }
  assertConfiguredAppendRequests(matched, configured, options.placement ?? "system");
}
