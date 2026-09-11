import type {
  ControlResult,
  RequestBody,
  RequestRecord,
  ResponseBody,
  ResponseRecord,
} from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import type { SessionKernel } from "../../shared/session-kernel.js";
import type { AppServerClient } from "./app-server-client.js";

export interface RpcControlPlan {
  readonly body: RequestBody;
  /** Refuse before sending (busy, disposed, nothing active); null means proceed. May reserve adapter state. */
  readonly gate: (request: RequestRecord) => ResponseBody | null;
  readonly method: string;
  readonly params: () => JsonRecord;
  readonly onReply: (reply: JsonRecord) => ResponseBody;
  readonly onError: (message: string) => ResponseBody;
}

/**
 * A control action backed by one app-server RPC: record the request; if the
 * gate refuses, record that; otherwise send and record the reply AS the reply
 * line is read (synchronously, through the client's onSettled hook) so the
 * response sits in the stream before any notification codex wrote after it —
 * a promise continuation would land after notifications from the same chunk.
 */
export async function rpcControl(
  kernel: SessionKernel,
  client: AppServerClient,
  plan: RpcControlPlan,
): Promise<ControlResult> {
  const request = kernel.request("toRuntime", plan.body);
  const refused = plan.gate(request);
  if (refused !== null) {
    return { request, response: kernel.respond(request.id, refused) };
  }
  const { promise, resolve } = Promise.withResolvers<ResponseRecord>();
  let recorded = false;
  const record = (decided: ResponseBody): void => {
    if (!recorded) {
      recorded = true;
      resolve(kernel.respond(request.id, decided));
    }
  };
  try {
    await client.request(plan.method, plan.params(), (outcome) => {
      record(outcome.kind === "result" ? plan.onReply(outcome.result) : plan.onError(outcome.error.message));
    });
  } catch (error) {
    record(plan.onError(error instanceof Error ? error.message : String(error)));
  }
  return { request, response: await promise };
}
