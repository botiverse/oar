import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { LLMock } from "@copilotkit/aimock";
import { geminiToolResultsAsUser, startRawCapture, type RawCapture, type RequestRewrite } from "./raw-capture.js";
import type { AimockEnv } from "./aimock.js";

/*
 * The REAL opencode, kimi, grok and antigravity ACP agents (`<cli> acp`,
 * `grok agent stdio`, `agy_acp_server.par`)
 * against a scripted provider, as aimock.ts does for claude and codex: no
 * login, no tokens. Each environment is a fresh home (HOME, the XDG dirs and
 * the CLI's own) holding a provider entry that points at aimock with a dummy
 * key, so nothing on the machine can reach the CLI; its vars travel as the
 * session's SessionOptions.env, and `stop` deletes the home. Recipes were
 * measured against opencode 1.18.30, kimi 2.1.1, grok 1.0.46 and
 * agy_acp_server 1.3.0.
 * Each also takes the user's own configuration to write there (MCP servers
 * for a name clash), in the CLI's format.
 */

/** An ACP CLI's aimock environment: the shared shape, its env always given. */
export interface AcpAimockEnv extends AimockEnv {
  readonly env: Readonly<Record<string, string>>;
}

/** The fresh home's directories, as the env vars that name them. */
interface Home {
  readonly HOME: string;
  readonly XDG_CONFIG_HOME: string;
  readonly XDG_DATA_HOME: string;
  readonly XDG_STATE_HOME: string;
  readonly XDG_CACHE_HOME: string;
}

interface Started {
  readonly mock: LLMock;
  readonly url: string;
  readonly capture: RawCapture;
  readonly root: string;
  readonly base: Home;
}

/** aimock behind a raw-capture proxy, and a fresh home with the XDG dirs under it. */
async function startProvider(configure: (mock: LLMock) => void, prefix: string, forward?: RequestRewrite): Promise<Started> {
  const mock = new LLMock({ port: 0 });
  configure(mock);
  await mock.start();
  const capture = await startRawCapture(mock.url, undefined, forward);
  const root = await mkdtemp(path.join(tmpdir(), prefix));
  const base: Home = {
    HOME: path.join(root, "home"),
    XDG_CONFIG_HOME: path.join(root, "config"),
    XDG_DATA_HOME: path.join(root, "data"),
    XDG_STATE_HOME: path.join(root, "state"),
    XDG_CACHE_HOME: path.join(root, "cache"),
  };
  for (const dir of [base.HOME, base.XDG_CONFIG_HOME, base.XDG_DATA_HOME, base.XDG_STATE_HOME, base.XDG_CACHE_HOME]) {
    await mkdir(dir, { recursive: true });
  }
  return { mock, url: capture.url, capture, root, base };
}

function environment(started: Started, env: Readonly<Record<string, string>>): AcpAimockEnv {
  return {
    env: { ...started.base, ...env },
    mock: started.mock,
    raw: started.capture.requests,
    stop: async () => {
      await started.capture.stop();
      await started.mock.stop();
      await rm(started.root, { recursive: true, force: true });
    },
  };
}

/**
 * opencode: an `aimock` provider on the bundled `@ai-sdk/anthropic` in
 * `$XDG_CONFIG_HOME/opencode/opencode.json`, chosen as `model` and
 * `small_model`, with no models.dev fetch, autoupdate, LSP download, default
 * plugins or Claude Code import. opencode's first provider request is a
 * title for the session, offering no tools: the fixture answering any such
 * request goes first, so the scripted ones see only the agent's. `user` is
 * merged into that opencode.json (`{ mcp: {...} }`: the user's servers).
 */
export async function startOpencodeAimock(configure: (mock: LLMock) => void, user: Readonly<Record<string, unknown>> = {}): Promise<AcpAimockEnv> {
  const started = await startProvider((mock) => {
    mock.on({ predicate: (request) => (request.tools ?? []).length === 0 }, { content: "a title" });
    configure(mock);
  }, "oar-opencode-aimock-");
  const configDir = path.join(started.base.XDG_CONFIG_HOME, "opencode");
  await mkdir(configDir, { recursive: true });
  await writeFile(path.join(configDir, "opencode.json"), JSON.stringify({
    model: "aimock/aimock-model",
    small_model: "aimock/aimock-model",
    autoupdate: false,
    share: "disabled",
    provider: {
      aimock: {
        npm: "@ai-sdk/anthropic",
        name: "aimock",
        options: { baseURL: `${started.url}/v1`, apiKey: "aimock" },
        models: { "aimock-model": { name: "aimock", tool_call: true, reasoning: false, limit: { context: 200_000, output: 8192 } } },
      },
    },
    ...user,
  }));
  return environment(started, {
    OPENCODE_DISABLE_MODELS_FETCH: "1",
    OPENCODE_DISABLE_AUTOUPDATE: "1",
    OPENCODE_DISABLE_LSP_DOWNLOAD: "1",
    OPENCODE_DISABLE_DEFAULT_PLUGINS: "1",
    OPENCODE_DISABLE_CLAUDE_CODE: "1",
  });
}

/**
 * kimi: its env model override (`KIMI_MODEL_*`, an OpenAI chat completions
 * provider) under a fresh `KIMI_CODE_HOME`; `userMcp` becomes its `mcp.json`.
 */
export async function startKimiAimock(configure: (mock: LLMock) => void, userMcp?: Readonly<Record<string, unknown>>): Promise<AcpAimockEnv> {
  const started = await startProvider(configure, "oar-kimi-aimock-");
  const kimiHome = path.join(started.root, "kimi");
  await mkdir(kimiHome, { recursive: true });
  if (userMcp !== undefined) {
    await writeFile(path.join(kimiHome, "mcp.json"), JSON.stringify(userMcp));
  }
  return environment(started, {
    KIMI_CODE_HOME: kimiHome,
    KIMI_DISABLE_TELEMETRY: "1",
    KIMI_MODEL_NAME: "aimock-model",
    KIMI_MODEL_API_KEY: "aimock",
    KIMI_MODEL_BASE_URL: `${started.url}/v1`,
    KIMI_MODEL_PROVIDER_TYPE: "openai",
    KIMI_MODEL_CAPABILITIES: "",
    KIMI_CODE_MODEL_CATALOG_REFRESH_ON_START: "0",
  });
}

/**
 * grok: a custom model in `$GROK_HOME/config.toml` on chat completions with
 * a dummy key, which makes `initialize` offer the `xai.api_key` auth method
 * oar picks (no grok.com login); auto-update, telemetry and remote fetches off.
 * `userConfig` is appended to that file (TOML: a user's `[mcp_servers.*]`).
 */
export async function startGrokAimock(configure: (mock: LLMock) => void, userConfig = ""): Promise<AcpAimockEnv> {
  const started = await startProvider(configure, "oar-grok-aimock-");
  const grokHome = path.join(started.base.HOME, ".grok");
  await mkdir(grokHome, { recursive: true });
  await writeFile(path.join(grokHome, "config.toml"), [
    "[cli]", "auto_update = false", "use_leader = false",
    "[features]", "remote_fetch = false", "telemetry = false",
    "[telemetry]", "trace_upload = false",
    "[models]", 'default = "aimock-model"',
    "[model.aimock-model]", 'model = "aimock-model"', `base_url = "${started.url}/v1"`, 'api_key = "aimock"',
    'api_backend = "chat_completions"', "context_window = 128000", "max_completion_tokens = 1000",
    userConfig,
  ].join("\n"));
  return environment(started, { GROK_HOME: grokHome, GROK_DISABLE_AUTOUPDATER: "1", XAI_API_KEY: "aimock" });
}

/**
 * antigravity: the public Gemini API on a dummy `GEMINI_API_KEY`, which the
 * server uses only when its settings say `auth.type: "gemini-api-key"`
 * (`$GEMINI_HOME/antigravity-acp/settings.json`); its model harness
 * (`localharness_external`, beside the `.par`) honours
 * `GOOGLE_GEMINI_BASE_URL`. Tool results reach aimock as `user` contents
 * (`geminiToolResultsAsUser`). `userMcp` becomes `$GEMINI_HOME/config/mcp_config.json`.
 */
export async function startAntigravityAimock(configure: (mock: LLMock) => void, userMcp?: Readonly<Record<string, unknown>>): Promise<AcpAimockEnv> {
  const started = await startProvider(configure, "oar-antigravity-aimock-", geminiToolResultsAsUser);
  const geminiHome = path.join(started.base.HOME, ".gemini");
  await mkdir(path.join(geminiHome, "antigravity-acp"), { recursive: true });
  await mkdir(path.join(geminiHome, "config"), { recursive: true });
  await writeFile(path.join(geminiHome, "antigravity-acp", "settings.json"), JSON.stringify({ auth: { type: "gemini-api-key" } }));
  if (userMcp !== undefined) {
    await writeFile(path.join(geminiHome, "config", "mcp_config.json"), JSON.stringify(userMcp));
  }
  return environment(started, { GEMINI_HOME: geminiHome, GEMINI_API_KEY: "aimock", GOOGLE_GEMINI_BASE_URL: started.url });
}
