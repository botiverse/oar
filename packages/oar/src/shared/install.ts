import { accessSync, constants, existsSync } from "node:fs";
import path from "node:path";
import type {
  InstallLine,
  InstallOptions,
  InstallPlan,
  InstallPlanner,
  InstallResult,
  InstallStep,
  InstallUnsupported,
  Installer,
} from "../contracts/install.js";
import type { AvailableInstallation, InstallationProbe, InstallationSnapshot } from "../contracts/installation.js";
import { isolatedOutput, resolveExecutable, runIsolated } from "./executable/index.js";
import { updaterEnv } from "./update.js";

const INSTALL_TIMEOUT_MS = 600_000;

/**
 * A vendor's documented `curl … | sh` installer for macOS and Linux. Every
 * built-in one installs per user, under the home directory, into the layout
 * the runtime's own updater recognizes.
 */
export interface ScriptInstallMethod {
  /** The vendor's page that documents the method: the plan's `source`. */
  readonly source: string;
  /** The command line as the vendor documents it (with its own non-interactive switch, if any), run by `sh -c`. */
  readonly line: string;
  /** The programs the line runs, which must be on PATH. */
  readonly tools: readonly string[];
  /** The directories the installer writes, honoring the installer's own location variables. */
  readonly writes: () => readonly string[];
  /** How the vendor installs on Windows, which oar does not run, as a sentence for the `platform` detail. */
  readonly windows: string;
}

/** An installer's location variable when it is set and not empty, otherwise its default. */
export function installDir(variable: string | undefined, fallback: string): string {
  return variable === undefined || variable === "" ? fallback : variable;
}

/** What a plan reads about this machine. */
export interface InstallHost {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  /** The tool's path on PATH, or null. */
  readonly locate: (tool: string) => string | null;
  /** The existing directory at or above `dir` that this user cannot write, or null when the installer could create `dir`. */
  readonly unwritable: (dir: string) => string | null;
}

function nearestExisting(dir: string): string {
  let current = path.resolve(dir);
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) {
      return current;
    }
    current = parent;
  }
  return current;
}

/** The nearest existing directory at or above `dir`, when this user cannot write it; null when `dir` can be created or written. */
export function unwritableAncestor(dir: string): string | null {
  const existing = nearestExisting(dir);
  try {
    accessSync(existing, constants.W_OK);
    return null;
  } catch {
    return existing;
  }
}

const thisMachine: InstallHost = {
  platform: process.platform,
  arch: process.arch,
  locate: (tool) => resolveExecutable(tool),
  unwritable: unwritableAncestor,
};

const SCRIPT_PLATFORMS: ReadonlySet<NodeJS.Platform> = new Set(["darwin", "linux"]);
const SCRIPT_ARCHES: ReadonlySet<string> = new Set(["x64", "arm64"]);

/**
 * The plan for a script installer on `host`: `platform` off macOS and Linux
 * (the vendors' Windows installers are PowerShell scripts oar has not
 * verified, so their command is only named), `missing_tool` when the line's
 * programs are not on PATH, `requires_privileges` when a directory it writes
 * is not this user's to write (an install location variable pointing at
 * `/usr/local`, say), which the installer would otherwise discover midway.
 */
export function scriptInstallPlanOn(method: ScriptInstallMethod, host: InstallHost): InstallPlan {
  if (!SCRIPT_PLATFORMS.has(host.platform)) {
    return {
      kind: "unsupported",
      reason: "platform",
      detail: host.platform === "win32"
        ? `oar runs this installer on macOS and Linux only. On Windows, ${method.windows}`
        : `the installer supports macOS and Linux, not ${host.platform}`,
    };
  }
  if (!SCRIPT_ARCHES.has(host.arch)) {
    return { kind: "unsupported", reason: "platform", detail: `the installer has no build for ${host.arch}` };
  }
  for (const tool of ["sh", ...method.tools]) {
    if (host.locate(tool) === null) {
      return { kind: "unsupported", reason: "missing_tool", detail: tool };
    }
  }
  for (const dir of method.writes()) {
    const blocked = host.unwritable(dir);
    if (blocked !== null) {
      return { kind: "unsupported", reason: "requires_privileges", detail: `the installer writes ${dir}, and ${blocked} is not writable by this user` };
    }
  }
  return {
    kind: "plan",
    steps: [{ command: ["sh", "-c", method.line], display: method.line }],
    source: method.source,
    network: true,
    privileges: false,
  };
}

/** A runtime with one release line: a `line` is refused, never ignored. */
export function scriptInstallPlan(method: ScriptInstallMethod, host: InstallHost = thisMachine): InstallPlanner {
  return async (options: InstallOptions = {}) => {
    await Promise.resolve();
    if (options.line !== undefined) {
      return { kind: "unsupported", reason: "unknown_line", detail: `this runtime ships one release line; leave line ${JSON.stringify(options.line)} out` };
    }
    return scriptInstallPlanOn(method, host);
  };
}

/** A runtime's parallel release lines, each with its own script installer. */
export interface LinedInstallMethods {
  readonly lines: readonly InstallLine[];
  readonly methods: Readonly<Record<string, ScriptInstallMethod>>;
}

/**
 * The plan for the line `options.line` names: `line_required` without one
 * (oar does not choose a line for the person), `unknown_line` for a line the
 * runtime does not ship.
 */
export function linedInstallPlan(lined: LinedInstallMethods, host: InstallHost = thisMachine): InstallPlanner {
  const names = lined.lines.map((entry) => entry.line).join(", ");
  return async (options: InstallOptions = {}) => {
    await Promise.resolve();
    if (options.line === undefined) {
      return { kind: "unsupported", reason: "line_required", detail: `choose a release line: ${names}` };
    }
    const method = Object.hasOwn(lined.methods, options.line) ? lined.methods[options.line] : undefined;
    if (method === undefined) {
      return { kind: "unsupported", reason: "unknown_line", detail: `${JSON.stringify(options.line)} is not one of ${names}` };
    }
    return scriptInstallPlanOn(method, host);
  };
}

/** A runtime whose vendor offers nothing oar can run: its plan and its install give this answer. */
export function unsupportedInstallPlan(unsupported: InstallUnsupported): InstallPlanner {
  return async () => {
    await Promise.resolve();
    return unsupported;
  };
}

interface StepsRun {
  readonly exitCode: number | null;
  readonly output: string;
}

/** Run the steps in order, without stdin or a terminal, stopping at the first that fails; one deadline bounds them all. */
async function runSteps(steps: readonly InstallStep[], timeoutMs: number): Promise<StepsRun> {
  const deadline = Date.now() + timeoutMs;
  let output = "";
  let exitCode: number | null = 0;
  for (const step of steps) {
    const [command, ...args] = step.command;
    if (command === undefined) {
      continue;
    }
    const run = await runIsolated(command, args, { env: updaterEnv(), timeoutMs: Math.max(deadline - Date.now(), 1) });
    output += isolatedOutput(run, timeoutMs, "installer");
    exitCode = run.exitCode;
    if (run.timedOut || exitCode !== 0) {
      break;
    }
  }
  return { exitCode, output };
}

async function probeAfter(probe: InstallationProbe): Promise<{ readonly snapshot?: InstallationSnapshot; readonly note: string }> {
  try {
    return { snapshot: await probe(), note: "" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { note: `\n[oar: the installation probe after the installer failed: ${message}]\n` };
  }
}

/** The release line an installation belongs to, read from its version; undefined when it does not tell. */
export type InstallLineOf = (installation: AvailableInstallation) => string | undefined;

function withLine(installation: AvailableInstallation, lineOf: InstallLineOf | undefined): { readonly installation: AvailableInstallation; readonly line?: string } {
  const line = lineOf?.(installation);
  return line === undefined ? { installation } : { installation, line };
}

/**
 * An installer from the runtime's installation probe and its plan. The
 * probe decides both ends: an installation it already finds means nothing
 * runs (`already_installed`, whichever line was asked for, so a copy of one
 * line is never replaced by another), and after the plan's steps ran, only
 * an available installation it finds is `installed`, whatever the installer
 * exited with: what the probe finds is what a session would run, and a copy
 * the installer put where the probe does not look is a probe to fix.
 * `lineOf` names the line of what the probe found, for a runtime with lines.
 */
export function planInstaller(probe: InstallationProbe, plan: InstallPlanner, lineOf?: InstallLineOf): Installer {
  return async (options: InstallOptions = {}): Promise<InstallResult> => {
    const before = await probe();
    if (before.kind === "available") {
      return { kind: "already_installed", ...withLine(before, lineOf) };
    }
    const planned = await plan(options);
    if (planned.kind === "unsupported") {
      return planned;
    }
    const run = await runSteps(planned.steps, options.timeoutMs ?? INSTALL_TIMEOUT_MS);
    const after = await probeAfter(probe);
    if (after.snapshot?.kind === "available") {
      return { kind: "installed", ...withLine(after.snapshot, lineOf), output: run.output };
    }
    return { kind: "failed", exitCode: run.exitCode, output: `${run.output}${after.note}` };
  };
}
