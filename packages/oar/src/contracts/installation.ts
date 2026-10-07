/** A verified machine-installed executable: the probed command and its reported version. */
export interface ExecutableInstallation {
  readonly kind: "available";
  readonly via: "executable";
  readonly command: string;
  readonly version?: string;
  /**
   * The other copies of the same command on PATH after `command`, in PATH
   * order: copies that never run while this one is first. Only copies on
   * PATH: one installed off PATH (an npm prefix PATH does not list) is not
   * among them. Paths as PATH lists them, without versions (the host can ask
   * each copy for one). Entries that resolve to one file are one copy (a
   * folder listed twice, `/bin` beside `/usr/bin`, a symlink to `command`),
   * and a folder holds one copy, the one the shell would pick there. Present
   * only when PATH found `command` and lists other copies: never when an
   * `OAR_*_BIN` override names the executable or a fallback outside PATH
   * found it (codex's macOS app bundle).
   */
  readonly shadowed?: readonly string[];
}

/**
 * A runtime compiled into the embedding application; availability needs no
 * probe target. Deliberately versionless: the embedder pins the sdk version,
 * so unlike an uncontrolled machine-installed CLI there is nothing to advise
 * the user to upgrade.
 */
export interface BundledInstallation {
  readonly kind: "available";
  readonly via: "bundled";
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
