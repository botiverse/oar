import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createPiProviderAuth, piLoginProvider, toLoginEvent, toLoginPrompt } from "../../packages/oar/src/runtimes/pi/auth.js";

test("device_code and auth_url events surface the login link", () => {
  expect(toLoginEvent({
    type: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    intervalSeconds: 5,
    expiresInSeconds: 1800,
  })).toEqual({
    kind: "device_code",
    userCode: "ABCD-1234",
    verificationUri: "https://example.com/device",
    intervalSeconds: 5,
    expiresInSeconds: 1800,
  });
  expect(toLoginEvent({ type: "auth_url", url: "https://example.com/oauth" }))
    .toEqual({ kind: "auth_url", url: "https://example.com/oauth" });
});

test("info and progress events collapse to a neutral message", () => {
  expect(toLoginEvent({ type: "info", message: "hello" })).toEqual({ kind: "info", message: "hello" });
  expect(toLoginEvent({ type: "progress", message: "working" })).toEqual({ kind: "info", message: "working" });
});

test("prompts map by type, preserving select options", () => {
  expect(toLoginPrompt({ type: "secret", message: "API key?", placeholder: "sk-…" }))
    .toEqual({ kind: "secret", message: "API key?", placeholder: "sk-…" });
  expect(toLoginPrompt({
    type: "select",
    message: "Pick one",
    options: [{ id: "a", label: "Account" }, { id: "k", label: "API key", description: "metered" }],
  })).toEqual({
    kind: "select",
    message: "Pick one",
    options: [{ id: "a", label: "Account" }, { id: "k", label: "API key", description: "metered" }],
  });
});

// Stands in for the key prompt a pi `ApiKeyAuth.login` runs.
function keyPrompt(): void {
  // never called: loginProviders() only reads whether pi has one
}

test("a subscription sign-in comes before the API key, with the vendor's own label", () => {
  expect(piLoginProvider({
    id: "openai",
    name: "OpenAI",
    auth: {
      oauth: { name: "OpenAI (ChatGPT subscription)", isSubscription: true, loginLabel: "Sign in with ChatGPT" },
      apiKey: { name: "OpenAI API key", login: keyPrompt },
    },
  })).toMatchInlineSnapshot(`
    {
      "methods": [
        {
          "loginLabel": "Sign in with ChatGPT",
          "method": "oauth",
          "name": "OpenAI (ChatGPT subscription)",
          "subscription": true,
        },
        {
          "method": "api_key",
          "name": "OpenAI API key",
        },
      ],
      "name": "OpenAI",
      "providerId": "openai",
    }
  `);
});

test("an account sign-in without isSubscription is not a subscription", () => {
  expect(piLoginProvider({ id: "openrouter", name: "OpenRouter", auth: { oauth: { name: "OpenRouter OAuth" } } })?.methods)
    .toMatchInlineSnapshot(`
      [
        {
          "method": "oauth",
          "name": "OpenRouter OAuth",
          "subscription": false,
        },
      ]
    `);
});

test("an API key pi has no prompt for is ambient; a provider with no method is left out", () => {
  expect(piLoginProvider({ id: "local", name: "Local", auth: { apiKey: { name: "AWS credentials" } } })?.methods)
    .toMatchInlineSnapshot(`
      [
        {
          "ambient": true,
          "method": "api_key",
          "name": "AWS credentials",
        },
      ]
    `);
  expect(piLoginProvider({ id: "none", name: "None", auth: {} })).toBeUndefined();
});

// Real pi ModelRuntime, built-in providers only: no network, no login. The
// two stored credentials, an OAuth subscription and an API key, are fakes.
async function piAuth() {
  const dir = mkdtempSync(join(tmpdir(), "oar-provider-auth-"));
  const authPath = join(dir, "auth.json");
  writeFileSync(authPath, JSON.stringify({
    anthropic: { type: "oauth", access: "fake-access", refresh: "fake-refresh", expires: Date.now() + 3_600_000 },
    deepseek: { type: "api_key", key: "fake-key" },
  }), { mode: 0o600 });
  const auth = await createPiProviderAuth({ authPath, modelsPath: null });
  return auth;
}

test("pi's registry lists every provider by name, each with a method", async () => {
  const auth = await piAuth();
  const names = auth.loginProviders().map((provider) => provider.name);
  expect(names).toEqual(names.toSorted((left, right) => left.localeCompare(right)));
  expect(auth.loginProviders().filter((provider) => provider.methods.length === 0)).toEqual([]);
});

test("pi's registry entries: Radius, a subscription with a key, an OAuth-only provider", async () => {
  const auth = await piAuth();
  const byId = new Map(auth.loginProviders().map((provider) => [provider.providerId, provider]));
  expect(byId.get("radius")).toMatchInlineSnapshot(`
    {
      "methods": [
        {
          "method": "oauth",
          "name": "Radius",
          "subscription": false,
        },
        {
          "method": "api_key",
          "name": "Radius API key",
        },
      ],
      "name": "Radius",
      "providerId": "radius",
    }
  `);
  expect(byId.get("anthropic")?.methods).toMatchInlineSnapshot(`
    [
      {
        "method": "oauth",
        "name": "Anthropic (Claude Pro/Max)",
        "subscription": true,
      },
      {
        "method": "api_key",
        "name": "Anthropic API key",
      },
    ]
  `);
  expect(byId.get("openai-codex")?.methods).toMatchInlineSnapshot(`
    [
      {
        "method": "oauth",
        "name": "OpenAI (ChatGPT Plus/Pro)",
        "subscription": true,
      },
    ]
  `);
});

test("a stored Claude Pro/Max login reads as a subscription; listProviders() stays the stored subset", async () => {
  const auth = await piAuth();
  expect(await auth.status("anthropic")).toMatchInlineSnapshot(`
    {
      "configured": true,
      "label": "OAuth",
      "method": "oauth",
      "providerId": "anthropic",
      "subscription": true,
    }
  `);
  expect(await auth.status("deepseek")).toMatchInlineSnapshot(`
    {
      "configured": true,
      "label": "stored credential",
      "method": "api_key",
      "providerId": "deepseek",
      "subscription": false,
    }
  `);
  const listed = await auth.listProviders();
  expect(listed.map((status) => status.providerId).toSorted()).toEqual(["anthropic", "deepseek"]);
});

test("setApiKey stores a key whose login asks for the key alone", async () => {
  const auth = await piAuth();
  await auth.setApiKey("groq", "fake-key");
  expect(await auth.status("groq")).toMatchInlineSnapshot(`
    {
      "configured": true,
      "label": "stored credential",
      "method": "api_key",
      "providerId": "groq",
      "subscription": false,
    }
  `);
});

// Each of these API-key logins asks more than the key: the question setApiKey refuses, in pi's words.
test.each([
  ["amazon-bedrock", 'select: "Select Amazon Bedrock authentication method:"'],
  ["cloudflare-ai-gateway", 'text: "Enter Cloudflare account ID"'],
  ["cloudflare-workers-ai", 'text: "Enter Cloudflare account ID"'],
  ["google-vertex", 'select: "Select Google Vertex AI authentication method:"'],
])("setApiKey refuses %s, whose login asks more than the key, and stores nothing", async (providerId, question) => {
  const auth = await piAuth();
  await expect(auth.setApiKey(providerId, "fake-key")).rejects.toThrow(new Error(
    `${providerId}'s API-key login asks more than the key (${question}): use login("${providerId}", "api_key", interaction) instead of setApiKey`,
  ));
  const listed = await auth.listProviders();
  expect(listed.map((status) => status.providerId).toSorted()).toEqual(["anthropic", "deepseek"]);
});
