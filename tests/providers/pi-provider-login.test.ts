import childProcess from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, expect, test, vi } from "vitest";
import type { ProviderLoginInteraction, ProviderLoginPrompt } from "../../packages/oar/src/contracts/provider-auth.js";
import { createPiProviderAuth, toLoginPrompt } from "../../packages/oar/src/runtimes/pi/auth.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  for (const dir of directories.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "oar-pi-provider-login-"));
  directories.push(dir);
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, "{}", { mode: 0o600 });
  const auth = await createPiProviderAuth({ authPath, modelsPath: null });
  return { auth, authPath };
}

/** Pi's native parser, deliberately not an OAR reimplementation. */
async function piResolve(value: string): Promise<string | undefined> {
  const root = import.meta.resolve("@earendil-works/pi-coding-agent");
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- pi's untyped dist module.
  const resolver = await import(new URL("core/resolve-config-value.js", root).href) as { resolveConfigValue(config: string, env?: Record<string, string>): string | undefined };
  return resolver.resolveConfigValue(value, { HOME: "expanded-home", X: "expanded-x" });
}

function stored(path: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
  return asRecord(parsed) ?? {};
}

function forbidCommands() {
  // Guard the regression too: a broken encoder must never execute the test keys.
  const exec = vi.spyOn(childProcess, "execSync").mockImplementation(() => { throw new Error("unexpected key command"); });
  const spawn = vi.spyOn(childProcess, "spawnSync").mockImplementation(() => { throw new Error("unexpected key command"); });
  syncBuiltinESMExports();
  return { exec, spawn };
}

async function assertStoredLiteral(authPath: string, key: string): Promise<void> {
  const encoded = asRecord(stored(authPath).groq)?.key;
  expect(typeof encoded).toBe("string");
  if (typeof encoded !== "string") {
    throw new TypeError("missing stored key");
  }
  expect(await piResolve(encoded), key).toBe(key);
  // The request path must not interpret the result a second time either.
  const native = await ModelRuntime.create({ authPath, modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  const resolved = await native.getAuth("groq");
  expect(resolved?.auth.apiKey, key).toBe(key);
}

test.each(["setApiKey", "login"] as const)("%s stores literal keys that Pi resolves unchanged without executing commands", async (method) => {
  const { auth, authPath } = await fixture();
  const { exec, spawn } = forbidCommands();
  // oxlint-disable-next-line no-template-curly-in-string -- literal Pi config syntax is the input under test.
  const keys = ["!rm", "$HOME", "${X}", "$$", "$!", "!echo $HOME ${X} $$", "plain!token", " tail $ "];
  for (const key of keys) {
    // oxlint-disable-next-line no-await-in-loop -- verify the file after each independent write.
    await (method === "setApiKey" ? auth.setApiKey("groq", key)
      : auth.login("groq", "api_key", { onEvent: () => {}, prompt: async () => key }));
    // oxlint-disable-next-line no-await-in-loop -- native parser and request auth read this exact write.
    await assertStoredLiteral(authPath, key);
  }
  expect(exec).not.toHaveBeenCalled();
  expect(spawn).not.toHaveBeenCalled();
});

test("interactive API-key login escapes only the key, preserving provider settings", async () => {
  const { auth, authPath } = await fixture();
  const answers = ["!literal-key$", "account$X!", "gateway$HOME!"];
  await auth.login("cloudflare-ai-gateway", "api_key", {
    onEvent: () => {},
    prompt: async () => (answers.shift() ?? ""),
  });
  expect(stored(authPath)["cloudflare-ai-gateway"]).toEqual({
    type: "api_key", key: "$!literal-key$$",
    env: { CLOUDFLARE_ACCOUNT_ID: "account$X!", CLOUDFLARE_GATEWAY_ID: "gateway$HOME!" },
  });
});

test("login forwards the host's device ID getter and agent name as native options, without calling the getter itself", async () => {
  const { auth } = await fixture();
  const login = vi.spyOn(ModelRuntime.prototype, "login").mockResolvedValue({ type: "oauth", access: "fake", refresh: "fake", expires: 0 });
  const getDeviceId = vi.fn(() => "0dc9f07b-e77b-44ab-b6ea-a731783b9f25");
  const options = { getDeviceId, agentName: "Test host" };
  await auth.login("openai", "oauth", { onEvent: () => {}, prompt: async () => "" }, options);
  expect(login).toHaveBeenCalledWith("openai", "oauth", expect.any(Object), options);
  expect(getDeviceId).not.toHaveBeenCalled();
});

test.each([undefined, () => "invalid-id"])("ChatGPT keeps Pi's native missing/invalid UUID rejection", async (getDeviceId) => {
  const { auth } = await fixture();
  const onEvent = vi.fn<ProviderLoginInteraction["onEvent"]>();
  await expect(auth.login("openai", "oauth", { onEvent, prompt: async () => "" },
    getDeviceId === undefined ? undefined : { getDeviceId })).rejects.toThrow("requires a device ID (UUID)");
  expect(onEvent).not.toHaveBeenCalled();
});

test.each(["secret", "select", "manual_code"] as const)("%s prompt mapping preserves Pi's cancellation signal", (type) => {
  const controller = new AbortController();
  const prompt = type === "select"
    ? { type, message: "choose", options: [], signal: controller.signal }
    : { type, message: "answer", signal: controller.signal };
  expect(toLoginPrompt(prompt).signal).toBe(controller.signal);
});

function pendingInteraction(signal: AbortSignal) {
  const asked = Promise.withResolvers<ProviderLoginPrompt>();
  const answer = Promise.withResolvers<string>();
  const interaction: ProviderLoginInteraction = {
    signal,
    onEvent: () => {},
    prompt: async (prompt) => { asked.resolve(prompt); return answer.promise; },
  };
  return { asked: asked.promise, answer, interaction };
}

async function cancelInput(login: Promise<unknown>, asked: Promise<ProviderLoginPrompt>, controller: AbortController): Promise<void> {
  const rejected = expect(login).rejects.toThrow("input closed");
  const prompt = await asked;
  controller.abort(new Error("input closed"));
  await rejected;
  expect(prompt.signal?.aborted).toBe(true);
}

test("host cancellation rejects a native key login while input stays pending and never stores a late answer", async () => {
  const { auth, authPath } = await fixture();
  const controller = new AbortController();
  const pending = pendingInteraction(controller.signal);
  const login = auth.login("groq", "api_key", pending.interaction);
  await cancelInput(login, pending.asked, controller);
  pending.answer.resolve("late-key");
  await Promise.resolve();
  expect(stored(authPath)).toEqual({});
});

test("an already cancelled login does not prompt or store", async () => {
  const { auth, authPath } = await fixture();
  const controller = new AbortController();
  controller.abort(new Error("already cancelled"));
  const prompt = vi.fn(async () => "unused-key");
  await expect(auth.login("groq", "api_key", { signal: controller.signal, onEvent: () => {}, prompt })).rejects.toThrow("already cancelled");
  expect(prompt).not.toHaveBeenCalled();
  expect(stored(authPath)).toEqual({});
});

test.each(["host", "native"] as const)("%s cancellation reaches the host and rejects a pending Pi prompt", async (source) => {
  const { auth } = await fixture();
  const host = new AbortController();
  const native = new AbortController();
  vi.spyOn(ModelRuntime.prototype, "login").mockImplementation(async (_id, _method, interaction) => {
    await interaction.prompt({ type: "manual_code", message: "code", signal: native.signal });
    throw new Error("the cancelled prompt must not return an answer");
  });
  const pending = pendingInteraction(host.signal);
  const login = auth.login("openai", "oauth", pending.interaction);
  await cancelInput(login, pending.asked, source === "host" ? host : native);
  expect(source === "host" ? native.signal.aborted : host.signal.aborted).toBe(false);
});

test("OAuth answers remain literal input to the native flow, without API-key storage escaping", async () => {
  const { auth } = await fixture();
  const input = "!callback$HOME";
  vi.spyOn(ModelRuntime.prototype, "login").mockImplementation(async (_id, _method, interaction) => {
    expect(await interaction.prompt({ type: "secret", message: "OAuth secret" })).toBe(input);
    return { type: "oauth", access: "fake", refresh: "fake", expires: 0 };
  });
  await auth.login("openai", "oauth", { onEvent: () => {}, prompt: async () => input });
});
