import { afterEach, expect, test } from "vitest";
import type { LoginProvider } from "../../packages/oar/src/contracts/provider-auth.js";
import { createOpencodeProviderAuth, OpencodeProviderAuthError } from "../../packages/oar/src/runtimes/opencode/provider-auth.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";
import { fakeCalls, fakeConnections, fakeList, opencodeAuthFixture, rejectionOf, removeOpencodeAuthFixtures, serverRunning } from "../fixtures/opencode-provider-auth.js";

afterEach(removeOpencodeAuthFixtures);

function methodText(method: LoginProvider["methods"][number]): string {
  if (method.method === "oauth") { return `oauth ${method.name}`; }
  return `${method.ambient === true ? "env" : "key"} ${method.name}`;
}

function menu(providers: readonly LoginProvider[]): string[] {
  return providers.map((provider) => `${provider.providerId}: ${provider.methods.map(methodText).join(" | ")}`);
}

test("loginProviders maps the registry OpenCode loaded: OAuth before keys, env keys ambient, external-only omitted", async () => {
  const { using, fake, home } = await opencodeAuthFixture();
  await using(async (auth) => {
    expect(menu(auth.loginProviders())).toEqual([
      "azure: key API key | env AZURE_API_KEY, AZURE_COGNITIVE_SERVICES_API_KEY",
      "github-copilot: oauth Login with GitHub Copilot | env GITHUB_TOKEN",
      "gitlab: oauth Login with GitLab (OAuth) | key GitLab API key",
      "openai: oauth Sign in with ChatGPT | oauth Codex device code (legacy) | key OpenAI API key | env OPENAI_API_KEY",
      "poe: oauth Login with Poe (browser)",
      "xai: oauth SuperGrok Subscription | key Manually enter API Key | env XAI_API_KEY",
      "zai: key Z.AI API key | env ZHIPU_API_KEY",
    ]);
    expect(auth.loginProviders().find((provider) => provider.providerId === "xai")).toEqual({ providerId: "xai", name: "xAI", methods: [
      // OpenCode does not say whether a sign-in is a subscription, so `subscription` is absent.
      { method: "oauth", name: "SuperGrok Subscription" },
      { method: "api_key", name: "Manually enter API Key" },
      { method: "api_key", name: "XAI_API_KEY", ambient: true },
    ] });
    // The fake lists its registry only after two empty reads: OAR waited for it.
    expect(fake.read()).toMatchObject({ argv: ["serve", "--hostname", "127.0.0.1", "--port", "0"], cwd: home });
  });
  await expect.poll(() => serverRunning(fake), { timeout: 5000 }).toBe(false);
});

test("status and listProviders read connections: credentials listed, environment-only keys only in status", async () => {
  const { using } = await opencodeAuthFixture();
  await using(async (auth) => {
    expect(await auth.listProviders()).toEqual([
      { providerId: "openai", configured: true, method: "oauth", label: "OpenAI" },
      { providerId: "xai", configured: true, method: "api_key", label: "xAI" },
    ]);
    expect(await auth.status("zai")).toEqual({ providerId: "zai", configured: true, method: "api_key", label: "ZHIPU_API_KEY" });
    expect(await auth.status("poe")).toEqual({ providerId: "poe", configured: false });
    // As with Pi, a provider the backend does not know is simply not configured.
    expect(await auth.status("nope")).toEqual({ providerId: "nope", configured: false });
  });
});

test("setApiKey stores through OpenCode, then removes the integration's earlier credentials; env stays", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    await auth.setApiKey("xai", "xai-new-SECRET-key-0001");
    expect(fakeList(fake, "storedKeys")).toEqual([{ integrationID: "xai", key: "xai-new-SECRET-key-0001" }]);
    expect(fakeConnections(fake, "xai")).toEqual([
      { type: "credential", id: "cred_key1", label: "xAI", method: "key" },
      { type: "env", name: "XAI_API_KEY" },
    ]);
    const status = await auth.status("xai");
    expect(status).toEqual({ providerId: "xai", configured: true, method: "api_key", label: "xAI" });
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });
});

test("a stored key whose earlier credentials cannot be removed still resolves: the new key is active", async () => {
  const { using, fake } = await opencodeAuthFixture({ failRemove: true });
  await using(async (auth) => {
    await auth.setApiKey("xai", "xai-new-SECRET-key-0004");
    expect(fakeConnections(fake, "xai")).toEqual([
      { type: "credential", id: "cred_key1", label: "xAI", method: "key" },
      { type: "credential", id: "cred_old_xai_2", label: "xAI", method: "key" },
      { type: "credential", id: "cred_old_xai_1", label: "oar", method: "key" },
      { type: "env", name: "XAI_API_KEY" },
    ]);
    expect(await auth.status("xai")).toEqual({ providerId: "xai", configured: true, method: "api_key", label: "xAI" });
  });
});

test("a refused key removes nothing, and OpenCode's echo of it is redacted", async () => {
  const { using, fake } = await opencodeAuthFixture({ rejectKey: true });
  await using(async (auth) => {
    const error = await rejectionOf(auth.setApiKey("xai", "xai-refused-SECRET-0002"));
    expect(error).toBeInstanceOf(OpencodeProviderAuthError);
    expect(error).toMatchObject({ kind: "rejected", status: 400 });
    expect(String(error)).toContain("InvalidRequestError");
    expect(String(error)).not.toContain("xai-refused-SECRET-0002");
    expect(fakeConnections(fake, "xai")).toHaveLength(3);
  });
});

test("a key that needs form answers is refused by setApiKey and asked by login", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const refused = await rejectionOf(auth.setApiKey("azure", "azure-SECRET-0003"));
    expect(refused).toMatchObject({ kind: "method_unavailable" });
    expect(String(refused)).toContain('login("azure", "api_key", interaction)');
    expect(fakeList(fake, "storedKeys")).toEqual([]);
    const interaction = recordedInteraction(["azure-SECRET-0003", "my-models"]);
    expect(await auth.login("azure", "api_key", interaction)).toEqual({ providerId: "azure", configured: true, method: "api_key", label: "Azure" });
    expect(interaction.prompts).toEqual([
      { kind: "secret", message: "API key" },
      { kind: "text", message: "Enter Azure Resource Name", placeholder: "e.g. my-models" },
    ]);
    expect(fakeList(fake, "storedKeys")).toEqual([{ integrationID: "azure", key: "azure-SECRET-0003", answer: { resourceName: "my-models" } }]);
  });
});

test("an integration with no key prompt names its environment variables instead", async () => {
  const { using } = await opencodeAuthFixture();
  await using(async (auth) => {
    const error = await rejectionOf(auth.setApiKey("github-copilot", "ghp_SECRET"));
    expect(error).toMatchObject({ kind: "method_unavailable" });
    expect(String(error)).toContain("GITHUB_TOKEN");
    const external = auth.login("claude-agent", "oauth", recordedInteraction([]));
    expect(await rejectionOf(external)).toMatchObject({ kind: "method_unavailable" });
  });
});

test("logout removes every stored credential of the integration through credential.remove and leaves env alone", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    await auth.logout("xai");
    expect(fakeConnections(fake, "xai")).toEqual([{ type: "env", name: "XAI_API_KEY" }]);
    expect(fakeCalls(fake).filter((call) => call.method === "DELETE")).toEqual([
      { method: "DELETE", path: "/api/credential/cred_old_xai_2" },
      { method: "DELETE", path: "/api/credential/cred_old_xai_1" },
    ]);
    expect(await auth.status("xai")).toEqual({ providerId: "xai", configured: true, method: "api_key", label: "XAI_API_KEY" });
  });
});

test("OpenCode 1 and a bundled installation are refused before anything starts", async () => {
  const { installation, fake } = await opencodeAuthFixture({}, "1.19.5");
  const error = await rejectionOf(createOpencodeProviderAuth(installation));
  expect(error).toMatchObject({ name: "OpencodeProviderAuthError", kind: "version_unsupported" });
  expect(String(error)).toContain("OpenCode 2 (@opencode/cli)");
  expect(await rejectionOf(createOpencodeProviderAuth({ kind: "available", via: "bundled" }))).toMatchObject({ kind: "unsupported_installation" });
  expect(fake.read().argv).toBeUndefined();
});

test("the public entry starts OpenCode 2 in the overlay's home and passes its idle period", async () => {
  const { installation, home, fake } = await opencodeAuthFixture();
  const auth = await createOpencodeProviderAuth(installation, { env: { HOME: home, USERPROFILE: home }, idleMs: 50 });
  try {
    expect(menu(auth.loginProviders())).toContain("poe: oauth Login with Poe (browser)");
    expect(fake.read().cwd).toBe(home);
    await expect.poll(() => serverRunning(fake), { timeout: 5000 }).toBe(false);
  } finally {
    await auth.close();
  }
});

test("serve gets OAR's password and no inherited username, update check, catalog fetch or browser", async () => {
  const { create, fake, home } = await opencodeAuthFixture();
  const env = { ...process.env, HOME: home, USERPROFILE: home, OPENCODE_SERVER_USERNAME: "someone", BROWSER: "firefox" };
  const auth = await create({ env });
  await auth.close();
  expect(fake.read().env).toEqual({
    username: null,
    browser: process.platform === "win32" ? "firefox" : "true",
    autoupdate: "1",
    modelsFetch: "1",
  });
});

test("a 401 from serve is an authentication failure at once, not a timeout", async () => {
  const { create } = await opencodeAuthFixture({ ignorePassword: true });
  const started = Date.now();
  const error = await rejectionOf(create({ timeoutMs: 10_000 }));
  expect(error).toMatchObject({ name: "OpencodeProviderAuthError", kind: "authentication_failed", status: 401 });
  expect(String(error)).toContain("UnauthorizedError");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("startup and readiness share one timeoutMs: a late listen leaves readiness only the rest", async () => {
  const { create } = await opencodeAuthFixture({ listenDelayMs: 1200, hangPlugin: true });
  const started = Date.now();
  const error = await rejectionOf(create({ timeoutMs: 2000 }));
  const elapsed = Date.now() - started;
  expect(error).toMatchObject({ kind: "timed_out" });
  // A full timeoutMs for the hanging read would end after about 3.2 s.
  expect(elapsed, `ended after ${String(elapsed)} ms`).toBeLessThan(2800);
});

test("a crashed or silent start is reported with OpenCode's first line", async () => {
  const crashed = await opencodeAuthFixture({ startup: "crash" });
  const error = await rejectionOf(crashed.create());
  expect(error).toMatchObject({ kind: "startup_failed" });
  expect(String(error)).toContain("database is locked");
  const silent = await opencodeAuthFixture({ startup: "silent" });
  expect(await rejectionOf(silent.create({ timeoutMs: 300 }))).toMatchObject({ kind: "timed_out" });
});

test("the server stops after the idle period and the next operation starts another", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const first = fake.read().serverPid;
    await expect.poll(() => serverRunning(fake), { timeout: 5000 }).toBe(false);
    expect(await auth.status("poe")).toEqual({ providerId: "poe", configured: false });
    expect(fake.read().serverPid).not.toBe(first);
  }, { idleMs: 50 });
});
