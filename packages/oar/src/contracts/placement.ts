import type { AvailableInstallation } from "./installation.js";
import type { StartSession } from "./session.js";
import { UnsupportedOptionError } from "./errors.js";

/** Host policy on a runtime instance; auto follows version-specific evidence. */
export type PlacementRequest = "auto" | "shared" | "isolated";
/** Observed execution of one opened session, not a request or a capability. */
export type SessionPlacement = "shared" | "isolated" | "in_process";

/** Runtime-author context selected after checking the installation. */
export interface SessionOpenContext {
  readonly requested: PlacementRequest;
  readonly placement: SessionPlacement;
}

/** Runtime-author evidence and construction hooks. Every shared factory owns a fresh pool. */
export type RuntimePlacementOptions = {
  readonly execution: "process";
  readonly shared?: {
    /** Null only for versions/platforms whose complete sharing gate was observed. */
    refusal(installation: AvailableInstallation): string | null;
    session(): StartSession;
  };
} | { readonly execution?: "in_process"; readonly shared?: never };

/** One bounded native cleanup attempt; completed does not promise against future work. */
export type SessionCleanup = { readonly kind: "completed" } | { readonly kind: "failed"; readonly reason: string };

/** OAR gave up control, not evidence of native completion or process death. */
export interface SessionRelease {
  readonly kind: "released";
  readonly reason: "abort_fallback" | "dispose";
  readonly nativeTurnMayContinue: true;
  readonly workStartedAfterCleanupMayContinue: true;
}


/** One runtime instance's lazy shared factory and installation-specific placement check. */
export function placementSession(isolated: StartSession, requested: PlacementRequest, options: RuntimePlacementOptions): StartSession {
  let shared: StartSession | undefined = undefined;
  return async (installation, sessionOptions) => {
    const placement = selectPlacement(installation, requested, options);
    let open = isolated;
    if (placement === "shared") {
      shared ??= options.shared?.session();
      if (shared === undefined) { throw new UnsupportedOptionError("placement", "Shared placement has no session implementation"); }
      open = shared;
    }
    const context = placement === null ? undefined : { requested, placement };
    const session = await open(installation, sessionOptions, context);
    return session;
  };
}

function selectPlacement(installation: AvailableInstallation, requested: PlacementRequest, options: RuntimePlacementOptions): SessionPlacement | null {
  if (options.execution === undefined) {
    return fixedPlacement(requested, null, "This adapter does not declare process placement");
  }
  if (options.execution === "in_process") {
    return fixedPlacement(requested, "in_process", "This runtime runs in the host process");
  }
  if (requested === "isolated") { return "isolated"; }
  const refusal = options.shared === undefined ? "Shared placement has not been verified for this runtime version and platform" : options.shared.refusal(installation);
  if (requested === "shared" && refusal !== null) { throw new UnsupportedOptionError("placement", refusal); }
  return refusal === null ? "shared" : "isolated";
}

function fixedPlacement(requested: PlacementRequest, placement: SessionPlacement | null, reason: string): SessionPlacement | null {
  if (requested !== "auto") { throw new UnsupportedOptionError("placement", reason); }
  return placement;
}
