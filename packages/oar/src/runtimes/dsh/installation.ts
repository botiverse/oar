import { executableInstallation } from "../../shared/installation.js";
import { DSH_MINIMUM_VERSION, dshVersionRefusal } from "./version.js";

/** `dsh` on PATH or `OAR_DSH_BIN`, verified against DeepSeek Harness `--help` and its prerelease-aware version floor. */
export const dshInstallation = executableInstallation(
  "OAR_DSH_BIN",
  "dsh",
  [],
  ["--help"],
  {
    identity: { vendor: "DeepSeek Harness (dsh)", help: /\bUsage:\s+dsh(?:\.exe)?\b|\bDeepSeek Harness\b/iu },
    versionPolicy: {
      label: "DSH",
      lines: [{ min: DSH_MINIMUM_VERSION }],
      required: DSH_MINIMUM_VERSION,
      formatReason: (_command, _installed, raw) => dshVersionRefusal(raw) ?? `DSH requires ${DSH_MINIMUM_VERSION} or later`,
    },
  },
);
