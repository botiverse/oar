import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { startRawCapture } from "./raw-capture.js";
import type { AimockEnv } from "./aimock.js";

/** Real CodeBuddy with an isolated native home and a local OpenAI-compatible provider. */
export async function startCodebuddyAimock(configure?: (mock: LLMock) => void): Promise<AimockEnv & { readonly cwd: string; readonly env: Readonly<Record<string, string>> }> {
  const mock = new LLMock({ port: 0 });
  mock.on({ predicate: (request) => request.messages.some((message) => message.role === "system" && typeof message.content === "string" && message.content.startsWith("Generate a concise, sentence-case title")) }, { content: "Local title" });
  if (configure === undefined) {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  } else { configure(mock); }
  await mock.start();
  const capture = await startRawCapture(mock.url);
  const home = await mkdtemp(path.join(tmpdir(), "oar-codebuddy-aimock-"));
  const cwd = path.join(home, "project");
  await mkdir(cwd);
  return {
    cwd, mock, raw: capture.requests,
    env: { HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: path.join(home, "config"), CODEBUDDY_API_KEY: "aimock-codebuddy-synthetic", CODEBUDDY_BASE_URL: `${capture.url}/v1`, DISABLE_TELEMETRY: "1", NO_PROXY: "*" },
    stop: async () => { await capture.stop(); await mock.stop(); await rm(home, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 }); },
  };
}
