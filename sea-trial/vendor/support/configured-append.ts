import { expect } from "vitest";
import type { Session } from "../../../packages/oar/src/index.js";
import type { RawProviderRequest } from "../../harness/aimock.js";
import { runTurn } from "./asserts.js";
import { requestsForTurn } from "./resumed-prompts.js";

export const initialInstruction = "OAR_CONFIGURED_AT_START";
export const reopenedInstruction = "OAR_CONFIGURED_AT_REOPEN";
export const hostAppend = "OAR_HOST_APPEND_MARKER";

/** Check the model request, including order, multiplicity and stale configured text. */
export async function expectConfiguredAppend(session: Session, raw: readonly RawProviderRequest[], configured: string): Promise<void> {
  const cursor = raw.length;
  const prompt = "Check these instructions";
  expect(await runTurn(session, prompt)).toEqual({ kind: "completed" });
  const requests = requestsForTurn(raw.slice(cursor), prompt);
  expect(requests.length).toBeGreaterThan(0);
  for (const { system } of requests) {
    expect(system.match(/OAR_CONFIGURED_AT_START|OAR_CONFIGURED_AT_REOPEN|OAR_HOST_APPEND_MARKER/gu))
      .toEqual([configured, hostAppend]);
  }
}
