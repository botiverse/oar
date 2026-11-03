import type { RequestRecord } from "../../contracts/session.js";
import type { LineProcess } from "../executable/index.js";
import { manualCompaction } from "../manual-compaction.js";
import type { SessionKernel } from "../session-kernel.js";
import { streamJsonPrompted, streamJsonUserMessage } from "./input-lifecycle.js";
import type { StreamJsonSessionProfile } from "./profile.js";
import type { StreamJsonProjectionState } from "./state.js";

/** Provenance can await a private read; recheck native input ownership immediately before writing. */
export function streamJsonCompaction<S extends StreamJsonProjectionState>(
  kernel: SessionKernel,
  profile: StreamJsonSessionProfile<S>,
  state: { readonly child: LineProcess; active: RequestRecord | null; spontaneous: boolean; projection: S },
  released: () => void,
  queued: () => boolean,
): ReturnType<typeof manualCompaction> | null {
  const control = profile.compaction;
  if (control === undefined) { return null; }
  const busy = (): boolean => state.active !== null || state.spontaneous || queued() || state.projection.unstartedInputs.size > 0;
  return manualCompaction(kernel, {
    busy, busyReason: control.busyReason, released, ...(control.settledBy === undefined ? {} : { settledBy: control.settledBy }),
    create: () => control.create((request) => {
      const refusal = kernel.unreachable();
      if (refusal !== null) { return refusal; }
      if (busy()) { return { kind: "rejected", code: "busy", reason: control.busyReason }; }
      state.active = request;
      state.projection = streamJsonPrompted(state.projection, request.id, true, profile.projection.commandLifecycle !== false);
      state.child.write((profile.userMessage ?? streamJsonUserMessage)("/compact", request.id));
      return { kind: "accepted" };
    }),
  });
}
