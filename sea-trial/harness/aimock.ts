import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { resolveExecutable, spawnLineProcess } from "../../packages/oar/src/shared/executable/index.js";

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
 * No process.env mutation: each environment returns the vars its sessions
 * need (passed per-session via SessionOptions.env), so differently-scripted
 * providers can run concurrently. stop() reclaims the on-disk pieces
 * (server socket, temp CODEX_HOME).
 */
export interface AimockEnv {
  /** Session env overlay pointing the runtime at this scripted provider. */
  readonly env: Readonly<Record<string, string>>;
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
  return {
    env: { ANTHROPIC_BASE_URL: mock.url, ANTHROPIC_API_KEY: "aimock" },
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
  const env = { CODEX_HOME: codexHome, OPENAI_API_KEY: "aimock" };
  // Warm the fresh home once: codex's first run initializes its sqlite state
  // and installs system skills, and those writers race when instances cycle
  // fast (observed: "failed to initialize sqlite state runtime"). One
  // throwaway app-server does the heavy init; the suite then behaves like a
  // long-lived home.
  await warmCodexHome(env);
  return {
    env,
    stop: async () => {
      await mock.stop();
      try {
        // codex leaves background writers (plugins clone) briefly alive after
        // dispose; retry, and never fail a clean suite over teardown.
        await rm(codexHome, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch (error) {
        process.stderr.write(`codex home teardown left residue: ${String(error)}\n`);
      }
    },
  };
}

async function warmCodexHome(env: Readonly<Record<string, string>>): Promise<void> {
  // Resolve + spawn through the shared executable layer for the Windows
  // details (npm shims are .cmd files a raw spawn can't start). If codex is
  // not installed at all, skip warming — the suite itself will skip later.
  const command = resolveExecutable("codex");
  if (command === null) {
    return;
  }
  const child = spawnLineProcess(command, ["app-server", "--listen", "stdio://"], {
    env: { ...process.env, ...env },
  });
  try {
    await child.spawned;
  } catch {
    return;
  }
  child.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "oar-warmup", version: "0.0.0" }, capabilities: { experimentalApi: true } },
  })}\n`);
  await new Promise((resolve) => {
    setTimeout(resolve, 2500);
  });
  child.kill();
  await child.exited;
}
