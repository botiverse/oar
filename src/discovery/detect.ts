/** Public facade for catalog/model detection. */
export type {
  CatalogTarget,
  DetectCollectOptions,
  DetectFailure,
  ModelsProbeFailure,
  ProbeTraceEvent,
  RuntimeDescriptor,
  RuntimeTimings,
} from "./catalog/types.js";

export {
  MODELS_PROBE_BUDGET_MS,
  ModelsProbeError,
} from "./catalog/types.js";

export {
  detectAll,
  detectAllRegistered,
} from "./catalog/service.js";
