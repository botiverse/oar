import type { ListModelsResult, ModelEntry } from "../contracts/list-models.js";
import type { ListingReason, ModelListing } from "./types.js";

/** A listing attempt that did not return a `ListModelsResult` (the host saw the failure). */
export interface ListingFailure {
  readonly kind: "error";
  readonly reason: "timeout" | "failed" | "machine_offline";
}

function reasonOf(outcome: ListModelsResult | ListingFailure): ListingReason {
  if (outcome.kind === "ok") {
    return "empty";
  }
  if (outcome.kind === "error") {
    return outcome.reason;
  }
  return outcome.kind;
}

/**
 * A `listModels` outcome as a form listing. "Not enumerated" is a status with a
 * reason, never an empty list: an empty result is `empty`, and a host-supplied
 * bundled list makes a non-live outcome a `fallback` that still names why.
 */
export function toModelListing(
  outcome: ListModelsResult | ListingFailure,
  bundled: readonly ModelEntry[] = [],
): ModelListing {
  if (outcome.kind === "ok" && outcome.models.length > 0) {
    return { status: "live", models: outcome.models };
  }
  const reason = reasonOf(outcome);
  if (bundled.length > 0) {
    return { status: "fallback", source: "bundled", reason, models: bundled };
  }
  return { status: "unavailable", reason };
}

export function listedModels(listing: ModelListing): readonly ModelEntry[] {
  return listing.status === "unavailable" ? [] : listing.models;
}
