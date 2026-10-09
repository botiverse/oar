/* oxlint-disable import/prefer-default-export -- Shared named helper. */
import type { SessionOptions } from "../contracts/session.js";
import { redactText } from "./redact-text.js";

const CREDENTIAL_WORDS = new Set(["KEY", "APIKEY", "TOKEN", "SECRET", "PASSWORD", "PASSWD", "PASSPHRASE", "CREDENTIAL", "CREDENTIALS", "COOKIE", "PWD"]);
const AUTH_HEADERS = new Set(["AUTHORIZATION", "PROXY-AUTHORIZATION"]);
const CREDENTIAL_NAMES = new Set(["PGPASSWORD"]);
const CREDENTIAL_MIN_LENGTH = 8;
const PATH_VALUE = /^(?:\/|~\/|[a-z]:\\)/iu;

function credentialValue(value: string | null | undefined): value is string {
  return typeof value === "string" && value.length >= CREDENTIAL_MIN_LENGTH && !PATH_VALUE.test(value);
}

/** A connection string proves its password is a credential, regardless of the env name. */
function urlCredentials(value: string | null | undefined): readonly string[] {
  if (typeof value !== "string" || !/^[a-z][a-z\d+.-]*:\/\//iu.test(value) || !URL.canParse(value)) { return []; }
  const parsed = new URL(value);
  if (parsed.password === "") { return []; }
  const passwords = [parsed.password];
  try { passwords.push(decodeURIComponent(parsed.password)); } catch { /* Malformed percent escapes still leave the encoded password protected. */ }
  return [value, ...passwords.filter((password) => password.length >= CREDENTIAL_MIN_LENGTH)];
}

export interface CredentialRedactor {
  add(this: void, value: string | undefined): void;
  redact(this: void, text: string): string;
  redactValue<T>(this: void, value: T): T;
}

/** Explicit session credentials only; runtime-native keys can be added after SDK resolution. */
export function sessionCredentialRedactor(options: Partial<SessionOptions>): CredentialRedactor {
  const known = new Set<string>();
  const add = (value: string | null | undefined): void => { if (credentialValue(value)) { known.add(value); } };
  const env = (entries: SessionOptions["env"]): void => {
    for (const [name, value] of Object.entries(entries ?? {})) {
      const upper = name.toUpperCase();
      if (CREDENTIAL_WORDS.has(upper.split("_").at(-1) ?? "") || CREDENTIAL_NAMES.has(upper)) { add(value); }
      for (const credential of urlCredentials(value)) { known.add(credential); }
    }
  };
  env(options.env);
  for (const server of options.mcpServers ?? []) {
    if (!("type" in server)) { env(server.env); continue; }
    for (const [name, value] of Object.entries(server.headers ?? {})) {
      const upper = name.toUpperCase();
      const authorization = AUTH_HEADERS.has(upper);
      if (authorization || CREDENTIAL_WORDS.has(upper.split("-").at(-1) ?? "")) { add(value); }
      if (authorization) { add(/^\s*\S+\s+(.+?)\s*$/u.exec(value)?.[1]); }
    }
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
