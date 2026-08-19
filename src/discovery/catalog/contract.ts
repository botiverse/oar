import type { ModelInfo, ProviderInfo } from "../../config/model.js";

export type DetectFailure =
  | "models_unavailable"
  | "detect_failed"
  | "not_installed"
  | "needs_login";

export type ModelsProbeFailure = Extract<
  DetectFailure,
  "models_unavailable" | "needs_login"
>;

export interface RuntimeTimings {
  readonly detectMs: number;
  readonly modelsMs: number | null;
  readonly totalMs: number;
}

export const MODELS_PROBE_BUDGET_MS = 5_000;

export interface ProbeTraceEvent {
  readonly phase: "detect" | "models";
  readonly command?: string;
  readonly exitCode?: number | null;
  readonly durationMs: number;
  readonly stdoutExcerpt?: string;
  readonly stderrExcerpt?: string;
  readonly note?: string;
}

export class ModelsProbeError extends Error {
  readonly failure: ModelsProbeFailure;

  constructor(failure: ModelsProbeFailure, message: string) {
    super(message);
    this.name = "ModelsProbeError";
    this.failure = failure;
  }
}

export interface RuntimeDescriptor {
  readonly runtime: string;
  readonly version: string;
  readonly label?: string;
  readonly models: readonly ModelInfo[];
  readonly providers?: readonly ProviderInfo[];
  readonly failure?: DetectFailure;
  readonly timings?: RuntimeTimings;
  readonly inProcess?: boolean;
  readonly debug?: readonly ProbeTraceEvent[];
}

export interface DetectCollectOptions {
  readonly modelsBudgetMs?: number;
}

/** Catalog-only boundary; session/process mechanisms are deliberately absent. */
export interface CatalogTarget {
  readonly id: string;
  detect(): Promise<{ readonly version: string } | null>;
  models(): Promise<readonly ModelInfo[]>;
  providers?(): Promise<readonly ProviderInfo[]>;
}
