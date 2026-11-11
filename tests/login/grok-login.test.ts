import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { grokRuntime } from "../../packages/oar/src/runtimes/grok/index.js";
import { grokAuthStatus, grokLogin, grokLogout } from "../../packages/oar/src/runtimes/grok/auth.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
const installed = async (mode: string, loggedIn = false) => { const { installation } = await fixture(mode, loggedIn); return installation; };
async function fixture(mode: string, loggedIn = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-grok-login-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "grok", script: "fake-grok-login.mjs", state: { mode, loggedIn } });
  return { fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "1.0.77" } };
}

it("relays Grok's device code once and confirms the sign-in with grok models", async () => {
  const { fake, installation } = await fixture("success");
  const interaction = recordedInteraction([]);
  expect(await grokLogin(installation, interaction)).toEqual({ kind: "logged_in" });
  expect(interaction.events).toEqual([{ kind: "device_code", userCode: "WXYZ-1234", verificationUri: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-1234" }]);
  expect(interaction.prompts).toEqual([]);
  expect(fake.read()).toMatchObject({ calls: [["login", "--device-auth"], ["models"]], loggedIn: true });
});

it.skipIf(process.platform === "win32")("openBrowser: false points BROWSER at a command that does nothing", async () => {
  const { fake, installation } = await fixture("success");
  expect(await grokLogin(installation, recordedInteraction([]), { openBrowser: false })).toEqual({ kind: "logged_in" });
  expect(fake.read().browser).toBe("true");
});

it.runIf(process.platform === "win32")("Windows refuses openBrowser: false before anything runs", async () => {
  const { fake, installation } = await fixture("success");
  expect(await grokLogin(installation, recordedInteraction([]), { openBrowser: false })).toMatchObject({ kind: "unsupported", reason: "browser_suppression_unavailable" });
  expect(fake.read().calls).toBeUndefined();
});

it("a refused device code is rejected with Grok's words", async () => {
  const { installation } = await fixture("rejected");
  expect(await grokLogin(installation, recordedInteraction([]))).toMatchObject({ kind: "failed", reason: "rejected", detail: "Error: the device code expired" });
});

it("exit 0 without a sign-in is not a sign-in", async () => {
  const { installation } = await fixture("false-success");
  expect(await grokLogin(installation, recordedInteraction([]))).toMatchObject({ kind: "failed", reason: "not_logged_in" });
});

it("a login nobody confirms times out and stops Grok", async () => {
  const { installation } = await fixture("hang");
  expect(await grokLogin(installation, recordedInteraction([]), { timeoutMs: 300 })).toMatchObject({ kind: "failed", reason: "timed_out" });
});

it("status reads grok models: signed in (with the method it names), signed out, or unknown", async () => {
  expect(await grokAuthStatus(await installed("success", true))).toEqual({ kind: "logged_in", account: { method: "grok.com" }, source: "grok models" });
  expect(await grokAuthStatus(await installed("silent-models", true))).toMatchObject({ kind: "unknown", source: "grok models" });
  expect(await grokAuthStatus(await installed("success"))).toMatchObject({ kind: "logged_out", source: "grok models" });
  expect(await grokAuthStatus(await installed("models-error", true))).toMatchObject({ kind: "unknown", source: "grok models" });
});

it("logout is grok logout, confirmed by grok models; a sign-in that stays is not called logged out", async () => {
  const signedIn = await fixture("success", true);
  expect(await grokLogout(signedIn.installation)).toEqual({ kind: "logged_out" });
  expect(signedIn.fake.read()).toMatchObject({ calls: [["logout"], ["models"]], loggedIn: false });
  expect(await grokLogout(await installed("success"))).toEqual({ kind: "logged_out" });
  expect(await grokLogout(await installed("sticky", true))).toMatchObject({ kind: "failed", reason: "still_logged_in" });
});

it("the runtime signs in, reads status and signs out", () => {
  expect(typeof grokRuntime.login).toBe("function");
  expect(typeof grokRuntime.authStatus).toBe("function");
  expect(typeof grokRuntime.logout).toBe("function");
});
