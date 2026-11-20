import { environmentHome } from "../../shared/environment-home.js";
import path from "node:path";
import { executableInstallation } from "../../shared/installation.js";

/** First verified worker release with the get_settings readback required on open. */
export const QODER_MINIMUM_VERSION = "1.1.78";

/** Verify Qoder CLI identity on `--help` (measured on 1.1.78) and enforce the stable version floor. */
export const qoderInstallation = executableInstallation(
  "OAR_QODER_BIN",
  "qodercli",
  (env) => [path.join(environmentHome(env), ".local", "bin", "qodercli")],
  ["--help"],
  {
    identity: { vendor: "Qoder CLI", help: /\bUsage:\s+qodercli(?:\.exe)?\b|\bQoder CLI\b/iu },
    versionPolicy: {
      label: "Qoder",
      lines: [{ min: QODER_MINIMUM_VERSION, stableOnly: true }],
      required: QODER_MINIMUM_VERSION,
      formatReason: (_command, _installed, raw) =>
        `Qoder requires a stable CLI ${QODER_MINIMUM_VERSION} or newer; this installation reports ${raw ?? "an unrecognized version"}`,
    },
  },
);
