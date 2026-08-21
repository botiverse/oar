/** A verified local installation: the probed executable and its reported version. */
export interface AvailableInstallation {
  readonly kind: "available";
  readonly command: string;
  readonly version?: string;
}

export type InstallationSnapshot =
  | AvailableInstallation
  | {
      readonly kind: "not_found";
    }
  | {
      readonly kind: "unsupported";
      readonly reason: string;
    };

/** A local-only installation observation. Implementations must not perform account or usage I/O. */
export type InstallationProbe = () => Promise<InstallationSnapshot>;
