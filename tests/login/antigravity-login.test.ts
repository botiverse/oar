import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it } from "vitest";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { antigravityAuthStatus, antigravityLogin } from "../../packages/oar/src/runtimes/antigravity/auth.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
async function fixture(mode: string, loggedIn = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-agy-login-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "agy", script: "fake-agy-login.mjs", state: { mode, loggedIn } });
  return { fake, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "1.5.5" } };
}

it.skipIf(process.platform === "win32")("relays the Google URL, writes only the pasted code to agy's stdin, and confirms with agy models", async () => {
  const { fake, installation } = await fixture("success");
  const interaction = recordedInteraction(["  synthetic-private-code  "]);
  expect(await antigravityLogin(installation, interaction, { openBrowser: false })).toEqual({ kind: "logged_in" });
  expect(interaction.events).toEqual([{ kind: "auth_url", url: "https://accounts.google.com/o/oauth2/auth?client_id=synthetic&code_challenge=synthetic&state=synthetic", instructions: "Open this URL and sign in with Google, then paste the code the page shows (or its full address)." }]);
  expect(interaction.prompts.map((prompt) => prompt.kind)).toEqual(["manual_code"]);
  expect(fake.read()).toMatchObject({ calls: [["acp", "--login"], ["models"]], pasted: "synthetic-private-code" });
  expect(String(fake.read().launcher)).toContain("oar-agy-browser-");
});

it.runIf(process.platform === "win32")("Windows refuses openBrowser: false before anything runs: agy's launcher is an absolute rundll32 path", async () => {
  const { fake, installation } = await fixture("success");
  expect(await antigravityLogin(installation, recordedInteraction([]), { openBrowser: false })).toMatchObject({ kind: "unsupported", reason: "browser_suppression_unavailable" });
  expect(fake.read().calls).toBeUndefined();
});

it("an empty answer is never sent: agy would only keep waiting, so OAR asks again", async () => {
  const { fake, installation } = await fixture("success");
  const interaction = recordedInteraction([" ", "synthetic-private-code"]);
  expect(await antigravityLogin(installation, interaction)).toEqual({ kind: "logged_in" });
  expect(interaction.prompts).toHaveLength(2);
  expect(fake.read()).toMatchObject({ pasted: "synthetic-private-code" });
  expect(fake.read().emptyLines).toBeUndefined();
});

it("a refused code never echoes the pasted code", async () => {
  const { installation } = await fixture("rejected");
  const result = await antigravityLogin(installation, recordedInteraction(["synthetic-private-code"]));
  expect(result).toMatchObject({ kind: "failed", reason: "rejected" });
  expect(JSON.stringify(result)).not.toContain("synthetic-private-code");
});

it("a pasted landing URL keeps its code out of the result when agy echoes only the code", async () => {
  const { installation } = await fixture("rejected");
  const result = await antigravityLogin(installation, recordedInteraction(["https://antigravity.google/oauth-callback?state=synthetic&code=4%2Fsynthetic-private-code&scope=email"]));
  expect(result).toMatchObject({ kind: "failed", reason: "rejected" });
  expect(JSON.stringify(result)).not.toContain("synthetic-private-code");
});

it("exit 0 without a login is not a login", async () => {
  const { installation } = await fixture("false-success");
  expect(await antigravityLogin(installation, recordedInteraction(["synthetic-private-code"]))).toMatchObject({ kind: "failed", reason: "not_logged_in" });
});

it("an abort stops agy and is a cancellation", async () => {
  const { installation } = await fixture("hang");
  const abort = new AbortController();
  const result = await antigravityLogin(installation, { signal: abort.signal, onEvent: () => { abort.abort(); }, prompt: async () => delay(60_000, "", { signal: abort.signal }) });
  expect(result).toEqual({ kind: "cancelled" });
});

it("status is agy models: listed, asked to sign in, or unknown", async () => {
  const signedIn = await fixture("idle", true);
  const signedOut = await fixture("idle", false);
  const failing = await fixture("models-error", true);
  expect(await antigravityAuthStatus(signedIn.installation)).toEqual({ kind: "logged_in", source: "agy models" });
  expect(await antigravityAuthStatus(signedOut.installation)).toEqual({ kind: "logged_out", source: "agy models" });
  expect(await antigravityAuthStatus(failing.installation)).toMatchObject({ kind: "unknown", source: "agy models" });
});

it("the runtime signs in, reads status and signs out", () => {
  expect(typeof antigravityRuntime.login).toBe("function");
  expect(typeof antigravityRuntime.authStatus).toBe("function");
  expect(typeof antigravityRuntime.logout).toBe("function");
});

it("logout is agy's own ACP logout, confirmed by agy models", async () => {
  const { fake, installation } = await fixture("success", true);
  expect(await antigravityRuntime.logout(installation)).toEqual({ kind: "logged_out" });
  expect(fake.read()).toMatchObject({ calls: [["acp"], ["models"]], loggedIn: false });
});

it("logout does not claim a sign-in agy still reports is gone", async () => {
  const { installation } = await fixture("sticky", true);
  expect(await antigravityRuntime.logout(installation)).toMatchObject({ kind: "failed", reason: "still_logged_in" });
});

it("an agy without ACP logout is unsupported, and nothing is deleted", async () => {
  const { fake, installation } = await fixture("no-logout", true);
  expect(await antigravityRuntime.logout(installation)).toMatchObject({ kind: "unsupported", reason: "version_unsupported" });
  expect(fake.read()).toMatchObject({ calls: [["acp"]], loggedIn: true });
});
