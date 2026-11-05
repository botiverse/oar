import { inspect } from "node:util";
import { afterEach, expect, test, vi } from "vitest";
import { storedKimiAccessToken } from "../../packages/oar/src/runtimes/kimi/oauth-token.js";

const readFile = vi.hoisted(() => vi.fn<() => Promise<string>>());
vi.mock("node:fs/promises", () => ({ readFile }));
const auth = { credentialPath: "/synthetic/credential.json", home: "/synthetic", storage: "file", storageName: "synthetic", baseUrl: "http://127.0.0.1", oauthHost: "http://127.0.0.1" } as const;
const secret = "synthetic-private-credential";
afterEach(() => { readFile.mockReset(); });

test("only an absent credential file is a missing login", async () => {
  readFile.mockRejectedValue(Object.assign(new Error(secret), { code: "ENOENT" }));
  await expect(storedKimiAccessToken(auth)).rejects.toMatchObject({ name: "KimiReauthError", message: "No Kimi OAuth token is stored" });
});

test.each(["EACCES", "EIO", "EISDIR", "EMFILE"])("credential %s retains a safe operational reason", async (code) => {
  readFile.mockRejectedValue(Object.assign(new Error(secret), { code, path: secret }));
  const outcome = await storedKimiAccessToken(auth).catch((error: unknown) => error);
  expect(outcome).toMatchObject({ name: "Error", message: `Kimi OAuth credential file could not be read (${code})` });
  expect(inspect(outcome)).not.toContain(secret);
});

test.each([`{"access_token":"${secret}",`, "null", "{}", '{"access_token":false}', '{"access_token":""}'])("damaged credential content is a safe failure (%#)", async (raw) => {
  readFile.mockResolvedValue(raw);
  const outcome = await storedKimiAccessToken(auth).catch((error: unknown) => error);
  expect(outcome).toMatchObject({ name: "Error" });
  expect(outcome).not.toHaveProperty("name", "KimiReauthError");
  expect(inspect(outcome)).not.toContain(secret);
});

test("a valid persisted token is read without being rewritten", async () => {
  readFile.mockResolvedValue(JSON.stringify({ access_token: secret }));
  expect(await storedKimiAccessToken(auth)).toBe(secret);
});
test("an unknown I/O error does not expose arbitrary messages or codes", async () => {
  readFile.mockRejectedValue(Object.assign(new Error(secret), { code: secret }));
  const outcome = await storedKimiAccessToken(auth).catch((error: unknown) => error);
  expect(outcome).toMatchObject({ message: "Kimi OAuth credential file could not be read (unknown I/O error)" });
  expect(inspect(outcome)).not.toContain(secret);
});
