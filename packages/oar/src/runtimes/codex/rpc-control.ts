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
  /** Runtime-specific refusal before sending (busy, nothing active); null means proceed. May reserve adapter state. Reachability is not its job. */
  readonly gate: (request: RequestRecord) => ResponseBody | null;
  readonly method: string;
  readonly params: () => JsonRecord;
  readonly onReply: (reply: JsonRecord) => ResponseBody;
  readonly onError: (message: string) => ResponseBody;
}

/**
 * A control action backed by one app-server RPC: record the request; when the
 * stream already says the runtime is unreachable (`kernel.unreachable()`:
 * exited or disposed) record that rejection without running the plan; if the
 * plan's gate refuses, record that; otherwise send and record the reply AS
 * the reply line is read (synchronously, through the client's onSettled hook)
 * so the response sits in the stream before any notification codex wrote
 * after it — a promise continuation would land after notifications from the
 * same chunk.
 */
export async function rpcControl(
  kernel: SessionKernel,
  client: AppServerClient,
  plan: RpcControlPlan,
): Promise<ControlResult> {
  const blocked = kernel.unreachable();
  const request = kernel.request("toRuntime", plan.body);
  const refused = blocked ?? plan.gate(request);
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

/**
 * The open RPC, with its failure named after the method (a refused resume
 * must say `thread/resume` — "no rollout found for thread id …" alone does
 * not) and the app-server that was started for it killed.
 */
export async function openThread(
  client: AppServerClient,
  method: "thread/start" | "thread/resume",
  send: () => Promise<JsonRecord>,
): Promise<JsonRecord> {
  try {
    return await send();
  } catch (error) {
    client.kill();
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`codex ${method} failed: ${message}`, { cause: error });
  }
}
