import { executableInstallation } from "../../shared/installation.js";

const DIM_VERSION = /^dimcode\s+(\d+\.\d+\.\d+(?:-[\dA-Za-z.-]+)?)$/u;

/** `dima --version` prints `dimcode <semver>` (0.1.0-alpha.29). */
export function readDimVersion(stdout: string): string | undefined {
  return DIM_VERSION.exec(stdout.trim())?.[1];
}

/**
 * The Rust CLI: `dima` from the `dimcode-alpha` npm package, else the
 * nightly's `dim-nightly` / `dimn`. The `dim` and `dimcode` commands of the
 * `dimcode` npm package are the earlier TypeScript CLI, which this adapter has
 * not been verified against, so they are not candidates. The help check
 * requires the `acp` command the sessions use.
 */
export const dimInstallation = executableInstallation(
  "OAR_DIM_BIN",
  "dima",
  ["dim-nightly", "dimn"],
  ["--help"],
  {
    readVersion: readDimVersion,
    identity: { vendor: "Dim", help: /^\s*acp \[--agent ID\]\s+Serve ACP over stdin\/stdout/mu, version: DIM_VERSION },
  },
);
