import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterEach, expect, it, vi } from "vitest";
import { antigravityVersionPreflight } from "../../packages/oar/src/runtimes/antigravity/version.js";
import { antigravityRuntime } from "../../packages/oar/src/runtimes/antigravity/index.js";
import { antigravityAuthStatus, antigravityLogin } from "../../packages/oar/src/runtimes/antigravity/auth.js";
import { fakeLoginCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";

vi.mock("../../packages/oar/src/runtimes/antigravity/version.js", { spy: true });

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true }); })); });
async function fixture(mode: string, loggedIn = false) {
  const dir = await mkdtemp(path.join(tmpdir(), "oar-agy-login-")); directories.push(dir);
  const fake = fakeLoginCli({ dir, name: "agy", script: "fake-agy-login.mjs", state: { mode, loggedIn } });
  return { fake, env: { HOME: dir, USERPROFILE: dir }, installation: { kind: "available" as const, via: "executable" as const, command: fake.command, version: "1.5.5" } };
}

it.skipIf(process.platform === "win32")("relays the Google URL, writes only the pasted code to agy's stdin, and confirms with agy models", async () => {
  const { fake, env, installation } = await fixture("success");
  const interaction = recordedInteraction(["  synthetic-private-code  "]);
  expect(await antigravityLogin(installation, interaction, { openBrowser: false, env })).toEqual({ kind: "logged_in" });
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
  const { fake, env, installation } = await fixture("success");
  const interaction = recordedInteraction([" ", "synthetic-private-code"]);
  expect(await antigravityLogin(installation, interaction, { env })).toEqual({ kind: "logged_in" });
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
  expect(await antigravityAuthStatus(signedIn.installation, { env: signedIn.env })).toEqual({ kind: "logged_in", source: "agy models" });
  expect(await antigravityAuthStatus(signedOut.installation, { env: signedOut.env })).toEqual({ kind: "logged_out", source: "agy models" });
  expect(await antigravityAuthStatus(failing.installation, { env: failing.env })).toMatchObject({ kind: "unknown", source: "agy models" });
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

it("successful native logout keeps its result when the confirmation version probe fails", async () => {
  const { installation } = await fixture("success", true);
  const probe = vi.mocked(antigravityVersionPreflight);
  probe.mockClear().mockRejectedValueOnce(new Error("private native failure"));
  try {
    await expect(antigravityRuntime.logout(installation)).resolves.toEqual({ kind: "logged_out" });
    expect(probe).toHaveBeenCalledOnce();
  } finally { probe.mockClear(); }
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

it("a separate GEMINI_HOME blocks the default-profile status query", async () => {
  const { fake, installation } = await fixture("idle", true);
  const result = await antigravityAuthStatus(installation, { env: { GEMINI_HOME: path.resolve("isolated agy profile") } });
  expect(result).toEqual({ kind: "unknown", detail: "agy models cannot select GEMINI_HOME; isolate HOME (USERPROFILE on Windows) for authentication and usage queries" });
  expect(fake.read().calls).toBeUndefined();
});

it("login selects GEMINI_HOME without checking another profile after success", async () => {
  const { fake, installation } = await fixture("success");
  const gemini = path.resolve("isolated agy profile");
  expect(await antigravityLogin(installation, recordedInteraction(["synthetic-private-code"]), { env: { GEMINI_HOME: gemini } })).toEqual({ kind: "logged_in" });
  expect(fake.read().calls).toEqual([["acp", "--login", "--gemini-dir", gemini]]);
});

it("logout selects GEMINI_HOME without checking another profile afterwards", async () => {
  const { fake, installation } = await fixture("success", true);
  const gemini = path.resolve("isolated agy profile");
  expect(await antigravityRuntime.logout(installation, { env: { GEMINI_HOME: gemini } })).toEqual({ kind: "logged_out" });
  expect(fake.read().calls).toEqual([["acp", "--gemini-dir", gemini]]);
});

it("status accepts GEMINI_HOME when it names the native default under the effective home", async () => {
  const { fake, installation } = await fixture("idle", true);
  const home = path.resolve("isolated home");
  const env = { HOME: home, USERPROFILE: home, GEMINI_HOME: path.join(home, ".gemini") };
  expect(await antigravityAuthStatus(installation, { env })).toEqual({ kind: "logged_in", source: "agy models" });
  expect(fake.read().calls).toEqual([["models"]]);
});
