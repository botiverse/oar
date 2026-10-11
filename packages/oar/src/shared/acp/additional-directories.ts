import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session.js";
import { resolvedAdditionalDirectories } from "../additional-directories.js";
import { asRecord, type JsonRecord } from "../json.js";

/** Only the advertised ACP extension may receive directory parameters. */
export function acpAdditionalDirectories(options: SessionOptions, initialized: JsonRecord): JsonRecord {
  const directories = resolvedAdditionalDirectories(options);
  if (directories.length === 0) { return {}; }
  const capability = asRecord(asRecord(initialized.agentCapabilities)?.sessionCapabilities)?.additionalDirectories;
  if (capability !== true && asRecord(capability) === null) {
    throw new UnsupportedOptionError("additionalDirectories", "ACP runtime declares no sessionCapabilities.additionalDirectories, so the requested directories cannot be applied");
  }
  return { additionalDirectories: directories };
}
