import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { resolveExecutable } from "../../shared/executable/index.js";
import { currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { npmGlobalBin, npmGlobalPrefix } from "../../shared/install-npm.js";
import { executableInstallation, type ExecutableInstallationOptions } from "../../shared/installation.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { BOTTEGA_MINIMUM_VERSION } from "./version.js";

/** The package OAR carries as an optional dependency: bottega's command line, bundled for Node. */
export const BOTTEGA_PACKAGE = "@botiverse/bottega";

const BOTTEGA_EXECUTABLE_OPTIONS: ExecutableInstallationOptions = {
  identity: { vendor: "bottega", help: /^bottega — /mu },
  versionPolicy: {
    label: "bottega",
    lines: [{ min: BOTTEGA_MINIMUM_VERSION }],
    required: BOTTEGA_MINIMUM_VERSION,
    formatReason: (_command, installed) =>
      `bottega serve at protocol 1 needs bottega ${BOTTEGA_MINIMUM_VERSION} or later; the selected bottega reports ${installed ?? "no readable version"}`,
  },
};

/** `bottega` on PATH or the one `OAR_BOTTEGA_BIN` pins (a launcher that runs it elsewhere, a container, is pinned the same way). */
const executableBottega = executableInstallation("OAR_BOTTEGA_BIN", "bottega", [], ["--help"], BOTTEGA_EXECUTABLE_OPTIONS);

async function probeNpmGlobalBottega(probe: Parameters<InstallationProbe>[0]): Promise<InstallationSnapshot> {
  const env = sessionEnvironment(probe?.env);
  const npm = resolveExecutable("npm", env);
  if (npm === null) { return { kind: "not_found" }; }
  const prefix = await npmGlobalPrefix(npm, env).catch((): null => null);
  if (prefix === null) { return { kind: "not_found" }; }
  const command = path.join(npmGlobalBin(prefix), process.platform === "win32" ? "bottega.cmd" : "bottega");
  return executableInstallation("", command, [], ["--help"], BOTTEGA_EXECUTABLE_OPTIONS)(probe);
}

/** The command line of the bottega package the host has, found without loading it; null when it has none. */
export function bundledBottegaCli(host: Pick<HostEnvironment, "resolveModule"> = currentHostEnvironment()): string | null {
  const manifest = host.resolveModule(`${BOTTEGA_PACKAGE}/package.json`);
  if (manifest === null || !path.isAbsolute(manifest)) { return null; }
  try {
    const bin = asRecord(parseJson(readFileSync(manifest, "utf8")))?.bin;
    const entry = typeof bin === "string" ? bin : asRecord(bin)?.bottega;
    if (typeof entry !== "string") { return null; }
    const cli = path.join(path.dirname(manifest), entry);
    return existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

/**
 * Where bottega runs from, in this order:
 * - `OAR_BOTTEGA_BIN`, when set: that executable alone, `via: "executable"`;
 * - the optional dependency `@botiverse/bottega`, run by this Node
 *   (`process.execPath`), `via: "bundled"`. A single-file or Electron host
 *   has no Node to run it with, so bundled resolution is skipped there;
 * - `bottega` on PATH, or in npm's configured global bin directory (`npm prefix -g`),
 *   `via: "executable"`, at bottega 0.3.0 or later (otherwise `not_found`).
 */
export function bottegaInstallationFor(hostOverride?: Partial<HostEnvironment>): InstallationProbe {
  return async (probe = {}): Promise<InstallationSnapshot> => {
    const pinned = environmentValue(sessionEnvironment(probe.env), "OAR_BOTTEGA_BIN");
    if (pinned !== undefined && pinned !== "") { return executableBottega(probe); }
    const host: HostEnvironment = { ...currentHostEnvironment(), ...hostOverride };
    if (!host.compiledSingleExecutable && !host.electron && bundledBottegaCli(host) !== null) {
      return { kind: "available", via: "bundled" };
    }
    const found = await executableBottega(probe);
    if (found.kind !== "not_found") { return found; }
    return probeNpmGlobalBottega(probe);
  };
}

export const bottegaInstallation: InstallationProbe = bottegaInstallationFor();
