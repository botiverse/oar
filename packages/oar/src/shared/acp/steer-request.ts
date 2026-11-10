import { RequestError } from "@agentclientprotocol/sdk";
import type { InputOptions, RequestRecord, ResponseBody, SessionCapabilities } from "../../contracts/session.js";
import { withInputImages } from "../input-images.js";
import type { SessionKernel } from "../session-kernel.js";
import type { AcpSessionProfile } from "./profile.js";
import { acpProcessExitedError } from "./errors.js";
import { acpPrompt } from "./prompt.js";
import { withAcpDeadline, type AcpProcess } from "./process.js";
import { acpErrorNative } from "./projection.js";

/**
 * A profile's own steer RPC (grok `_x.ai/interject`): its answer admits the
 * input, recorded as a frame answering the steer request. An RPC error is the
 * runtime's refusal; anything else is a delivery failure.
 */
const noActiveTurn: ResponseBody = { kind: "rejected", code: "no_active_turn", reason: "not_steerable: no active turn" };
const stale = new Error("not_steerable: no active turn");

export async function sendAcpSteerRequest(
  deps: { readonly kernel: SessionKernel; readonly runtime: AcpProcess; readonly profile: AcpSessionProfile; readonly capabilities: Pick<SessionCapabilities, "images">; readonly running: () => boolean },
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
      return { kind: "accepted" };
    } catch (error) {
      if (error === stale) { return noActiveTurn; }
      if (runtime.closed) { return gone; }
      kernel.frame({ type: `${method}/error`, native: acpErrorNative(error), responseTo: request.id, events: [] });
      return { kind: "rejected", code: error instanceof RequestError ? "runtime_refused" : "error", reason: error instanceof Error ? error.message : String(error) };
    }
  });
}
