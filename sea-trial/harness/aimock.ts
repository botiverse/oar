import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";

export type { LLMock } from "@copilotkit/aimock";

/**
 * Backend setup for the aimock-backed instances: the REAL claude/codex
 * binaries run their REAL harnesses, only the model provider is a local
 * scripted server. Zero tokens, no login needed, deterministic-leaning.
 *
 * Gotchas learned in evaluation (2026-08-22):
 * - fixture string patterns are LITERAL; pass a RegExp for wildcards
 * - codex under a ChatGPT login ignores OPENAI_BASE_URL — it needs a
 *   CODEX_HOME config.toml declaring a custom provider with wire_api
 *   "responses" and apikey auth
 */
/**
 * Env mutation is process-scoped by design: sea-trial/main.ts is a dedicated
 * process that exits after the run, so setup dies with it; stop() reclaims
 * the on-disk pieces (server socket, temp CODEX_HOME).
 */
export interface AimockEnv {
  stop(): Promise<void>;
}

function baseFixtures(mock: LLMock): void {
  // Enough model behavior for every current behavior case: any prompt gets a
  // short completion. Cases assert framing/invariants, not content.
  // A little latency keeps the model pace realistic; instant replies are a
  // chaos-experiment configuration, not a behavior baseline.
  mock.onMessage(/[\s\S]*/u, { content: "ok" }, { latency: 80 });
}

export async function startClaudeAimock(
  configure: (mock: LLMock) => void = baseFixtures,
): Promise<AimockEnv> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  process.env.ANTHROPIC_BASE_URL = mock.url;
  process.env.ANTHROPIC_API_KEY = "aimock";
  return {
    stop: async () => {
      await mock.stop();
    },
  };
}

export async function startCodexAimock(
  configure: (mock: LLMock) => void = baseFixtures,
): Promise<AimockEnv> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  const codexHome = await mkdtemp(path.join(tmpdir(), "oar-codex-aimock-"));
  await writeFile(path.join(codexHome, "config.toml"), [
    'model = "gpt-5.1"',
    'model_provider = "aimock"',
    'preferred_auth_method = "apikey"',
    "",
    "[model_providers.aimock]",
    'name = "aimock"',
    `base_url = "${mock.url}/v1"`,
    'env_key = "OPENAI_API_KEY"',
    'wire_api = "responses"',
    "",
  ].join("\n"));
  process.env.CODEX_HOME = codexHome;
  process.env.OPENAI_API_KEY = "aimock";
  // Warm the fresh home once: codex's first run initializes its sqlite state
  // and installs system skills, and those writers race when instances cycle
  // fast (observed: "failed to initialize sqlite state runtime"). One
  // throwaway app-server does the heavy init; the suite then behaves like a
  // long-lived home.
  await warmCodexHome();
  return {
    stop: async () => {
      await mock.stop();
      await rm(codexHome, { recursive: true, force: true });
    },
  };
}

async function warmCodexHome(): Promise<void> {
  const child = spawn("codex", ["app-server", "--listen", "stdio://"], {
    env: process.env,
    stdio: ["pipe", "ignore", "ignore"],
  });
  child.stdin.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "oar-warmup", version: "0.0.0" }, capabilities: { experimentalApi: true } },
  })}\n`);
  await new Promise((resolve) => {
    setTimeout(resolve, 2500);
  });
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.on("exit", resolve);
  });
}
