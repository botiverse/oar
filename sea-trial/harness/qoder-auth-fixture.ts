import { createCipheriv } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Synthetic local identity for the daemon's auth gate, never a vendor credential.
 * Native credential_storage_encrypt uses AES-128-CBC with the first 16 machine
 * id bytes as both key and IV. The real CLI reads this fixture unchanged;
 * inference still uses its --fake-responses reader and spends no quota.
 */
export async function seedQoderReplayIdentity(home: string): Promise<void> {
  const directory = path.join(home, ".qoder", ".auth");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const machine = "0123456789abcdef0123456789abcdef";
  const key = Buffer.from(machine.slice(0, 16));
  const cipher = createCipheriv("aes-128-cbc", key, key);
  const user = { uid: "oar-native-fixture", name: "synthetic", access_token: "synthetic-oar-token",
    security_oauth_token: "synthetic-oar-token", expire_time: Math.floor(Date.now() / 1000) + 3600,
    login_timestamp: Date.now(), login_method: "browser" };
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(user)), cipher.final()]).toString("base64");
  await writeFile(path.join(directory, "machine_id"), machine, { mode: 0o600 });
  await writeFile(path.join(directory, "user"), encrypted, { mode: 0o600 });
}
