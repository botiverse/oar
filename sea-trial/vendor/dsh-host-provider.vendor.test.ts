/*
 * SessionOptions.dshProvider against the real DeepSeek Harness: the declaration
 * exists in no user configuration (the isolated home patch holds no llm-pi-ai
 * row), OAR writes it into its own private invocation patch, and a real turn
 * reaches a scripted loopback gateway with the declared model and the
 * credential its environment variable NAME resolves to. Runs under
 * OAR_TEST=dsh-aimock, like the rest of the DSH vendor suite.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { dshRuntime, UnsupportedOptionError, type DshSessionProvider, type Session, type SessionOptions } from "../../packages/oar/src/index.js";
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { runTurn } from "./support/asserts.js";
import { dshEnabled } from "./support/dsh-fixture.js";
import { lastInput, startDshProvider, type DshProvider, type ProviderRequest, type Reply } from "./support/dsh-provider.js";

/** The credential's VALUE: it may reach the wire and must reach nothing else. */
const KEY = "sk-oar-host-provider-value-8f2a";
const KEY_NAME = "OAR_DSH_HOST_PROVIDER_KEY";
const PROVIDER = "oar-gw";
const MODEL = "gateway-model";

const say = (text: string): Reply => ({ kind: "say", text });

const declaration: DshSessionProvider = {
  id: PROVIDER,
  api: "openai-completions",
  baseUrl: "",
  apiKeyEnv: KEY_NAME,
  models: [{ id: MODEL, contextWindow: 128_000, maxTokens: 4096, reasoningEfforts: { low: "low", high: "high" } }],
};

interface HostProviderFixture {
  readonly provider: DshProvider;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly open: (options?: Partial<SessionOptions>) => Promise<Session>;
}

/**
 * A fresh HOME and DSH_HOME whose own patch holds NO llm-pi-ai row: only
 * DeepSeek's provider, account and upload plugins off, so the session's route
 * can only come from the declaration. The keyword here is that the fixture's
 * home never names a gateway.
 */
async function withHostProvider(
  script: (request: ProviderRequest) => Reply,
  body: (fixture: HostProviderFixture) => Promise<void>,
  homePatch: readonly unknown[] = [],
): Promise<void> {
  const provider = await startDshProvider(script);
  const root = await mkdtemp(path.join(tmpdir(), "oar-dsh-host-provider-"));
  const home = path.join(root, "home");
  const dshHome = path.join(root, "dsh");
  const cwd = path.join(root, "project");
  await Promise.all([home, dshHome, cwd].map(async (directory) => { await mkdir(directory); }));
  await writeFile(path.join(dshHome, "cordis.patch.yml"), `${JSON.stringify([
    { id: "llm-deepseek", disabled: true },
    { id: "llm-deepseek-account", disabled: true },
    { id: "session-log-deepseek", disabled: true },
    { id: "plugin-package-inventory-deepseek", disabled: true },
    ...homePatch,
  ])}\n`);
  const declared: DshSessionProvider = { ...declaration, baseUrl: `${provider.url}/v1` };
  const env = { HOME: home, USERPROFILE: home, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1", NO_PROXY: "*" };
  const sessions: Session[] = [];
  try {
    const installation = await dshRuntime.installation();
    assert.ok(installation.kind === "available", `DSH is not installed: ${JSON.stringify(installation)}`);
    await body({
      provider, cwd, env,
      open: async (options = {}) => {
        const session = await dshRuntime.session(installation, { cwd, ...options, env: { ...env, ...options.env }, dshProvider: options.dshProvider ?? declared });
        sessions.push(session);
        return session;
      },
    });
  } finally {
    await Promise.allSettled(sessions.map(async (session) => { await session.dispose(); }));
    await provider.stop();
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
}

/** The private `--patch` files this host wrote for the declared provider, as DSH was handed them. */
async function privatePatches(): Promise<readonly string[]> {
  const entries = await readdir(tmpdir()).catch((): string[] => []);
  const found: string[] = [];
  for (const entry of entries) {
    if (!entry.startsWith("oar-dsh-")) { continue; }
    const text = await readFile(path.join(tmpdir(), entry, "patch.json"), "utf8").catch((): string => "");
    if (text.includes(PROVIDER)) { found.push(text); }
  }
  return found;
}

describe.skipIf(!dshEnabled)("DSH host-declared provider", () => {
  test("a real turn reaches the declared gateway with its model and the key its env NAME holds", async () => {
    await withHostProvider(() => say("gateway-ok"), async ({ provider, open }) => {
      const session = await open({ model: MODEL, effort: "high", env: { [KEY_NAME]: KEY } });
      expect(await runTurn(session, "HOST-PROVIDER-HELLO")).toEqual({ kind: "completed" });
      const request = provider.requests.find((value) => lastInput(value).includes("HOST-PROVIDER-HELLO"));
      assert.ok(request !== undefined, `no request reached the declared gateway: ${JSON.stringify(provider.requests.map((value) => lastInput(value)))}`);
      expect(request.body.model).toBe(MODEL);
      expect(request.headers.authorization).toBe(`Bearer ${KEY}`);
      // DSH's own report: the declaration is the session's route, and the declared level applied.
      const opened = nativeOfOpened(session);
      expect(asRecord(opened.model)).toMatchObject({ provider: PROVIDER, model: MODEL, reasoningEffort: "high" });
      // The key is on the wire and nowhere in what OAR records.
      const recorded = JSON.stringify(session.records());
      expect(recorded).not.toContain(KEY);
      expect(recorded).not.toContain(`${KEY_NAME}=${KEY}`);
      // ... and the private patch names the variable, never its value.
      const patches = await privatePatches();
      expect(patches.length).toBeGreaterThan(0);
      for (const patch of patches) {
        expect(patch).toContain(KEY_NAME);
        expect(patch).not.toContain(KEY);
      }
    });
  }, 120_000);

  test("a resume with no model given keeps the declared route", async () => {
    await withHostProvider(() => say("gateway-ok"), async ({ provider, open }) => {
      const first = await open({ model: MODEL, env: { [KEY_NAME]: KEY } });
      expect(await runTurn(first, "BEFORE-RESUME")).toEqual({ kind: "completed" });
      const id = first.id;
      await first.dispose();
      const resumed = await open({ resume: id, env: { [KEY_NAME]: KEY } });
      expect(await runTurn(resumed, "AFTER-RESUME")).toEqual({ kind: "completed" });
      const request = provider.requests.find((value) => lastInput(value).includes("AFTER-RESUME"));
      assert.ok(request !== undefined, "the resumed turn did not reach the declared gateway");
      expect(request.body.model).toBe(MODEL);
      expect(asRecord(nativeOfOpened(resumed).model)).toMatchObject({ provider: PROVIDER, model: MODEL });
    });
  }, 120_000);

  test("a profile that disables llm-pi-ai refuses the declaration before any request", async () => {
    await withHostProvider(() => say("gateway-ok"), async ({ provider, open }) => {
      const failed = await open({ model: MODEL, env: { [KEY_NAME]: KEY } }).catch((error: unknown) => error);
      expect(failed).toBeInstanceOf(UnsupportedOptionError);
      expect(failed).toMatchObject({ option: "dshProvider" });
      expect(provider.requests).toHaveLength(0);
    }, [{ id: "llm-pi-ai", disabled: true }]);
  }, 120_000);
});

/** The `dsh/opened` native payload: DSH's own report of the route it runs. */
function nativeOfOpened(session: Session): JsonRecord {
  const frame = session.records().findLast((record) => record.kind === "frame" && record.body.type === "dsh/opened");
  const opened = frame?.kind === "frame" ? asRecord(frame.body.native) : null;
  assert.ok(opened !== null, "the session did not report dsh/opened");
  return opened;
}
