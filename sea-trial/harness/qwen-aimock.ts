import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { startRawCapture } from "./raw-capture.js";
import type { AimockEnv } from "./aimock.js";

/** Qwen's real stream-json harness, with all home/project state isolated from local logins. */
export async function startQwenAimock(configure?: (mock: LLMock) => void): Promise<AimockEnv & { readonly cwd: string; readonly env: Readonly<Record<string, string>> }> {
  const mock = new LLMock({ port: 0 });
  if (configure === undefined) {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  } else { configure(mock); }
  await mock.start();
  const capture = await startRawCapture(mock.url);
  const home = await mkdtemp(path.join(tmpdir(), "oar-qwen-aimock-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd);
  await mkdir(path.join(home, ".qwen"));
  await writeFile(path.join(home, ".qwen", "settings.json"), JSON.stringify({
    modelProviders: { openai: [{ id: "gpt-5.1", name: "Local reasoning model", baseUrl: `${capture.url}/v1`, envKey: "OPENAI_API_KEY",
      capabilities: { reasoning: { efforts: ["low", "medium", "high"], defaultEffort: "medium" } } }] },
    security: { auth: { selectedType: "openai" } }, model: { name: "gpt-5.1" },
  }));
  return {
    cwd, mock, raw: capture.requests,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"), OPENAI_API_KEY: "aimock", OPENAI_BASE_URL: `${capture.url}/v1`, OPENAI_MODEL: "gpt-5.1", QWEN_CODE_SUPPRESS_YOLO_WARNING: "1", NO_PROXY: "*" },
    stop: async () => {
      await capture.stop(); await mock.stop();
      await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}
