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
  /** Session env overlay pointing the runtime at this scripted provider (absent for in-process pi, which is re-pointed via OAR_PI_AGENT_DIR at startup). */
  readonly env?: Readonly<Record<string, string>>;
  stop(): Promise<void>;
}

function baseFixtures(mock: LLMock): void {
  // Enough model behavior for every current behavior case: any prompt gets a
  // short completion. Cases assert framing/invariants, not content.
  // A little latency keeps the model pace realistic; instant replies are a
  // chaos-experiment configuration, not a behavior baseline.
  // Prompts mentioning "slow" get a LONG turn — the window the abort and
  // mid-turn-steer cases need. The two patterns are disjoint because aimock
  // picks among overlapping matches by turn position, not registration order.
  mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
  mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
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
  const { promise: responded, resolve: markResponded } = Promise.withResolvers<void>();
  child.onLine(() => {
    markResponded();
  });
  child.write(`${JSON.stringify({
    id: 1,
    method: "initialize",
    params: { clientInfo: { name: "oar-warmup", version: "0.0.0" }, capabilities: { experimentalApi: true } },
  })}\n`);
  // The initialize RESPONSE means state init finished; a short grace covers
  // post-init writers (skills install). Cap at the old blind 2.5s.
  const graced = (async (): Promise<void> => {
    await responded;
    await new Promise((resolve) => {
      setTimeout(resolve, 800);
    });
  })();
  await Promise.race([graced, new Promise((resolve) => {
    setTimeout(resolve, 2500);
  })]);
  child.kill();
  await child.exited;
}

export async function startPiAimock(
  configure: (mock: LLMock) => void = baseFixtures,
): Promise<AimockEnv> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  // pi is in-process: its model plane reads agentDir/models.json, not child
  // env — so the re-point is a temp agentDir pinned via OAR_PI_AGENT_DIR
  // (process-wide, set once at suite startup; recipe live-verified in
  // experiments/pi-aimock.ts).
  const agentDir = await mkdtemp(path.join(tmpdir(), "oar-pi-aimock-"));
  await writeFile(path.join(agentDir, "models.json"), JSON.stringify({
    providers: {
      aimock: {
        name: "aimock",
        baseUrl: mock.url,
        apiKey: "aimock",
        api: "anthropic-messages",
        models: [{
          id: "aimock-model",
          name: "aimock",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 200_000,
          maxTokens: 16_384,
        }],
      },
    },
  }));
  process.env.OAR_PI_AGENT_DIR = agentDir;
  // The Raft daemon injects its own PI_PACKAGE_DIR into shells on this
  // machine; it must not leak into the pi under test.
  delete process.env.PI_PACKAGE_DIR;
  return {
    stop: async () => {
      await mock.stop();
      await rm(agentDir, { recursive: true, force: true });
    },
  };
}
