import type { AvailableInstallation } from "./installation.js";

/**
 * Why a check could not name the version the runtime's own updater would
 * install. Never a guess that the installation is current.
 */
export type UpdateCheckUnavailableReason =
  | "unsupported_installation" // not a machine-installed executable (a bundled runtime moves with the package that carries it)
  | "package_manager" // a package manager (Homebrew, WinGet, ...) owns this copy and its updates
  | "unmanaged_installation" // the runtime's updater does not recognize this copy (a copied binary, an unknown layout)
  | "updates_disabled" // the runtime's own configuration turns updates off
  | "lookup_failed" // the runtime's release source could not be read
  | "version_unreadable"; // the installed or released version could not be read

/**
 * What the installed runtime's own updater would do. `source` names where
 * the answer came from: the runtime command that answered, or the release
 * URL its updater reads. `latest` is that source's version for the
 * installation's channel, so it can be older than `installed` (a stable
 * channel behind a newer manual install); `updateAvailable` is then the
 * runtime's own verdict where it gives one, otherwise `latest !== installed`.
 */
export type UpdateCheck =
  | {
      readonly kind: "ok";
      readonly installed: string;
      readonly latest: string;
      readonly updateAvailable: boolean;
      /** Release channel the check followed, when the runtime has channels. */
      readonly channel?: string;
      readonly source: string;
    }
  | {
      readonly kind: "unavailable";
      readonly reason: UpdateCheckUnavailableReason;
      readonly detail?: string;
      readonly source?: string;
    };

export interface UpdateCheckOptions {
  readonly timeoutMs?: number;
}

/** Read only: never installs, never changes the runtime's update settings. */
export type UpdateChecker = (
  installation: AvailableInstallation,
  options?: UpdateCheckOptions,
) => Promise<UpdateCheck>;

/**
 * The outcome of running the runtime's own updater, judged by the version
 * the same executable reports afterwards, never by the updater's exit code
 * or message (updaters report success for a copy they did not touch).
 * `output` is the updater's stdout and stderr verbatim.
 */
export type UpgradeResult =
  | { readonly kind: "upgraded"; readonly from: string; readonly to: string; readonly output: string }
  /** The check found nothing newer, so no updater ran. */
  | { readonly kind: "current"; readonly version: string; readonly check: UpdateCheck }
  /** The updater ran and exited 0, yet the executable reports the same version. */
  | { readonly kind: "unchanged"; readonly version: string; readonly output: string }
  /** The updater failed (non-zero exit, timeout) and the version did not move. */
  | { readonly kind: "failed"; readonly exitCode: number | null; readonly output: string }
  | {
      readonly kind: "unsupported";
      readonly reason: "unsupported_installation" | "requires_terminal";
      readonly detail?: string;
    };

export interface UpgradeOptions {
  /** Bound for the updater run; downloads can take minutes. */
  readonly timeoutMs?: number;
}

/**
 * Runs the runtime's own updater, non-interactively, against this
 * installation. Changes the machine: oar never calls it on its own.
 */
export type Upgrader = (
  installation: AvailableInstallation,
  options?: UpgradeOptions,
) => Promise<UpgradeResult>;
