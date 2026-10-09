/* oxlint-disable import/prefer-default-export -- Shared named helper. */
import type { SessionOptions } from "../contracts/session.js";
import { mcpCredentialValues } from "./mcp-servers.js";

const CREDENTIAL_SUFFIX = /(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|CREDENTIALS|COOKIE|PWD)$/iu;
const CREDENTIAL_NAMES = new Set(["PGPASSWORD"]);
const PATH_VALUE = /^(?:\/|~\/|[a-z]:\\)/iu;

/** Explicit session credentials only; runtime-native keys can be added after SDK resolution. */
export function sessionCredentialRedactor(options: SessionOptions): { add(this: void, value: string | undefined): void; redact(this: void, text: string): string } {
  const known = new Set(mcpCredentialValues(options.mcpServers ?? []));
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if ((CREDENTIAL_SUFFIX.test(name) || CREDENTIAL_NAMES.has(name.toUpperCase())) && typeof value === "string" && value.length >= 8 && !PATH_VALUE.test(value)) { known.add(value); }
  }
  let values = [...known].toSorted((left, right) => right.length - left.length);
  const redact = (text: string): string => values.reduce((result, value) => result.replaceAll(value, "[redacted]"), text);
  return {
    add(value) {
      if (value !== undefined && value.length > 0 && !known.has(value)) {
        known.add(value);
        values = [...known].toSorted((left, right) => right.length - left.length);
      }
    },
    redact,
  };
}
