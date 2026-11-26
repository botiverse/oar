/** The release text both `hermes --version` and `hermes-acp --version` lead with. */
const HERMES_VERSION = /(?:^|\s)v?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)(?:\+\S+)?(?:\s|$)/u;

/** `hermes --version` prints `Hermes Agent v0.23.3+1139.g084538c (2026.9.24) · …`; the ACP entry prints just the version+metadata. */
export function readHermesVersion(stdout: string): string | undefined {
  const line = stdout.trim().split(/\r?\n/u)[0];
  return line === undefined ? undefined : HERMES_VERSION.exec(line)?.[1];
}

export const hermesVersionPattern = HERMES_VERSION;
