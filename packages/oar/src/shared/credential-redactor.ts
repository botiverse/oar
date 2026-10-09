/* oxlint-disable import/prefer-default-export -- Shared named helper. */
import type { SessionOptions } from "../contracts/session.js";
import { redactText } from "./redact-text.js";
import { mcpCredentialValues } from "./mcp-servers.js";

const CREDENTIAL_SUFFIX = /(?:^|_)(?:KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|PASSPHRASE|CREDENTIAL|CREDENTIALS|COOKIE|PWD)$/iu;
const CREDENTIAL_NAMES = new Set(["PGPASSWORD"]);
const PATH_VALUE = /^(?:\/|~\/|[a-z]:\\)/iu;

function credentialValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length >= 8 && !PATH_VALUE.test(value);
}

export interface CredentialRedactor {
  add(this: void, value: string | undefined): void;
  redact(this: void, text: string): string;
  redactValue<T>(this: void, value: T): T;
}

/** Explicit session credentials only; runtime-native keys can be added after SDK resolution. */
export function sessionCredentialRedactor(options: SessionOptions): CredentialRedactor {
  const known = new Set(mcpCredentialValues(options.mcpServers ?? []));
  for (const [name, value] of Object.entries(options.env ?? {})) {
    if ((CREDENTIAL_SUFFIX.test(name) || CREDENTIAL_NAMES.has(name.toUpperCase())) && credentialValue(value)) { known.add(value); }
  }
  let values = [...known].toSorted((left, right) => right.length - left.length);
  const redact = (text: string): string => values.reduce((result, value) => result.replaceAll(value, "[redacted]"), text);
  return {
    add(value) {
      if (credentialValue(value) && !known.has(value)) {
        known.add(value);
        values = [...known].toSorted((left, right) => right.length - left.length);
      }
    },
    redact,
    // Most records contain no credentials. Avoid traversing at all without known
    // values, and preserve the original object when the scan finds no match.
    redactValue: (value) => values.length === 0 ? value : redactText(value, redact, (text) => values.some((knownValue) => text.includes(knownValue))),
  };
}
