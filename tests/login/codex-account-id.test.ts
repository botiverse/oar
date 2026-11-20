import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { readCodexAccountId } from "../../packages/oar/src/runtimes/codex/account-id.js";
import { codexAuthStatus, codexLogin } from "../../packages/oar/src/runtimes/codex/login.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

let directory = "";
beforeEach(async () => {
  directory = await mkdtemp(path.join(tmpdir(), "oar-codex-account-id-"));
});
afterEach(async () => {
  await rm(directory, { recursive: true, force: true });
});

function fakeIdToken(email: string, accountId?: string): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const claims = accountId === undefined ? { email } : { email, "https://api.openai.com/auth": { chatgpt_account_id: accountId } };
  return `${header}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.sig`;
}

async function writeCodexHome(dir: string, auth: unknown, configToml?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), typeof auth === "string" ? auth : JSON.stringify(auth));
  if (configToml !== undefined) {
    await writeFile(path.join(dir, "config.toml"), configToml);
  }
}

test("readCodexAccountId reads tokens.account_id from CODEX_HOME or HOME/.codex in file mode", async () => {
  const codexHome = path.join(directory, "codex-home");
  const homeDir = path.join(directory, "home");
  await writeCodexHome(codexHome, {
    auth_mode: "chatgpt",
    tokens: { access_token: "secret-access", id_token: fakeIdToken("alice@example.test", "acct_codex_123"), account_id: "acct_codex_123" },
  }, 'cli_auth_credentials_store = "file"\n');
  await writeCodexHome(path.join(homeDir, ".codex"), {
    auth_mode: "chatgpt",
    tokens: { id_token: fakeIdToken("alice@example.test", "acct_home_456"), account_id: "acct_home_456" },
  });

  expect(await readCodexAccountId({ CODEX_HOME: codexHome, HOME: homeDir }, { email: "ALICE@example.test" })).toBe("acct_codex_123");
  expect(await readCodexAccountId({ HOME: homeDir, USERPROFILE: homeDir })).toBe("acct_home_456");
});

test("readCodexAccountId fails closed for stale auth.json when config uses keyring, auto or ephemeral storage", async () => {
  const validAuth = { auth_mode: "chatgpt", tokens: { id_token: fakeIdToken("alice@example.test", "acct_stale"), account_id: "acct_stale" } };
  const configs: readonly [string, string][] = [
    ["keyring", 'cli_auth_credentials_store = "keyring"\n'],
    ["auto", 'cli_auth_credentials_store = "auto"\n'],
    ["ephemeral", 'cli_auth_credentials_store = "ephemeral"\n'],
    ["profile", '[profiles.work]\ncli_auth_credentials_store = "keyring"\n'],
  ];
  await Promise.all(configs.map(async ([name, toml]) => writeCodexHome(path.join(directory, name), validAuth, toml)));
  const results = await Promise.all(configs.map(async ([name]) => readCodexAccountId({ CODEX_HOME: path.join(directory, name) })));
  expect(results).toEqual([undefined, undefined, undefined, undefined]);
});

test("readCodexAccountId rejects email mismatch, non-chatgpt auth_mode, claim mismatch and corrupt/oversized files", async () => {
  const cases: readonly [string, unknown, string | undefined][] = [
    ["email-mismatch", { auth_mode: "chatgpt", tokens: { id_token: fakeIdToken("stale@example.test", "acct_1"), account_id: "acct_1" } }, "live@example.test"],
    ["no-id-token", { auth_mode: "chatgpt", tokens: { account_id: "acct_2" } }, "live@example.test"],
    ["claim-mismatch", { auth_mode: "chatgpt", tokens: { id_token: fakeIdToken("live@example.test", "acct_other"), account_id: "acct_3" } }, "live@example.test"],
    ["apikey-mode", { auth_mode: "apikey", tokens: { id_token: fakeIdToken("live@example.test", "acct_4"), account_id: "acct_4" } }, undefined],
    ["corrupt", "{not json", undefined],
    ["empty", { tokens: { account_id: "   " } }, undefined],
    ["big", JSON.stringify({ tokens: { account_id: "acct_big", pad: "x".repeat(1_050_000) } }), undefined],
  ];
  await Promise.all(cases.map(async ([name, payload]) => writeCodexHome(path.join(directory, name), payload)));
  const results = await Promise.all(cases.map(async ([name, , email]) => readCodexAccountId({ CODEX_HOME: path.join(directory, name) }, email === undefined ? undefined : { email })));
  expect(results).toEqual(cases.map(() => undefined));
  expect(await readCodexAccountId({ CODEX_HOME: path.join(directory, "missing") })).toBeUndefined();
});

test("codexAuthStatus and codexLogin attach matched accountId and omit stale auth.json", async () => {
  const matchedHome = path.join(directory, "matched");
  const staleHome = path.join(directory, "stale");
  await Promise.all([
    writeCodexHome(matchedHome, { auth_mode: "chatgpt", tokens: { access_token: "secret-should-not-appear", id_token: fakeIdToken("user@example.com", "acct_live_789"), account_id: "acct_live_789" } }),
    writeCodexHome(staleHome, { auth_mode: "chatgpt", tokens: { id_token: fakeIdToken("old@example.com", "acct_old_999"), account_id: "acct_old_999" } }),
  ]);
  const fake = fakeLoginCli({ dir: directory, name: "codex-account-id", script: "fake-codex-login.mjs", state: { version: "0.160.0", email: "user@example.com", loggedIn: true, mode: "success" } });
  const installation = { kind: "available" as const, via: "executable" as const, command: fake.command, version: "codex-cli 0.160.0" };
  const status = await codexAuthStatus(installation, { env: { CODEX_HOME: matchedHome } });
  expect(status).toEqual({ kind: "logged_in", source: "codex login status", account: { credential: "account", metering: "plan", method: "chatgpt", accountId: "acct_live_789" } });
  expect(JSON.stringify(status)).not.toContain("secret-should-not-appear");
  expect(await codexLogin(installation, recordedInteraction([]), { env: { CODEX_HOME: matchedHome } })).toEqual({
    kind: "logged_in", account: { credential: "account", metering: "plan", method: "chatgpt", email: "user@example.com", plan: "plus", accountId: "acct_live_789" },
  });
  expect(await codexLogin(installation, recordedInteraction([]), { env: { CODEX_HOME: staleHome } })).toEqual({
    kind: "logged_in", account: { credential: "account", metering: "plan", method: "chatgpt", email: "user@example.com", plan: "plus" },
  });
});
