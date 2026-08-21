export type InstallationState =
  | "available"
  | "not_installed"
  | "incompatible"
  | "detect_failed";

export type InstallationSource = "explicit" | "path" | "bundled" | "sdk";

export interface InstallationDiagnostic {
  readonly code: string;
  readonly detail?: string;
}

export interface InstallationSnapshot {
  readonly runtime: string;
  readonly state: InstallationState;
  readonly observedAt: string;
  readonly version?: string;
  readonly source?: InstallationSource;
  readonly diagnostic?: InstallationDiagnostic;
}

/** A local-only installation observation. Implementations must not perform account or usage I/O. */
export interface Installation {
  probe(): Promise<InstallationSnapshot>;
}
