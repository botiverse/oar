import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { HostUnsupportedInstallation } from "../contracts/installation.js";
import { nodeEvalExecutable } from "./executable/node-eval.js";
import { compareSemver } from "./semver.js";

/** Observed properties of the current host process used by installation probes. */
export interface HostEnvironment {
  readonly platform: string;
  readonly arch: string;
  readonly nodeVersion: string;
  readonly electron: boolean;
  /** True when `process.execPath` is a compiled single executable (Node SEA or Bun standalone). */
  readonly compiledSingleExecutable: boolean;
  /** Resolve a module specifier, file URL or path to an existing on-disk path, or null when missing. */
  readonly resolveModule: (specifier: string) => string | null;
}

/** Declarative host-environment constraints checked before reporting a bundled or SDK runtime available. */
export interface HostEnvironmentRequirements {
  readonly platforms?: { readonly supported: ReadonlySet<string>; readonly label: string };
  readonly minNodeVersion?: { readonly version: string; readonly label: string };
  readonly forbidCompiledSingleExecutable?: { readonly reason: string };
  readonly forbidElectron?: { readonly reason: string };
  readonly requiredModule?: { readonly specifier: string; readonly reason: string };
}

/** Resolve a file URL, path or ESM specifier to an existing file on disk, or null when absent. */
export function resolveModuleFile(specifier: string): string | null {
  if (specifier.startsWith("file:")) {
    try {
      const file = fileURLToPath(specifier);
      return existsSync(file) ? file : null;
    } catch {
      return null;
    }
  }
  if (path.isAbsolute(specifier) || specifier.startsWith(".") || specifier.startsWith("..")) {
    return existsSync(specifier) ? specifier : null;
  }
  try {
    const resolved = import.meta.resolve(specifier);
    if (resolved.startsWith("file:")) {
      const file = fileURLToPath(resolved);
      return existsSync(file) ? file : null;
    }
    return resolved;
  } catch {
    return null;
  }
}

/** Live host-environment snapshot for this process. */
export function currentHostEnvironment(): HostEnvironment {
  return {
    platform: process.platform,
    arch: process.arch,
    nodeVersion: process.versions.node,
    electron: typeof process.versions.electron === "string" && process.versions.electron.length > 0,
    compiledSingleExecutable: nodeEvalExecutable() === null,
    resolveModule: resolveModuleFile,
  };
}

/** Check declarative host-environment requirements against `host`; returns null when every requirement passes. */
export function checkHostEnvironment(
  requirements: HostEnvironmentRequirements,
  host: HostEnvironment = currentHostEnvironment(),
): HostUnsupportedInstallation | null {
  if (requirements.platforms !== undefined) {
    const target = `${host.platform}-${host.arch}`;
    if (!requirements.platforms.supported.has(target)) {
      return { kind: "unsupported", code: "unsupported_platform", reason: `${requirements.platforms.label} has no native package for ${target}` };
    }
  }
  if (requirements.minNodeVersion !== undefined) {
    const order = compareSemver(host.nodeVersion, requirements.minNodeVersion.version);
    if (order === null || order < 0) {
      return {
        kind: "unsupported",
        code: "unsupported_node_version",
        reason: `${requirements.minNodeVersion.label} requires Node ${requirements.minNodeVersion.version} or newer; this host runs Node ${host.nodeVersion}`,
        installedVersion: host.nodeVersion,
        requiredVersion: requirements.minNodeVersion.version,
      };
    }
  }
  if (requirements.forbidCompiledSingleExecutable !== undefined && host.compiledSingleExecutable) {
    return { kind: "unsupported", code: "unsupported_host", reason: requirements.forbidCompiledSingleExecutable.reason };
  }
  if (requirements.forbidElectron !== undefined && host.electron) {
    return { kind: "unsupported", code: "unsupported_host", reason: requirements.forbidElectron.reason };
  }
  if (requirements.requiredModule !== undefined && host.resolveModule(requirements.requiredModule.specifier) === null) {
    return { kind: "unsupported", code: "dependency_missing", reason: requirements.requiredModule.reason };
  }
  return null;
}
