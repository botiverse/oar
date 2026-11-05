import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import type { AimockEnv } from "./aimock.js";
import { startRawCapture, type RawProviderRequest } from "./raw-capture.js";

export const DSH_AIMOCK_ROUTE = "aimock/aimock-model";

/** Provider requests a test can answer with its own script; aimock has no shape for a held stream or a provider error sequence. */
export interface DshAimockOptions {
  readonly configure?: (mock: LLMock) => void;
  /** Extra rows for the isolated home patch, after the provider rows. */
  readonly homePatch?: readonly unknown[];
  /** Replaces the local provider: the route still points at this URL's `/v1`. */
  readonly providerUrl?: string;
  /** Model entries of the local route; defaults to one model with two reasoning levels. */
  readonly models?: readonly Readonly<Record<string, unknown>>[];
}

export interface DshAimock extends AimockEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly home: string;
  readonly raw: readonly RawProviderRequest[];
}

function baseFixtures(mock: LLMock): void {
  mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
  mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
}

/**
 * The real DSH with a fresh HOME and DSH_HOME whose home patch holds the only
 * model route: a synthetic key and a loopback URL. DeepSeek's own provider,
 * account and upload plugins are off, so nothing here reaches a real service.
 */
export async function startDshAimock(options: DshAimockOptions = {}): Promise<DshAimock> {
  const mock = new LLMock({ port: 0 });
  (options.configure ?? baseFixtures)(mock);
  await mock.start();
  const capture = await startRawCapture(mock.url);
  const root = await mkdtemp(path.join(tmpdir(), "oar-dsh-aimock-"));
  const home = path.join(root, "home");
  const dshHome = path.join(root, "dsh");
  const cwd = path.join(root, "project");
  await Promise.all([home, dshHome, cwd].map(async (directory) => { await mkdir(directory); }));
  const route = {
    api: "openai-completions", apiKeyEnv: "OAR_DSH_AIMOCK_KEY", baseURL: `${options.providerUrl ?? capture.url}/v1`,
    compat: { thinkingFormat: "deepseek" }, models: options.models ?? [{ id: "aimock-model", contextWindow: 128_000, maxTokens: 4096, reasoningEfforts: { low: "low", high: "high" } }],
  };
  await writeFile(path.join(dshHome, "cordis.patch.yml"), `${JSON.stringify([
    { id: "llm-deepseek", disabled: true },
    { id: "llm-deepseek-account", disabled: true },
    { id: "session-log-deepseek", disabled: true },
    { id: "plugin-package-inventory-deepseek", disabled: true },
    { id: "llm-pi-ai", config: { providers: { aimock: route } } },
    { id: "agent-default-model", config: { provider: "aimock", model: String(route.models[0]?.id) } },
    ...options.homePatch ?? [],
  ])}\n`);
  return {
    cwd, mock, home: dshHome, raw: capture.requests,
    env: { HOME: home, USERPROFILE: home, DSH_HOME: dshHome, DSH_TELEMETRY_DISABLED: "1", OAR_DSH_AIMOCK_KEY: "aimock-dsh-synthetic", NO_PROXY: "*" },
    stop: async () => { await capture.stop(); await mock.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); },
  };
}
