import type { InputOptions, RequestRecord, RuntimeEventBody } from "../../contracts/session.js";
import type { LoadedImage } from "../../shared/input-images.js";

/** Original queue identity and options survive the adapter's dispatch. */
export interface PiHeldInput {
  readonly body: InputOptions & { readonly kind: "queue"; readonly input: string };
  readonly requestId: string;
  readonly inputId: string | undefined;
  readonly images: readonly LoadedImage[];
  accepted?: true;
}

export function handledInput(request: RequestRecord): Extract<RuntimeEventBody, { kind: "input_handled" }> {
  const inputId = "inputId" in request.body ? request.body.inputId : undefined;
  return { kind: "input_handled", requestId: request.id, ...(inputId === undefined ? {} : { inputId }) };
}

/** Pi's per-call started receipt names the native run that passed this input's preflight. */
export function startedInput(request: RequestRecord): Extract<RuntimeEventBody, { kind: "turn_active" }> {
  const inputId = "inputId" in request.body ? request.body.inputId : undefined;
  const carried = request.body.kind === "prompt" && request.body.carries?.length === 1 ? request.body.carries[0] : undefined;
  const id = inputId ?? carried;
  return { kind: "turn_active", ...(id === undefined ? {} : { inputId: id }) };
}

export function refusedInput(request: RequestRecord, message: string): Extract<RuntimeEventBody, { kind: "input_dropped" }> {
  return { ...handledInput(request), kind: "input_dropped", reason: "runtime_refused", message };
}
