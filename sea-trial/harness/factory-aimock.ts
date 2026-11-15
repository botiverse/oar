import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import type { AimockEnv } from "./aimock.js";

/** The custom (BYOK) model droid lists for the fixture's settings: `custom:<displayName>-<index>`. */
export const FACTORY_AIMOCK_MODEL = "custom:Aimock-0";

/**
 * Factory droid's real stream-jsonrpc against a scripted OpenAI-compatible
 * provider: a custom model in an isolated `~/.factory/settings.json` runs
 * whole turns with no Factory login (docs/runtimes/factory.md#testing).
 * droid also asks the model for a session title on a session's first message.
 */
export async function startFactoryAimock(configure?: (mock: LLMock) => void): Promise<AimockEnv & { readonly cwd: string; readonly env: Readonly<Record<string, string>> }> {
  const mock = new LLMock({ port: 0 });
  if (configure === undefined) {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  } else { configure(mock); }
  await mock.start();
  const home = await mkdtemp(path.join(tmpdir(), "oar-factory-aimock-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd);
  await mkdir(path.join(home, ".factory"));
  await writeFile(path.join(home, ".factory", "settings.json"), JSON.stringify({
    customModels: [{ model: "aimock-model", displayName: "Aimock", baseUrl: `${mock.url}/v1`, apiKey: "aimock", provider: "generic-chat-completion-api", maxOutputTokens: 4096 }],
  }));
  return {
    cwd, mock, raw: [],
    env: { HOME: home, USERPROFILE: home, NO_PROXY: "*" },
    stop: async () => {
      await mock.stop();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}
