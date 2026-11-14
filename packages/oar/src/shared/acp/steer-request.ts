import { RequestError } from "@agentclientprotocol/sdk";
import type { InputOptions, RequestRecord, ResponseBody, SessionCapabilities } from "../../contracts/session.js";
import { withInputImages } from "../input-images.js";
import type { SessionKernel } from "../session-kernel.js";
import type { JsonRecord } from "../json.js";
import { acpProcessExitedError } from "./errors.js";
import { acpPrompt } from "./prompt.js";
import { withAcpDeadline, type AcpProcess } from "./process.js";
import { acpErrorNative } from "./projection.js";

/** Profile hooks for a native steer that is its own RPC, not another prompt (grok `_x.ai/interject`). Exclusive with `steerParams`. */
export interface AcpSteerRequestHooks {
  /** The request; an admitted input joins the running turn, which still ends with the original prompt's answer. */
  readonly steerRequest?: (context: { readonly sessionId: string; readonly input: string; readonly prompt: readonly JsonRecord[]; readonly inputId: string }) => { readonly method: string; readonly params: JsonRecord };
  /** Whether this connection's `initialize` answer advertises `steerRequest`; false leaves the session without `steer`. Absent: it always exists. */
  readonly steerRequestAdvertised?: (initialized: JsonRecord) => boolean;
  /**
   * Reads the answer to `steerRequest`: `accepted` admits the input into the
   * running turn; `no_active_turn` is the runtime's report that nothing was
   * running to take it and that it started no turn; null is an answer OAR
   * does not recognize. Absent: every answer admits (grok).
   */
  readonly steerRequestAnswer?: (answer: unknown) => "accepted" | "no_active_turn" | null;
}

/**
 * A profile's own steer RPC (grok `_x.ai/interject`): its answer, recorded as
 * a frame answering the steer request, admits the input unless the profile
 * reads it as the runtime's report of no running turn (`steerRequestAnswer`).
 * An RPC error is the runtime's refusal; anything else is a delivery failure.
 */
const noActiveTurn: ResponseBody = { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
const stale = new Error("not_steerable: no active turn");

export async function sendAcpSteerRequest(
  deps: { readonly kernel: SessionKernel; readonly runtime: AcpProcess; readonly profile: AcpSteerRequestHooks & { readonly requestTimeoutMs?: number | undefined }; readonly capabilities: Pick<SessionCapabilities, "images">; readonly running: () => boolean },
  request: RequestRecord,
  input: string,
  options: InputOptions | undefined,
): Promise<ResponseBody> {
  const { kernel, runtime, profile, capabilities } = deps;
  const build = profile.steerRequest;
  if (build === undefined) { throw new Error("The profile has no steer request"); }
  await runtime.spawned;
  const gone: ResponseBody = { kind: "rejected", code: "runtime_exited", reason: acpProcessExitedError(runtime.exitCode).message };
  if (runtime.closed) { return gone; }
  // OAR's turn or the runtime's own: an interjection with nothing running would start a turn of its own.
  if (!deps.running()) { return noActiveTurn; }
  return withInputImages(capabilities, options?.images, async (loaded): Promise<ResponseBody> => {
    const { method, params } = build({ sessionId: kernel.sessionId, input, prompt: acpPrompt(input, loaded), inputId: options?.inputId ?? request.id });
    try {
      const native = await withAcpDeadline(runtime, method, profile.requestTimeoutMs ?? 15_000,
        // oxlint-disable-next-line typescript/promise-function-async -- SDK callback returns its native request promise.
        (requestOptions) => {
          // After the transport's own spawn wait, immediately before dispatch: the turn may have ended or been replaced.
          if (!deps.running()) { throw stale; }
          return runtime.connection.agent.request(method, params, requestOptions);
        });
      kernel.frame({ type: method, native: native ?? null, responseTo: request.id, events: [] });
      const read = profile.steerRequestAnswer;
      const answer = read === undefined ? "accepted" : read(native);
      if (answer === "accepted") { return { kind: "accepted" }; }
      if (answer === "no_active_turn") { return { kind: "rejected", code: "no_active_turn", reason: "not_steerable: the runtime reports no running turn" }; }
      return { kind: "rejected", code: "error", reason: `unrecognized ${method} answer; whether the runtime took the input is unknown` };
    } catch (error) {
      if (error === stale) { return noActiveTurn; }
      if (runtime.closed) { return gone; }
      kernel.frame({ type: `${method}/error`, native: acpErrorNative(error), responseTo: request.id, events: [] });
      return { kind: "rejected", code: error instanceof RequestError ? "runtime_refused" : "error", reason: error instanceof Error ? error.message : String(error) };
    }
  });
}
