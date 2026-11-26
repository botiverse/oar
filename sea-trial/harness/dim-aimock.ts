import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { dimInstallation } from "../../packages/oar/src/community/dim/installation.js";
import type { AimockEnv } from "./aimock.js";
import { record } from "./trace.js";

export const DIM_AIMOCK_MODEL = "aimock-model";
const DAEMON_LOG_TAIL_BYTES = 256 * 1024;

/** The daemon's own log tail, kept in the trace: it is the only record of why the App Server went away. */
async function retainDaemonLog(home: string): Promise<void> {
  const log = await readFile(path.join(home, "rust", "daemon.log"), "utf8").catch((): null => null);
  if (log !== null) {
    record({ kind: "dim_daemon_log", truncated: log.length > DAEMON_LOG_TAIL_BYTES, tail: log.slice(-DAEMON_LOG_TAIL_BYTES) });
  }
}

/** Dim's aimock environment: the launch arguments and env every session takes. */
export interface DimAimockEnv extends AimockEnv {
  readonly env: Readonly<Record<string, string>>;
  readonly launchArgs: readonly string[];
}

/**
 * The real `dima acp` against a scripted OpenAI chat provider: a fresh Dim
 * home (`--home`) holding no account, and a `--model-config` file whose one
 * provider points at aimock with a dummy key. Dim's App Server daemon belongs
 * to that home; `stop` stops it with `dima daemon stop` before deleting the
 * home. A model-config provider is not a catalog provider, so these sessions
 * have no `model` config option (docs/runtimes/dim.md).
 */
export async function startDimAimock(configure: (mock: LLMock) => void): Promise<DimAimockEnv> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  const root = await mkdtemp(path.join(tmpdir(), "oar-dim-aimock-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  const modelConfig = path.join(root, "model.json");
  await writeFile(modelConfig, JSON.stringify({
    defaultModel: { providerId: "aimock", modelId: DIM_AIMOCK_MODEL },
    providers: [{
      id: "aimock",
      kind: "openai-chat",
      apiKeyEnv: "AIMOCK_API_KEY",
      baseUrl: `${mock.url}/v1`,
      models: [{ id: DIM_AIMOCK_MODEL, contextWindow: 128_000, maxOutputTokens: 4096, config: { maxTokens: 1024 } }],
    }],
  }));
  return {
    env: { AIMOCK_API_KEY: "aimock" },
    launchArgs: ["--home", home, "--model-config", modelConfig],
    mock,
    raw: [],
    stop: async () => {
      const installation = await dimInstallation();
      if (installation.kind === "available" && installation.via === "executable") {
        await new Promise<void>((resolve) => {
          execFile(installation.command, ["daemon", "stop", "--home", home], { timeout: 30_000 }, () => { resolve(); });
        });
      }
      await mock.stop();
      await retainDaemonLog(home);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    },
  };
}
