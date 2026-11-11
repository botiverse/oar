import { afterEach, expect, test } from "vitest";
import type { FakeCli } from "../fixtures/login-fixtures.js";
import { recordedInteraction } from "../fixtures/login-interaction.js";
import { fakeCalls, fakeList, opencodeAuthFixture, opencodeOauthPlans, rejectionOf, removeOpencodeAuthFixtures } from "../fixtures/opencode-provider-auth.js";

afterEach(removeOpencodeAuthFixtures);

const connectBody = (fake: FakeCli, id: string): unknown => fakeCalls(fake).find((call) => call.path === `/api/integration/${id}/connect/oauth`)?.body;
const withPlan = (id: keyof typeof opencodeOauthPlans, plan: Record<string, unknown>): Record<string, unknown> =>
  ({ oauth: { ...opencodeOauthPlans, [id]: { ...opencodeOauthPlans[id], ...plan } } });

test("GitHub Copilot: the deployment form is asked as a select, the device code relayed, and the stored sign-in reported", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const interaction = recordedInteraction(["github.com"]);
    expect(await auth.login("github-copilot", "oauth", interaction)).toEqual({ providerId: "github-copilot", configured: true, method: "oauth", label: "GitHub Copilot" });
    expect(interaction.prompts).toEqual([{
      kind: "select",
      message: "Select GitHub deployment type",
      options: [{ id: "github.com", label: "GitHub.com" }, { id: "enterprise", label: "GitHub Enterprise" }],
    }]);
    expect(interaction.events).toEqual([{ kind: "device_code", userCode: "ABCD-1234", verificationUri: "https://github.com/login/device", expiresInSeconds: 600 }]);
    expect(connectBody(fake, "github-copilot")).toEqual({ methodID: "device", answer: { deploymentType: "github.com" } });
    expect(fakeList(fake, "cancelled")).toEqual([]);
  });
});

test("a when-gated field is asked only when its condition holds", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const interaction = recordedInteraction(["enterprise", "company.ghe.com"]);
    await auth.login("github-copilot", "oauth", interaction);
    expect(interaction.prompts[1]).toEqual({ kind: "text", message: "Enter your GitHub Enterprise URL or domain", placeholder: "company.ghe.com" });
    expect(connectBody(fake, "github-copilot")).toEqual({ methodID: "device", answer: { deploymentType: "enterprise", enterpriseUrl: "company.ghe.com" } });
  });
});

test("several OAuth methods are offered as a select; a browser attempt is relayed as its URL", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const interaction = recordedInteraction(["chatgpt-token-sharing"]);
    expect(await auth.login("openai", "oauth", interaction)).toMatchObject({ configured: true, method: "oauth" });
    expect(interaction.prompts).toEqual([{
      kind: "select",
      message: "Sign in to OpenAI",
      options: [{ id: "chatgpt-token-sharing", label: "Sign in with ChatGPT" }, { id: "chatgpt-headless", label: "Codex device code (legacy)" }],
    }]);
    expect(interaction.events).toEqual([{ kind: "auth_url", url: opencodeOauthPlans.openai.url, instructions: opencodeOauthPlans.openai.instructions }]);
    expect(connectBody(fake, "openai")).toEqual({ methodID: "chatgpt-token-sharing" });
  });
});

test("xAI's longer instructions still yield its device code; optional and hidden fields are left to OpenCode", async () => {
  const { using, fake } = await opencodeAuthFixture(withPlan("gitlab", { paste: false, outcome: "complete" }));
  await using(async (auth) => {
    const xai = recordedInteraction([]);
    await auth.login("xai", "oauth", xai);
    expect(xai.events).toEqual([{ kind: "device_code", userCode: "WXYZ-9876", verificationUri: opencodeOauthPlans.xai.url, expiresInSeconds: 600 }]);
    const gitlab = recordedInteraction([]);
    await auth.login("gitlab", "oauth", gitlab);
    expect(gitlab.prompts).toEqual([]);
    expect(connectBody(fake, "gitlab")).toEqual({ methodID: "pkce" });
  });
});

test("a wrong pasted code is refused without echoing it, and the attempt is cancelled", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const error = await rejectionOf(auth.login("poe", "oauth", recordedInteraction(["wrong-code-SECRET-777777"])));
    expect(error).toMatchObject({ name: "OpencodeProviderAuthError", kind: "rejected", status: 400 });
    expect(String(error)).toContain("[redacted]");
    expect(String(error)).not.toContain("wrong-code-SECRET-777777");
    expect(fakeList(fake, "cancelled")).toHaveLength(1);
  });
});

test("a code-mode attempt prompts for the code and completes with it", async () => {
  const { using } = await opencodeAuthFixture();
  await using(async (auth) => {
    const interaction = recordedInteraction([opencodeOauthPlans.poe.code]);
    const status = await auth.login("poe", "oauth", interaction);
    expect(status).toEqual({ providerId: "poe", configured: true, method: "oauth", label: "Poe" });
    expect(interaction.prompts).toMatchObject([{ kind: "manual_code", message: opencodeOauthPlans.poe.instructions }]);
    expect(interaction.events).toEqual([{ kind: "auth_url", url: opencodeOauthPlans.poe.url, instructions: opencodeOauthPlans.poe.instructions }]);
    expect(JSON.stringify(status)).not.toContain("SECRET");
  });
});

test("a paste-capable automatic attempt offers the code prompt and closes it when the callback wins", async () => {
  const { using } = await opencodeAuthFixture(withPlan("gitlab", { outcome: "complete" }));
  await using(async (auth) => {
    const interaction = recordedInteraction(["never"]);
    expect(await auth.login("gitlab", "oauth", interaction)).toMatchObject({ configured: true, method: "oauth" });
    expect(interaction.prompts).toHaveLength(1);
    expect(interaction.prompts[0]?.signal?.aborted).toBe(true);
  });
});

test.each([
  ["failed", { plan: { outcome: "failed", message: "access_denied: the person declined" }, kind: "rejected", words: "the person declined" }],
  ["expired", { plan: { outcome: "expired" }, kind: "expired", words: "expired" }],
] as const)("a %s attempt rejects and is cancelled", async (_name, { plan, kind, words }) => {
  const { using, fake } = await opencodeAuthFixture(withPlan("xai", plan));
  await using(async (auth) => {
    const error = await rejectionOf(auth.login("xai", "oauth", recordedInteraction([])));
    expect(error).toMatchObject({ name: "OpencodeProviderAuthError", kind });
    expect(String(error)).toContain(words);
    expect(fakeList(fake, "cancelled")).toHaveLength(1);
  });
});

test("the caller's abort rejects with its reason and cancels the attempt in OpenCode", async () => {
  const { using, fake } = await opencodeAuthFixture(withPlan("xai", { outcome: "pending" }));
  await using(async (auth) => {
    const controller = new AbortController();
    const interaction = recordedInteraction([], { signal: controller.signal });
    const login = rejectionOf(auth.login("xai", "oauth", interaction));
    await expect.poll(() => interaction.events.length).toBe(1);
    controller.abort(new Error("closed by the person"));
    expect(String(await login)).toContain("closed by the person");
    expect(fakeList(fake, "cancelled")).toHaveLength(1);
    expect(await auth.status("xai")).toMatchObject({ label: "xAI" });
  });
});

test("a sign-in nobody finishes times out and is cancelled; an aborted signal never starts one", async () => {
  const { using, fake } = await opencodeAuthFixture(withPlan("xai", { outcome: "pending" }));
  await using(async (auth) => {
    const unfinished = auth.login("xai", "oauth", recordedInteraction([]));
    expect(await rejectionOf(unfinished)).toMatchObject({ kind: "timed_out" });
    expect(fakeList(fake, "cancelled")).toHaveLength(1);
    const aborted = recordedInteraction([], { signal: AbortSignal.abort(new Error("already gone")) });
    const refused = await rejectionOf(auth.login("xai", "oauth", aborted));
    expect(String(refused)).toContain("already gone");
    expect(fakeCalls(fake).filter((call) => call.path === "/api/integration/xai/connect/oauth")).toHaveLength(1);
  }, { loginTimeoutMs: 200 });
});

test("a host that throws from onEvent ends the sign-in and cancels the attempt", async () => {
  const { using, fake } = await opencodeAuthFixture();
  await using(async (auth) => {
    const interaction = { onEvent: () => { throw new Error("cannot show it"); }, prompt: async () => "github.com" };
    const error = await rejectionOf(auth.login("github-copilot", "oauth", interaction));
    expect(String(error)).toContain("cannot show it");
    expect(fakeList(fake, "cancelled")).toHaveLength(1);
  });
});
