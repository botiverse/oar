import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { factoryAuthStatus, factoryLogin, factoryLogout, projectFactoryAuthStatus } from "../../packages/oar/src/runtimes/factory/account.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
async function fixture(mode: string, loggedIn = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-factory-login-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "droid", script: "fake-droid-acp.mjs", state: { mode, loggedIn } });
  return { fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "1.12.1" } };
}

it("relays droid's device-pairing URL as an auth_url, accepts it, and confirms with auth/status", async () => {
  const { fake, installation } = await fixture("success");
  const interaction = recordedInteraction([]);
  expect(await factoryLogin(installation, interaction)).toEqual({ kind: "logged_in", account: { credential: "account" } });
  expect(interaction.events).toEqual([{ kind: "auth_url", url: "https://auth.factory.ai/device?user_code=ABCD-EFGH", instructions: "Sign in to Factory to continue this Droid thread." }]);
  expect(interaction.prompts).toEqual([]);
  expect(fake.read()).toMatchObject({ calls: [["exec", "--output-format", "acp"]], elicitation: { url: {} }, answer: { action: "accept" }, loggedIn: true });
});

it("a refused sign-in is rejected in droid's words, without the device URL", async () => {
  const { installation } = await fixture("rejected");
  const result = await factoryLogin(installation, recordedInteraction([]));
  expect(result).toMatchObject({ kind: "failed", reason: "rejected" });
  expect(JSON.stringify(result)).not.toContain("ABCD-EFGH");
});

it("success that droid's own status does not confirm is not a sign-in", async () => {
  const { installation } = await fixture("false-success");
  expect(await factoryLogin(installation, recordedInteraction([]))).toMatchObject({ kind: "failed", reason: "not_logged_in" });
});

it("a sign-in nobody confirms times out, and an abort cancels", async () => {
  const { installation } = await fixture("hang");
  expect(await factoryLogin(installation, recordedInteraction([]), { timeoutMs: 300 })).toMatchObject({ kind: "failed", reason: "timed_out" });
  const controller = new AbortController();
  const pending = factoryLogin(installation, { ...recordedInteraction([]), signal: controller.signal });
  setTimeout(() => { controller.abort(); }, 200);
  expect(await pending).toEqual({ kind: "cancelled" });
});

it("an interaction that throws declines the URL and fails the login", async () => {
  const { fake, installation } = await fixture("success");
  const result = await factoryLogin(installation, { ...recordedInteraction([]), onEvent: () => { throw new Error("no UI"); } });
  expect(result).toMatchObject({ kind: "failed", reason: "interaction_failed" });
  expect(fake.read()).toMatchObject({ answer: { action: "decline" }, loggedIn: false });
});

const installed = async (mode: string, loggedIn = false) => { const { installation } = await fixture(mode, loggedIn); return installation; };

it("status reads auth/status; FACTORY_API_KEY is configured, not a confirmed login", async () => {
  expect(await factoryAuthStatus(await installed("success", true))).toMatchObject({ kind: "logged_in", account: { credential: "account" } });
  expect(await factoryAuthStatus(await installed("success"))).toMatchObject({ kind: "logged_out" });
  expect(await factoryAuthStatus(await installed("success"), { env: { FACTORY_API_KEY: "fk-test" } }))
    .toMatchObject({ kind: "unknown", configured: ["FACTORY_API_KEY"] });
  expect(projectFactoryAuthStatus({ state: "something-new" })).toMatchObject({ kind: "unknown" });
});

it("logout runs droid's own logout and its status decides", async () => {
  expect(await factoryLogout(await installed("success", true))).toEqual({ kind: "logged_out" });
  expect(await factoryLogout(await installed("sticky", true))).toMatchObject({ kind: "failed", reason: "still_logged_in" });
  expect(await factoryLogout(await installed("success"), { env: { FACTORY_API_KEY: "fk-test" } }))
    .toMatchObject({ kind: "failed", reason: "still_logged_in" });
});
