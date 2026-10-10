import type { AvailableInstallation } from "./installation.js";

/**
 * Why oar will not run a runtime's installer on this machine. The same
 * answer comes from `installPlan()` and from `install()`, which then runs
 * nothing.
 */
export type InstallUnsupportedReason =
  | "platform" // the vendor's installer does not run here, or oar does not run it on this OS (Windows)
  | "requires_privileges" // the installer would write where this user cannot; oar never uses sudo; carries `steps` and `source`
  | "requires_gui" // the vendor installs it only from inside an app (antigravity: an editor's agent registry)
  | "missing_tool" // the official method needs a tool (curl, bash, npm, ...) that is not on PATH; `detail` names it; carries `steps` and `source`
  | "bundled" // nothing to install: the runtime comes with the package that carries it
  | "line_required" // the runtime ships parallel release lines (`Runtime.installLines`) and no `line` was given; oar does not choose one
  | "unknown_line"; // `line` names none of the runtime's `installLines` (a runtime without lines takes none)

export interface InstallUnsupported {
  readonly kind: "unsupported";
  readonly reason: InstallUnsupportedReason;
  /** Plain words for a person: what is missing, or how the vendor installs it instead. */
  readonly detail?: string;
  /**
   * The steps the plan would have had, for a person to run themselves once
   * they have what is missing; oar runs none of them. Present only where oar
   * knows the vendor's step but will not run it here: `requires_privileges`
   * (the person runs it with the rights it needs) and `missing_tool` (after
   * installing the tool). Absent for every other reason.
   */
  readonly steps?: readonly InstallStep[];
  /** The vendor's page that documents `steps` (the plan's `source`); present with `steps`. */
  readonly source?: string;
}

/**
 * One of a runtime's parallel release lines: major versions its vendor ships
 * side by side as the same command, each with its own installer (opencode:
 * `v1` and `v2`). A copy of one line can replace a copy of the other.
 */
export interface InstallLine {
  /** The value for `InstallOptions.line`. */
  readonly line: string;
  /** What the line is, for a person choosing one. */
  readonly description: string;
}

/** One command the installer runs, spawned without a terminal and with stdin closed. */
export interface InstallStep {
  /** The program, then its arguments: exactly what `install()` spawns (on an `unsupported` answer, would have spawned). */
  readonly command: readonly string[];
  /**
   * The step as the vendor documents it, plus the installer's own declared
   * non-interactive switch where it has one (codex: `CODEX_NON_INTERACTIVE=1`,
   * from install.sh's usage text), for a person to read before pressing Install.
   */
  readonly display: string;
}

/**
 * What `install()` would run on this machine, read without running or
 * downloading anything. `source` is the vendor's page that documents the
 * method. Every plan downloads (`network`) and none needs elevated rights
 * (`privileges`): an installer that would is `requires_privileges` instead.
 */
export type InstallPlan =
  | {
      readonly kind: "plan";
      readonly steps: readonly InstallStep[];
      readonly source: string;
      readonly network: true;
      readonly privileges: false;
    }
  | InstallUnsupported;

/**
 * The outcome of running the runtime's own installer, judged by the
 * runtime's installation probe afterwards (the discovery sessions use),
 * never by the installer's exit code. `output` is the installer's stdout
 * and stderr verbatim.
 */
export type InstallResult =
  /** The probe now finds an available installation. `line`: its release line, for a runtime with `installLines`, when its version tells. */
  | { readonly kind: "installed"; readonly installation: AvailableInstallation; readonly line?: string; readonly output: string }
  /**
   * The probe found one before anything ran, so no installer ran, whichever
   * `line` was asked for: an install never replaces a copy of another line.
   */
  | { readonly kind: "already_installed"; readonly installation: AvailableInstallation; readonly line?: string }
  /** The probe after the installer still finds nothing; `exitCode` is the installer's (0 included), null when the timeout stopped it. */
  | { readonly kind: "failed"; readonly exitCode: number | null; readonly output: string }
  | InstallUnsupported;

export interface InstallOptions {
  /** Bound for the installer run; downloads can take minutes. */
  readonly timeoutMs?: number;
  /**
   * Which of the runtime's `installLines` to install. Required by a runtime
   * that declares lines (`line_required` without it: oar never chooses for
   * the person) and refused by one that does not (`unknown_line`).
   */
  readonly line?: string;
}

/** Read only: never runs, downloads or writes anything. */
export type InstallPlanner = (options?: InstallOptions) => Promise<InstallPlan>;

/**
 * Runs the runtime's own installer, non-interactively, when the runtime's
 * installation probe finds no available installation. Changes the machine:
 * oar never calls it on its own.
 */
export type Installer = (options?: InstallOptions) => Promise<InstallResult>;
