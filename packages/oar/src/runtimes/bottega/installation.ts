import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { InstallationProbe, InstallationSnapshot } from "../../contracts/installation.js";
import { environmentValue, sessionEnvironment } from "../../shared/environment.js";
import { checkHostEnvironment, currentHostEnvironment, type HostEnvironment } from "../../shared/host-environment.js";
import { executableInstallation } from "../../shared/installation.js";
import { asRecord, parseJson } from "../../shared/json.js";
import { BOTTEGA_MINIMUM_VERSION } from "./version.js";

/** The package OAR carries as an optional dependency: bottega's command line, bundled for Node. */
export const BOTTEGA_PACKAGE = "@botiverse/bottega";

/** `bottega` on PATH or the one `OAR_BOTTEGA_BIN` pins (a launcher that runs it elsewhere, a container, is pinned the same way). */
const executableBottega = executableInstallation("OAR_BOTTEGA_BIN", "bottega", [], ["--help"], {
  identity: { vendor: "bottega", help: /^bottega — /mu },
  versionPolicy: {
    label: "bottega",
    lines: [{ min: BOTTEGA_MINIMUM_VERSION }],
    required: BOTTEGA_MINIMUM_VERSION,
    formatReason: (_command, installed) =>
      `bottega serve at protocol 1 needs bottega ${BOTTEGA_MINIMUM_VERSION} or later; the selected bottega reports ${installed ?? "no readable version"}`,
  },
});

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
 *   has no Node to run it with, so there it is skipped;
 * - `bottega` on PATH, `via: "executable"`, at bottega 0.3.0 or later.
 */
export function bottegaInstallationFor(hostOverride?: Partial<HostEnvironment>): InstallationProbe {
  return async (probe = {}): Promise<InstallationSnapshot> => {
    const pinned = environmentValue(sessionEnvironment(probe.env), "OAR_BOTTEGA_BIN");
    if (pinned !== undefined && pinned !== "") { return executableBottega(probe); }
    const host: HostEnvironment = { ...currentHostEnvironment(), ...hostOverride };
    const refusal = checkHostEnvironment({
      forbidCompiledSingleExecutable: { reason: "A single-file host has no Node to run the bundled bottega with; install bottega on PATH or set OAR_BOTTEGA_BIN." },
      forbidElectron: { reason: "An Electron host has no Node to run the bundled bottega with; install bottega on PATH or set OAR_BOTTEGA_BIN." },
    }, host);
    if (refusal === null && bundledBottegaCli(host) !== null) { return { kind: "available", via: "bundled" }; }
    const found = await executableBottega(probe);
    return found.kind === "not_found" && refusal !== null ? refusal : found;
  };
}

export const bottegaInstallation: InstallationProbe = bottegaInstallationFor();
