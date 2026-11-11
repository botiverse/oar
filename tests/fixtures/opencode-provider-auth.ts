import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { OpencodeProviderAuthFacade, type OpencodeFacadeOptions } from "../../packages/oar/src/runtimes/opencode/provider-auth-facade.js";
import { asRecordList, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLoginCli, reportedPid, type FakeCli } from "./login-fixtures.js";

/** Integrations shaped like opencode 2.2.7's `integration.list` entries (observed 2026-11-11), trimmed to what the provider-auth tests read. */
export function opencodeIntegrations(): Record<string, unknown>[] {
  return [
    { id: "azure", name: "Azure", methods: [
      { type: "key", label: "API key", form: [{ key: "resourceName", title: "Enter Azure Resource Name", required: true, type: "string", placeholder: "e.g. my-models" }] },
      { type: "env", names: ["AZURE_API_KEY", "AZURE_COGNITIVE_SERVICES_API_KEY"] },
    ], connections: [] },
    { id: "claude-agent", name: "Claude Agent", methods: [{ id: "claude-login", type: "external", label: "Claude Code login (claude auth login)" }], connections: [] },
    { id: "github-copilot", name: "GitHub Copilot", methods: [
      { type: "env", names: ["GITHUB_TOKEN"] },
      { id: "device", type: "oauth", label: "Login with GitHub Copilot", form: [
        { key: "deploymentType", title: "Select GitHub deployment type", required: true, type: "string", options: [
          { value: "github.com", label: "GitHub.com", description: "Public" },
          { value: "enterprise", label: "GitHub Enterprise", description: "Data residency or self-hosted" },
        ] },
        { key: "enterpriseUrl", title: "Enter your GitHub Enterprise URL or domain", required: true, when: [{ key: "deploymentType", op: "eq", value: "enterprise" }], type: "string", placeholder: "company.ghe.com" },
      ] },
    ], connections: [] },
    { id: "gitlab", name: "GitLab", methods: [
      { type: "key" },
      { id: "pkce", type: "oauth", label: "Login with GitLab (OAuth)", form: [{ key: "instanceUrl", title: "GitLab instance URL", type: "string", default: "https://gitlab.com" }] },
    ], connections: [] },
    { id: "openai", name: "OpenAI", methods: [
      { type: "key" },
      { type: "env", names: ["OPENAI_API_KEY"] },
      { id: "chatgpt-token-sharing", type: "oauth", label: "Sign in with ChatGPT" },
      { id: "chatgpt-headless", type: "oauth", label: "Codex device code (legacy)" },
    ], connections: [{ type: "credential", id: "cred_old_openai", label: "OpenAI", method: "oauth" }] },
    { id: "poe", name: "Poe", methods: [{ id: "browser", type: "oauth", label: "Login with Poe (browser)" }], connections: [] },
    { id: "xai", name: "xAI", methods: [
      { type: "key", label: "Manually enter API Key" },
      { type: "env", names: ["XAI_API_KEY"] },
      { id: "device", type: "oauth", label: "SuperGrok Subscription" },
    ], connections: [
      { type: "credential", id: "cred_old_xai_2", label: "xAI", method: "key" },
      { type: "credential", id: "cred_old_xai_1", label: "oar", method: "key" },
      { type: "env", name: "XAI_API_KEY" },
    ] },
    { id: "zai", name: "Z.AI", methods: [{ type: "key" }, { type: "env", names: ["ZHIPU_API_KEY"] }], connections: [{ type: "env", name: "ZHIPU_API_KEY" }] },
  ];
}

/** Per-integration OAuth attempt plans for the fake server; browser URLs carry 2.2.7's loopback `redirect_uri` shape. */
export const opencodeOauthPlans = {
  "github-copilot": { url: "https://github.com/login/device", instructions: "Enter code: ABCD-1234", outcome: "complete" },
  openai: { url: "https://auth.openai.com/api/accounts/authorize?client_id=dynamic_agent_client&response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A37807%2Fauth%2Fcallback&state=s", instructions: "Complete authorization in your browser. This window will close automatically.", outcome: "complete" },
  xai: { url: "https://accounts.x.ai/oauth2/device?user_code=WXYZ-9876", instructions: "Open https://accounts.x.ai/oauth2/device on any device and enter code: WXYZ-9876", outcome: "complete" },
  poe: { url: "https://poe.com/oauth/authorize?response_type=code&redirect_uri=http%3A%2F%2F127.0.0.1%3A38203%2Fcallback&state=s", instructions: "Paste the code shown after you authorize", mode: "code", code: "poe-code-SECRET-123456", outcome: "pending" },
  gitlab: { url: "https://gitlab.com/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A8080%2Fcallback&state=s", instructions: "Complete authorization in your browser.", paste: true, code: "gitlab-code-SECRET-654321", outcome: "pending" },
};

/** What the fake recorded: its calls, a list it kept, or one integration's connections. */
export function fakeCalls(fake: FakeCli): JsonRecord[] {
  return asRecordList(fake.read().calls);
}

export function fakeList(fake: FakeCli, key: string): unknown[] {
  const value: unknown = fake.read()[key];
  return Array.isArray(value) ? value.map((entry: unknown) => entry) : [];
}

export function fakeConnections(fake: FakeCli, id: string): unknown {
  return asRecordList(fake.read().integrations).find((entry) => entry.id === id)?.connections;
}

/**
 * Whether the fake server process the fake last reported still runs, read
 * from the test side: Windows ends it without running a signal handler, so
 * nothing the fake writes as it stops is a platform-independent signal.
 */
export function serverRunning(fake: FakeCli): boolean {
  try {
    process.kill(reportedPid(fake, "serverPid"), 0);
    return true;
  } catch {
    return false;
  }
}

/** The rejection of `promise`, for assertions on its fields and its text. */
export async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected a rejection");
}

const directories: string[] = [];

/**
 * Remove every fixture directory made since the last call (an afterEach
 * hook). Retried: on Windows a process that is still exiting (the host-death
 * test's watchdog, after its server is gone) keeps its working directory busy.
 */
export async function removeOpencodeAuthFixtures(): Promise<void> {
  await Promise.all(directories.splice(0).map(async (dir) => { await rm(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }); }));
}

export interface OpencodeAuthFixture {
  readonly fake: FakeCli;
  readonly installation: { readonly kind: "available"; readonly via: "executable"; readonly command: string; readonly version: string };
  readonly home: string;
  /** The facade with fast polling and a short idle period; options override. */
  readonly create: (options?: Partial<OpencodeFacadeOptions>) => Promise<OpencodeProviderAuthFacade>;
  /** Run `work` against a created facade, closing it afterwards. */
  readonly using: (work: (auth: OpencodeProviderAuthFacade) => Promise<void>, options?: Partial<OpencodeFacadeOptions>) => Promise<void>;
}

export async function opencodeAuthFixture(state: Record<string, unknown> = {}, version = "opencode v2.2.7"): Promise<OpencodeAuthFixture> {
  // The real path: the fake reports `process.cwd()`, which macOS resolves through /private.
  const made = await mkdtemp(path.join(tmpdir(), "oar-opencode-auth-"));
  const dir = await realpath(made);
  directories.push(dir);
  const home = path.join(dir, "home");
  await mkdir(home);
  const fake = fakeLoginCli({ dir, name: "opencode", script: "fake-opencode-serve.mjs", state: { integrations: opencodeIntegrations(), oauth: opencodeOauthPlans, ...state } });
  const installation = { kind: "available", via: "executable", command: fake.command, version } as const;
  const env = { ...process.env, HOME: home, USERPROFILE: home };
  const create = async (options: Partial<OpencodeFacadeOptions> = {}): Promise<OpencodeProviderAuthFacade> => OpencodeProviderAuthFacade.create({
    command: fake.command, env, cwd: home, timeoutMs: 10_000, loginTimeoutMs: 10_000, idleMs: 200, pollMs: 20, statusPollMs: 20, loopback: "allow", ...options,
  });
  return {
    fake,
    installation,
    home,
    create,
    using: async (work, options) => {
      const auth = await create(options);
      try {
        await work(auth);
      } finally {
        await auth.close();
      }
    },
  };
}
