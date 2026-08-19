/** Public facade for catalog/model detection. */
export type {
  CatalogTarget,
  DetectCollectOptions,
  DetectFailure,
  ModelsProbeFailure,
  ProbeTraceEvent,
  RuntimeDescriptor,
  RuntimeTimings,
} from "./catalog/contract.js";

export {
  MODELS_PROBE_BUDGET_MS,
  ModelsProbeError,
} from "./catalog/contract.js";

export {
  detectAll,
  detectAllRegistered,
} from "./catalog/detectCatalog.js";
