import { createDecipheriv, createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { getSystemErrorMap } from "node:util";
import type { AccountUsageSnapshot } from "../../contracts/account-usage.js";
import { environmentValue } from "../../shared/environment.js";
import { environmentHome } from "../../shared/environment-home.js";
import { asRecord, parseJson } from "../../shared/json.js";

/*
 * The credential droid itself would send, read as stored and never refreshed
 * or written (droid 1.12.1 bundle): `FACTORY_API_KEY` when set; else droid's
 * "keyfile" login, `~/.factory/auth.v2.file` encrypted with
 * `~/.factory/auth.v2.key`. A login sealed with an OS keyring key
 * (`auth.v2.keyring`, `auth.v2.loginkeychain`) is not readable here.
 */
export type FactoryCredential =
  | { readonly kind: "credential"; readonly token: string; readonly region: string | null; readonly organizationId: string | null }
  | { readonly kind: "snapshot"; readonly snapshot: AccountUsageSnapshot };

const systemErrorCodes = new Set([...getSystemErrorMap().values()].map(([code]) => code));

async function readText(file: string, what: string): Promise<string | null> {
  try { return await readFile(file, "utf8"); }
  catch (error) {
    const code = asRecord(error)?.code;
    if (code === "ENOENT") { return null; }
    // Native errors carry a path; keep only the system error code.
    // oxlint-disable-next-line preserve-caught-error -- The native cause can expose the credential path.
    throw new Error(`${what} could not be read (${typeof code === "string" && systemErrorCodes.has(code) ? code : "unknown I/O error"})`);
  }
}

/** droid's keyfile cipher: `base64(iv):base64(tag):base64(ciphertext)`, AES-256-GCM, 16-byte IV and tag. */
export function decryptFactoryCredentials(ciphertext: string, key: Buffer): string {
  const parts = ciphertext.trim().split(":");
  const [iv, tag, data] = parts.map(part => Buffer.from(part, "base64"));
  if (parts.length !== 3 || iv?.length !== 16 || tag?.length !== 16 || data === undefined || key.length !== 32) {
    throw new Error("droid's stored login is not in its keyfile format");
  }
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
  } catch {
    // The cause would be a crypto error about the stored bytes; it says nothing more useful.
    throw new Error("droid's stored login could not be decrypted with its key file");
  }
}

function enabled(value: string | undefined): boolean {
  return value !== undefined && value.trim() !== "" && !["0", "false"].includes(value.trim().toLowerCase());
}

/** The region droid cached for this API key (`api-key-identity/seed.json`), when it is for this key and API. */
async function apiKeyRegion(directory: string, key: string, api: string): Promise<string | null> {
  const file = path.join(directory, "api-key-identity", "seed.json");
  const text = await readText(file, "droid's API key identity cache").catch(() => null);
  const seed = asRecord(parseJson(text ?? ""));
  const credentialId = createHash("sha256").update(key).digest("hex");
  if (seed?.version !== 2 || seed.credentialId !== credentialId || seed.apiBaseUrl !== api) { return null; }
  const region = asRecord(seed.routing)?.region;
  return typeof region === "string" ? region : null;
}

export async function factoryCredential(env: NodeJS.ProcessEnv, api: string): Promise<FactoryCredential> {
  const directory = path.join(environmentHome(env), ".factory");
  const key = environmentValue(env, "FACTORY_API_KEY")?.trim();
  if (key !== undefined && key !== "") {
    return { kind: "credential", token: key, region: await apiKeyRegion(directory, key, api), organizationId: null };
  }
  const sealed = ["auth.v2.keyring", "auth.v2.loginkeychain"].map(file => path.join(directory, file));
  if (!enabled(environmentValue(env, "FACTORY_DISABLE_KEYRING")) && sealed.some(file => existsSync(file))) {
    return { kind: "snapshot", snapshot: { kind: "unsupported", reason: "unsupported_auth_storage" } };
  }
  const stored = await readText(path.join(directory, "auth.v2.file"), "droid's stored login");
  const keyText = stored === null ? null : await readText(path.join(directory, "auth.v2.key"), "droid's login key file");
  if (stored === null || keyText === null) { return { kind: "snapshot", snapshot: { kind: "reauth_required", reason: "credentials_missing" } }; }
  const plain = decryptFactoryCredentials(stored, Buffer.from(keyText.trim(), "base64"));
  const credentials = asRecord(parseJson(plain));
  const token = typeof credentials?.access_token === "string" ? credentials.access_token.trim() : "";
  if (token === "") { throw new Error("droid's stored login has no usable access_token"); }
  const routed = asRecord(credentials?.whoami)?.region ?? credentials?.region;
  const organization = typeof credentials?.active_organization_id === "string" ? credentials.active_organization_id.trim() : "";
  return { kind: "credential", token, region: typeof routed === "string" ? routed : null, organizationId: organization === "" ? null : organization };
}
