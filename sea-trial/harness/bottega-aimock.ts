import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import type { AimockEnv } from "./aimock.js";

export const BOTTEGA_AIMOCK_ROUTE = "aimock/aimock-model";

export interface BottegaAimock extends AimockEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly cwd: string;
  readonly home: string;
}

function baseFixtures(mock: LLMock): void {
  mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
  mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
}

/**
 * The real `bottega serve` with a fresh BOTTEGA_HOME whose settings hold the
 * only model route: an endpoint on a loopback URL with a synthetic key. No
 * key file and no other endpoint, so nothing here reaches a real service.
 * A scripted answer is text with no call, which ends a bottega turn.
 */
export async function startBottegaAimock(configure: (mock: LLMock) => void = baseFixtures): Promise<BottegaAimock> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  const root = await mkdtemp(path.join(tmpdir(), "oar-bottega-aimock-"));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  await Promise.all([home, cwd].map(async (directory) => { await mkdir(directory); }));
  await writeFile(path.join(home, "settings.json"), `${JSON.stringify({
    endpoints: [{ id: "aimock", name: "aimock", api: "openai-completions", baseUrl: `${mock.url}/v1`, models: [{ id: "aimock-model", context: 128_000, maxTokens: 4096, reasoning: true }] }],
    services: {},
    defaults: { provider: "aimock", model: "aimock-model" },
  })}\n`);
  return {
    cwd, mock, home, raw: [],
    env: { BOTTEGA_HOME: home, BOTTEGA_KEY_AIMOCK: "aimock-bottega-synthetic", NO_PROXY: "*", no_proxy: "*" },
    stop: async () => { await mock.stop(); await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); },
  };
}
