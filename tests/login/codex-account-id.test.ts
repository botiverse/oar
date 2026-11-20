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

async function writeCodexAuth(dir: string, payload: unknown): Promise<void> {
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, "auth.json"), typeof payload === "string" ? payload : JSON.stringify(payload));
}

test("readCodexAccountId reads tokens.account_id from CODEX_HOME or HOME/.codex without exposing tokens", async () => {
  const codexHome = path.join(directory, "codex-home");
  const homeDir = path.join(directory, "home");
  await writeCodexAuth(codexHome, {
    auth_mode: "chatgpt",
    tokens: { access_token: "secret-access-token", refresh_token: "secret-refresh-token", account_id: "acct_codex_123" },
  });
  await writeCodexAuth(path.join(homeDir, ".codex"), {
    tokens: { account_id: "acct_home_456" },
  });

  expect(await readCodexAccountId({ CODEX_HOME: codexHome, HOME: homeDir })).toBe("acct_codex_123");
  expect(await readCodexAccountId({ HOME: homeDir, USERPROFILE: homeDir })).toBe("acct_home_456");
});

test("readCodexAccountId returns undefined for missing, corrupt, empty or oversized files", async () => {
  const cases: readonly [string, unknown][] = [
    ["corrupt", "{not json"],
    ["empty", { tokens: { account_id: "   " } }],
    ["big", JSON.stringify({ tokens: { account_id: "acct_big", pad: "x".repeat(1_050_000) } })],
  ];
  await Promise.all(cases.map(async ([name, payload]) => writeCodexAuth(path.join(directory, name), payload)));
  const names = ["missing", "corrupt", "empty", "big"];
  const results = await Promise.all(names.map(async name => readCodexAccountId({ CODEX_HOME: path.join(directory, name) })));
  expect(results).toEqual([undefined, undefined, undefined, undefined]);
});

test("codexAuthStatus and codexLogin attach accountId for ChatGPT logins and omit it for API-key logins", async () => {
  const codexHome = path.join(directory, "codex-home");
  await writeCodexAuth(codexHome, {
    auth_mode: "chatgpt",
    tokens: { access_token: "secret-should-not-appear", account_id: "acct_live_789" },
  });
  const fake = fakeLoginCli({
    dir: directory,
    name: "codex-account-id",
    script: "fake-codex-login.mjs",
    state: { version: "0.160.0", email: "user@example.com", loggedIn: true, mode: "success" },
  });
  const installation = { kind: "available" as const, via: "executable" as const, command: fake.command, version: "codex-cli 0.160.0" };

  const status = await codexAuthStatus(installation, { env: { CODEX_HOME: codexHome } });
  expect(status).toEqual({
    kind: "logged_in",
    source: "codex login status",
    account: { credential: "account", metering: "plan", method: "chatgpt", accountId: "acct_live_789" },
  });
  expect(JSON.stringify(status)).not.toContain("secret-should-not-appear");

  const login = await codexLogin(installation, recordedInteraction([]), { env: { CODEX_HOME: codexHome } });
  expect(login).toEqual({
    kind: "logged_in",
    account: { credential: "account", metering: "plan", method: "chatgpt", email: "user@example.com", plan: "plus", accountId: "acct_live_789" },
  });
});
