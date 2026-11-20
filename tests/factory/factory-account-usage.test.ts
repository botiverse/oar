import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingHttpHeaders } from "node:http";
import { once } from "node:events";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { errorChain, rejectionOf } from "../fixtures/error-chain.js";
import { decryptFactoryCredentials } from "../../packages/oar/src/runtimes/factory/account-credential.js";
import { factoryAccountUsage, projectFactoryUsage } from "../../packages/oar/src/runtimes/factory/account-usage.js";

const installation = { kind: "available" as const, via: "executable" as const, command: "/nonexistent/droid", version: "1.12.1" };
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map(async (step) => { await step(); })); });

const future = new Date(Date.now() + 3_600_000).toISOString();
const limits = {
  hasActiveSubscription: true,
  limits: {
    standard: { fiveHour: { usedPercent: 42, windowEnd: future }, weekly: { usedPercent: 100, windowEnd: future }, monthly: { usedPercent: 10, windowEnd: null } },
    core: { fiveHour: { usedPercent: 5, windowEnd: future }, weekly: { usedPercent: 0, windowEnd: null, unlimited: true }, monthly: { usedPercent: "x", windowEnd: future } },
  },
  extraUsageBalanceCents: 0, overagePreference: null, extraUsageAllowed: false,
};

/** droid's keyfile cipher, as its bundle writes it. */
function encrypt(text: string, key: Buffer): string {
  const iv = randomBytes(16);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(text, "utf8"), cipher.final()]);
  return `${iv.toString("base64")}:${cipher.getAuthTag().toString("base64")}:${data.toString("base64")}`;
}

async function provider(status = 200, payload: unknown = limits) {
  const seen: { url: string; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((request, response) => {
    seen.push({ url: request.url ?? "", headers: request.headers });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof payload === "string" ? payload : JSON.stringify(payload));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(async () => { server.close(); await once(server, "close"); });
  const address = server.address();
  if (address === null || typeof address === "string") { throw new Error("no port"); }
  return { url: `http://127.0.0.1:${String(address.port)}`, seen };
}

/** droid's home made explicit on every platform: HOME (POSIX), USERPROFILE (Windows), no override. */
function homeEnv(dir: string): Record<string, string | null> {
  return { HOME: dir, USERPROFILE: dir, FACTORY_HOME_OVERRIDE: null };
}

async function home(files: Readonly<Record<string, string>> = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-factory-usage-"));
  cleanup.push(async () => { await rm(dir, { recursive: true, force: true }); });
  await mkdir(path.join(dir, ".factory", "api-key-identity"), { recursive: true });
  await Promise.all(Object.entries(files).map(async ([name, text]) => { await writeFile(path.join(dir, ".factory", name), text); }));
  return dir;
}

async function storedLogin(credentials: Record<string, unknown>) {
  const key = randomBytes(32);
  return home({ "auth.v2.key": key.toString("base64"), "auth.v2.file": encrypt(JSON.stringify(credentials), key) });
}

it("reads droid's keyfile login and projects the windows droid's usage screen shows", async () => {
  const api = await provider();
  const dir = await storedLogin({ access_token: "stored-access", refresh_token: "stored-refresh", active_organization_id: "org_1", whoami: { region: "global" } });
  const read = await factoryAccountUsage(installation, { env: { ...homeEnv(dir), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: api.url } });
  expect(read).toMatchObject({ kind: "available", rateLimited: true });
  expect(read.kind === "available" ? read.windows : []).toEqual([
    { id: "standard.fiveHour", label: "5-hour", usedRatio: 0.42, resetsAt: future, durationMs: 18_000_000, scope: { kind: "account" } },
    { id: "standard.weekly", label: "Weekly", usedRatio: 1, resetsAt: future, durationMs: 604_800_000, scope: { kind: "account" } },
    { id: "standard.monthly", label: "Monthly", usedRatio: 0, scope: { kind: "account" } },
    { id: "core.fiveHour", label: "Droid Core 5-hour", usedRatio: 0.05, resetsAt: future, durationMs: 18_000_000, scope: { kind: "models", name: "Droid Core" } },
  ]);
  expect(api.seen).toHaveLength(1);
  expect(api.seen[0]).toMatchObject({ url: "/api/billing/limits", headers: { "authorization": "Bearer stored-access", "x-factory-org-id": "org_1", "x-factory-client": "cli", "x-client-version": "1.12.1" } });
});

it("an EU login goes to the EU API", async () => {
  const global = await provider();
  const eu = await provider();
  const dir = await storedLogin({ access_token: "eu-access", refresh_token: "r", region: "eu" });
  const env = { ...homeEnv(dir), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: global.url, FACTORY_API_BASE_URL_EU: eu.url };
  expect(await factoryAccountUsage(installation, { env })).toMatchObject({ kind: "available" });
  expect([global.seen.length, eu.seen.length]).toEqual([0, 1]);
});

it("FACTORY_API_KEY wins over a stored login and takes droid's cached region for that key", async () => {
  const global = await provider();
  const eu = await provider();
  const seed = JSON.stringify({ version: 2, apiBaseUrl: global.url, credentialId: createHash("sha256").update("fk-test-key").digest("hex"), routing: { region: "eu" } });
  const dir = await home({ "auth.v2.keyring": "x", "api-key-identity/seed.json": seed });
  const env = { ...homeEnv(dir), FACTORY_API_KEY: "fk-test-key", FACTORY_API_BASE_URL: global.url, FACTORY_API_BASE_URL_EU: eu.url };
  expect(await factoryAccountUsage(installation, { env })).toMatchObject({ kind: "available" });
  expect(eu.seen[0]?.headers).toMatchObject({ authorization: "Bearer fk-test-key" });
  expect(eu.seen[0]?.headers["x-factory-org-id"]).toBeUndefined();
});

it("a keyring login is unsupported, no login asks for sign-in, and nothing is sent for either", async () => {
  const api = await provider();
  const sealed = await home({ "auth.v2.keyring": "sealed" });
  expect(await factoryAccountUsage(installation, { env: { ...homeEnv(sealed), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: api.url } }))
    .toEqual({ kind: "unsupported", reason: "unsupported_auth_storage" });
  const empty = await home();
  expect(await factoryAccountUsage(installation, { env: { ...homeEnv(empty), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: api.url } }))
    .toEqual({ kind: "reauth_required", reason: "credentials_missing" });
  expect(api.seen).toHaveLength(0);
});

it("401 and 403 ask for sign-in, 404 is unsupported, other failures reject without the credential", async () => {
  const dir = await storedLogin({ access_token: "secret-access-token", refresh_token: "r" });
  const read = async (status: number, payload?: unknown) => {
    const api = await provider(status, payload);
    return factoryAccountUsage(installation, { env: { ...homeEnv(dir), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: api.url } });
  };
  expect(await read(401)).toEqual({ kind: "reauth_required", reason: "credentials_rejected" });
  expect(await read(403)).toEqual({ kind: "reauth_required", reason: "credentials_rejected" });
  expect(await read(404)).toEqual({ kind: "unsupported", reason: "endpoint_unavailable" });
  for (const [status, payload] of [[500, undefined], [200, "not json"], [200, { limits: {} }]] as const) {
    // oxlint-disable-next-line no-await-in-loop -- one failing read at a time.
    const rejected: unknown = await read(status, payload).then(() => null, (error: unknown) => error);
    expect(rejected).toBeInstanceOf(Error);
    const text = rejected instanceof Error ? `${rejected.message} ${String(rejected.cause)}` : "";
    expect(text).not.toContain("secret-access-token");
  }
});

it("a damaged keyfile rejects without its contents, and no subscription has no quota", async () => {
  const damaged = await home({ "auth.v2.key": randomBytes(32).toString("base64"), "auth.v2.file": "AAAA:BBBB:CCCC" });
  await expect(factoryAccountUsage(installation, { env: { ...homeEnv(damaged), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null } }))
    .rejects.toThrow(/Failed to read Factory account usage/u);
  const sealed = encrypt("{}", randomBytes(32));
  const otherKey = randomBytes(32);
  expect(() => decryptFactoryCredentials(sealed, otherKey)).toThrow(/could not be decrypted/u);
  expect(projectFactoryUsage({ hasActiveSubscription: false })).toEqual({ kind: "unsupported", reason: "quota_unavailable" });
  expect(projectFactoryUsage({ limits: { standard: { fiveHour: { usedPercent: 0, windowEnd: null, unlimited: true } } } })).toEqual({ kind: "available", rateLimited: false, windows: [] });
  expect(projectFactoryUsage({ ...limits, overagePreference: "extraUsage", extraUsageAllowed: true, extraUsageBalanceCents: 500 })).toMatchObject({ rateLimited: false });
  expect(projectFactoryUsage({ limits: { standard: { fiveHour: { usedPercent: 99.99999, windowEnd: "2099-01-01T00:00:00Z" } } } }))
    .toMatchObject({ rateLimited: false, windows: [{ usedRatio: 0.999999 }] });
});

it("a credential that cannot be a header value is refused before any request, without the credential in the error chain", async () => {
  const api = await provider();
  const keyHome = await home();
  const keyRead = factoryAccountUsage(installation, { env: { ...homeEnv(keyHome), FACTORY_API_KEY: "fk-SECRET-KEY\nX", FACTORY_API_BASE_URL: api.url } });
  const keyChain = errorChain(await rejectionOf(keyRead));
  const loginHome = await storedLogin({ access_token: "SECRET-TOKEN\u0007", refresh_token: "r" });
  const loginRead = factoryAccountUsage(installation, { env: { ...homeEnv(loginHome), FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: api.url } });
  const loginChain = errorChain(await rejectionOf(loginRead));
  expect(`${keyChain}${loginChain}`).not.toMatch(/SECRET/u);
  expect([keyChain, loginChain]).toEqual([expect.stringMatching(/not a valid HTTP header value/u), expect.stringMatching(/not a valid HTTP header value/u)]);
  expect(api.seen).toHaveLength(0);
});

it("FACTORY_HOME_OVERRIDE moves droid's directory, as droid itself reads it", async () => {
  const dir = await storedLogin({ access_token: "override-access", refresh_token: "r" });
  const api = await provider();
  const elsewhere = await home();
  expect(await factoryAccountUsage(installation, { env: { ...homeEnv(elsewhere), FACTORY_HOME_OVERRIDE: dir, FACTORY_API_KEY: null, FACTORY_DISABLE_KEYRING: null, FACTORY_API_BASE_URL: api.url } }))
    .toMatchObject({ kind: "available" });
  expect(api.seen[0]?.headers.authorization).toBe("Bearer override-access");
});
