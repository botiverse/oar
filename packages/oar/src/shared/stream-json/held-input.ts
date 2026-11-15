import type { InputOptions, RequestRecord, ResponseBody } from "../../contracts/session.js";
import type { LoadedImage } from "../input-images.js";
import type { SessionKernel } from "../session-kernel.js";
import { streamJsonPrompted } from "./input-lifecycle.js";
import type { StreamJsonProjectionState, StreamJsonSessionState } from "./state.js";

export interface HeldStreamJsonInput {
  readonly request: RequestRecord;
  readonly input: string;
  readonly inputId?: string;
  readonly options: InputOptions;
  readonly images: readonly LoadedImage[];
  accepted?: true;
}

/** Dispatch retains the original native UUID, even though it has a new control request. */
export function writeHeldInput<S extends StreamJsonProjectionState>(state: StreamJsonSessionState<S>, next: HeldStreamJsonInput, driver: {
  readonly kernel: SessionKernel;
  readonly commandLifecycle: boolean;
  readonly writtenQueues: Map<string, RequestRecord>;
  readonly held: HeldStreamJsonInput[];
  readonly userMessage: (input: string, inputId?: string, images?: readonly LoadedImage[]) => string;
  readonly advance: () => void;
}): ResponseBody {
  const blocked = driver.kernel.unreachable();
  if (blocked !== null) { return blocked; }
  const before = state.projection;
  try {
    const message = driver.userMessage(next.input, next.inputId, next.images);
    driver.advance();
    state.active = next.request;
    if (driver.commandLifecycle && next.inputId !== undefined) { driver.writtenQueues.set(next.inputId, next.request); }
    state.projection = streamJsonPrompted(state.projection, next.inputId, false, driver.commandLifecycle);
    if (!driver.commandLifecycle) { state.spontaneous = true; }
    state.child.write(message);
    return { kind: "accepted" };
  } catch (error) {
    state.active = null; state.spontaneous = false; state.projection = before;
    if (next.inputId !== undefined) { driver.writtenQueues.delete(next.inputId); }
    // A thrown write is not a native refusal. Keep ownership without retrying;
    // the host can withdraw the held input or release the session.
    delete next.accepted; driver.held.unshift(next);
    return { kind: "rejected", code: "error", reason: error instanceof Error ? error.message : String(error) };
  }
}
