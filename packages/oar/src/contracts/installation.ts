/** A verified machine-installed executable: the probed command and its reported version. */
export interface ExecutableInstallation {
  readonly kind: "available";
  readonly via: "executable";
  readonly command: string;
  readonly version?: string;
}

/**
 * A runtime compiled into the embedding application; availability needs no
 * probe target. Version is absent when the code is reachable but no trustworthy
 * manifest is (bundled/SEA deployments without node_modules on disk).
 */
export interface BundledInstallation {
  readonly kind: "available";
  readonly via: "bundled";
  readonly version?: string;
}

export type AvailableInstallation = ExecutableInstallation | BundledInstallation;

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
