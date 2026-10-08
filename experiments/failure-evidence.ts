/**
 * What each runtime reports when a session fails for a common cause (oar#227),
 * the evidence behind docs/spec/runtime-matrix.md#failure-evidence. The REAL
 * claude, codex, pi (SDK), opencode, kimi, grok and antigravity run against a
 * scripted provider (aimock, sea-trial/harness) that answers with the
 * provider's documented error for the cause; a missing login is a fresh home
 * with no credential. cursor runs in process against Cursor's service with no
 * key or a made-up one only. No real account is used and nothing is spent.
 * Each case records the open (`session()`), one prompted turn, and every frame
 * after the prompt, as JSON.
 *
 * Run: pnpm tsx experiments/failure-evidence.ts <runtime> [case ...] [--after-tool] [--fast-retry] [--out <dir>] [--timeout <s>]
 *   --after-tool  the turn's first request runs a tool; the failure answers the request after it
 *   --fast-retry  lower the runtime's own retries (claude CLAUDE_CODE_MAX_RETRIES=1, codex
 *                 request/stream_max_retries=1) so a retried failure reports within the timeout
 * antigravity needs OAR_ANTIGRAVITY_BIN; cursor sets HOME and CURSOR_API_KEY process-wide, so run
 * it in a process of its own.
 *
 * Observed 2026-10-08 (claude 2.1.292, codex 0.160.1, pi SDK 1.0.4, opencode 1.18.30, kimi 2.1.1,
 * grok 1.0.46, antigravity ACP server 1.3.0, @cursor/sdk 1.0.36): see the matrix.
 */
/* oxlint-disable import/max-dependencies, eslint/require-await -- one probe drives every runtime; the harness starters pass their promises through */
import { appendFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { LLMock } from "@copilotkit/aimock";
import type { InstallationProbe } from "../packages/oar/src/contracts/installation.js";
import type { RawEvent, ResponseBody, Session, SessionOptions, StartSession, TurnOutcome } from "../packages/oar/src/contracts/session.js";
import {
  antigravityInstallation, antigravitySession, awaitTurnEnd, claudeInstallation, claudeSession, codexInstallation, codexSession,
  createCursorRuntime, cursorInstallation, grokInstallation, grokSession, kimiInstallation, kimiSession, opencodeInstallation,
  opencodeSession, piInstallation, piSession,
} from "../packages/oar/src/index.js";
import { asRecord, parseJson } from "../packages/oar/src/shared/json.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "../sea-trial/harness/aimock.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock } from "../sea-trial/harness/aimock-acp.js";

type Family = "anthropic" | "openai" | "gemini";
type Env = Readonly<Record<string, string>>;

interface ErrorReply {
  readonly error: { readonly message: string; readonly type?: string; readonly code?: string };
  readonly status: number;
}

/** The provider's answer for each cause; `model_unentitled` keeps the configured model and gets `model_unknown`'s. */
const REPLIES: Readonly<Record<Family, Readonly<Partial<Record<string, ErrorReply>>>>> = {
  anthropic: {
    invalid_key: { status: 401, error: { type: "authentication_error", message: "invalid x-api-key" } },
    model_unknown: { status: 404, error: { type: "not_found_error", message: "model: oar-missing-model" } },
    rate_limited: { status: 429, error: { type: "rate_limit_error", message: "This request would exceed the rate limit for your organization of 50 requests per minute." } },
    // A spend limit the organization set (documented as a 400).
    usage_limit: { status: 400, error: { type: "invalid_request_error", message: "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC." } },
    billing: { status: 400, error: { type: "invalid_request_error", message: "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits." } },
    billing_402: { status: 402, error: { type: "billing_error", message: "This organization has a billing issue." } },
    server_error: { status: 500, error: { type: "api_error", message: "Internal server error" } },
    overloaded: { status: 529, error: { type: "overloaded_error", message: "Overloaded" } },
    context_too_large: { status: 400, error: { type: "invalid_request_error", message: "prompt is too long: 250000 tokens > 200000 maximum" } },
  },
  openai: {
    invalid_key: { status: 401, error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided: aimock. You can find your API key at https://platform.openai.com/account/api-keys." } },
    model_unknown: { status: 404, error: { type: "invalid_request_error", code: "model_not_found", message: "The model `oar-missing-model` does not exist or you do not have access to it." } },
    rate_limited: { status: 429, error: { type: "requests", code: "rate_limit_exceeded", message: "Rate limit reached for aimock-model in organization org-oar on requests per min (RPM): Limit 3, Used 3, Requested 1. Please try again in 20s." } },
    usage_limit: { status: 429, error: { type: "requests", code: "organization_usage_limit_exceeded", message: "Organization usage limit reached" } },
    // The ChatGPT backend's (a codex plan), not the API's.
    plan_usage_limit: { status: 429, error: { type: "usage_limit_reached", message: "The usage limit has been reached" } },
    billing: { status: 429, error: { type: "insufficient_quota", code: "credit_balance_exhausted", message: "Credit balance exhausted" } },
    // The code the API used before credit_balance_exhausted.
    billing_quota: { status: 429, error: { type: "insufficient_quota", code: "insufficient_quota", message: "You exceeded your current quota, please check your plan and billing details." } },
    server_error: { status: 500, error: { type: "server_error", message: "The server had an error while processing your request. Sorry about that!" } },
    overloaded: { status: 503, error: { type: "server_error", code: "server_is_overloaded", message: "The server is overloaded or not ready yet." } },
    context_too_large: { status: 400, error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model. Please adjust your input and try again." } },
  },
  gemini: {
    invalid_key: { status: 400, error: { type: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } },
    model_unknown: { status: 404, error: { type: "NOT_FOUND", message: "models/oar-missing-model is not found for API version v1beta, or is not supported for generateContent." } },
    rate_limited: { status: 429, error: { type: "RESOURCE_EXHAUSTED", message: "Resource has been exhausted (e.g. check quota)." } },
    usage_limit: { status: 429, error: { type: "RESOURCE_EXHAUSTED", message: "You exceeded your current quota, please check your plan and billing details." } },
    billing: { status: 400, error: { type: "FAILED_PRECONDITION", message: "Gemini API free tier is not available in your country. Please enable billing on your project in Google AI Studio." } },
    server_error: { status: 500, error: { type: "INTERNAL", message: "An internal error has occurred. Please retry or report in https://developers.generativeai.google/guide/troubleshooting" } },
    overloaded: { status: 503, error: { type: "UNAVAILABLE", message: "The model is overloaded. Please try again later." } },
    context_too_large: { status: 400, error: { type: "INVALID_ARGUMENT", message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048576)." } },
  },
};

/** One server-sent event. */
function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The Responses API failing inside a 200 stream. */
function responseFailed(code: string, message: string): string {
  return sse("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_oar", object: "response", status: "in_progress", output: [] } })
    + sse("response.failed", { type: "response.failed", sequence_number: 1, response: { id: "resp_oar", object: "response", status: "failed", output: [], error: { code, message } } });
}

/** The Messages API failing inside a 200 stream: its `error` event. */
function anthropicStreamError(type: string, message: string): string {
  return sse("message_start", { type: "message_start", message: { id: "msg_oar", type: "message", role: "assistant", model: "aimock-model", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
    + sse("error", { type: "error", error: { type, message } });
}

/** Failures inside a stream, by case; each replaces a streamed answer whole. */
const STREAMS: Readonly<Record<Family, Readonly<Partial<Record<string, string>>>>> = {
  anthropic: {
    stream_overloaded: anthropicStreamError("overloaded_error", "Overloaded"),
    stream_server_error: anthropicStreamError("api_error", "Internal server error"),
  },
  openai: {
    stream_overloaded: responseFailed("server_is_overloaded", "The server is overloaded or not ready yet."),
    stream_rate_limited: responseFailed("rate_limit_exceeded", "Rate limit reached for aimock-model. Please try again in 1s."),
    stream_quota: responseFailed("insufficient_quota", "You exceeded your current quota, please check your plan and billing details."),
    stream_context: responseFailed("context_length_exceeded", "Your input exceeds the context window of this model. Please adjust your input and try again."),
    stream_usage_not_included: responseFailed("usage_not_included", "Your plan does not include usage of this model."),
  },
  gemini: {},
};

const CASES: readonly string[] = [
  "missing_login", "invalid_key", "model_unknown", "model_unentitled", "rate_limited", "usage_limit", "plan_usage_limit", "billing",
  "billing_402", "billing_quota", "server_error", "overloaded", "context_too_large", "stream_overloaded", "stream_server_error",
  "stream_rate_limited", "stream_quota", "stream_context", "stream_usage_not_included",
];

/** What the session gets for one case, and how to take it down. */
interface Setup {
  readonly env?: Env;
  readonly model?: string;
  /** The provider requests in order, where the provider rewrites its answers. */
  readonly requests?: () => readonly unknown[];
  readonly stop: () => Promise<void>;
}

interface Runtime {
  readonly family: Family;
  readonly session: StartSession;
  readonly installation: InstallationProbe;
  /** The unknown model as this runtime spells a model id. */
  readonly unknownModel?: string;
  /** A tool call the model makes in `--after-tool` runs. */
  readonly tool?: { readonly name: string; readonly arguments: string };
  readonly start?: (configure: (mock: LLMock) => void) => Promise<AimockEnv>;
  /** The same, with every answer body passed through `rewrite` (failures inside a stream). */
  readonly startRewritten?: (configure: (mock: LLMock) => void, rewrite: (body: string) => string) => Promise<AimockEnv>;
  /** Lower the runtime's own retries (`--fast-retry`): env to add once the provider started. */
  readonly fastRetry?: (env: AimockEnv) => Env | Promise<Env>;
  /** A home with no credential. */
  readonly missingLogin: () => Promise<Setup>;
}

async function freshDir(prefix: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), prefix));
}

async function nothing(): Promise<void> {
  // Nothing to take down.
}

/** The harness's env (the ACP ones always give one). */
function envOf(env: AimockEnv): Env {
  return env.env ?? {};
}

/** opencode's config without the provider's key. */
async function dropOpencodeKey(file: string): Promise<void> {
  const config = asRecord(parseJson(await readFile(file, "utf8"))) ?? {};
  const provider = asRecord(asRecord(config.provider)?.aimock) ?? {};
  const { apiKey: _key, ...options } = asRecord(provider.options) ?? {};
  await writeFile(file, JSON.stringify({ ...config, provider: { aimock: { ...provider, options } } }));
}

const runtimes: Readonly<Partial<Record<string, Runtime>>> = {
  claude: {
    family: "anthropic", session: claudeSession, installation: claudeInstallation,
    tool: { name: "Bash", arguments: JSON.stringify({ command: "echo hi" }) },
    start: async (configure) => startClaudeAimock(configure),
    startRewritten: async (configure, rewrite) => startClaudeAimock(configure, { rewriteResponse: rewrite }),
    fastRetry: () => ({ CLAUDE_CODE_MAX_RETRIES: "1" }),
    missingLogin: async () => {
      const dir = await freshDir("oar-fail-claude-");
      return { env: { CLAUDE_CONFIG_DIR: dir, HOME: dir, ANTHROPIC_API_KEY: "", ANTHROPIC_AUTH_TOKEN: "", CLAUDE_CODE_OAUTH_TOKEN: "" }, stop: nothing };
    },
  },
  codex: {
    family: "openai", session: codexSession, installation: codexInstallation,
    tool: { name: "exec_command", arguments: JSON.stringify({ cmd: "echo hi" }) },
    start: async (configure) => startCodexAimock(configure),
    startRewritten: async (configure, rewrite) => startCodexAimock(configure, { rewriteResponse: rewrite }),
    fastRetry: async (env) => {
      // config.toml ends with the [model_providers.aimock] table.
      await appendFile(path.join(envOf(env).CODEX_HOME ?? "", "config.toml"), "request_max_retries = 1\nstream_max_retries = 1\n");
      return {};
    },
    missingLogin: async () => {
      // The default provider with no login: codex sends the request to api.openai.com, which answers 401.
      const dir = await freshDir("oar-fail-codex-");
      return { env: { CODEX_HOME: dir, OPENAI_API_KEY: "", CODEX_API_KEY: "" }, stop: nothing };
    },
  },
  pi: {
    family: "anthropic", session: piSession, installation: piInstallation, unknownModel: "aimock/oar-missing-model",
    tool: { name: "bash", arguments: JSON.stringify({ command: "echo hi" }) },
    start: async (configure) => startPiAimock(configure),
    startRewritten: async (configure, rewrite) => startPiAimock(configure, { rewriteResponse: rewrite }),
    missingLogin: async () => {
      // pi is in process: an agent dir with no models.json and no key.
      process.env.OAR_PI_AGENT_DIR = await freshDir("oar-fail-pi-");
      delete process.env.PI_PACKAGE_DIR;
      return { stop: nothing };
    },
  },
  opencode: {
    family: "anthropic", session: opencodeSession, installation: opencodeInstallation, unknownModel: "aimock/oar-missing-model",
    start: async (configure) => startOpencodeAimock(configure),
    missingLogin: async () => {
      // The provider entry without its key, and the provider's answer to a request without one.
      // (With no provider at all, opencode 1.18.30 answers from its own hosted model: no failure.)
      const env = await startOpencodeAimock((mock) => {
        mock.onMessage(/[\s\S]*/u, { status: 401, error: { type: "authentication_error", message: "x-api-key header is required" } });
      });
      await dropOpencodeKey(path.join(envOf(env).XDG_CONFIG_HOME ?? "", "opencode", "opencode.json"));
      return { env: { ...envOf(env), ANTHROPIC_API_KEY: "" }, stop: async () => env.stop() };
    },
  },
  kimi: {
    family: "openai", session: kimiSession, installation: kimiInstallation,
    start: async (configure) => startKimiAimock(configure),
    missingLogin: async () => {
      // The fresh home without the env model: nothing configured, nothing signed in.
      const env = await startKimiAimock(() => {});
      const { KIMI_MODEL_NAME: _n, KIMI_MODEL_API_KEY: _k, KIMI_MODEL_BASE_URL: _u, KIMI_MODEL_PROVIDER_TYPE: _t, KIMI_MODEL_CAPABILITIES: _c, ...rest } = envOf(env);
      return { env: rest, stop: async () => env.stop() };
    },
  },
  grok: {
    family: "openai", session: grokSession, installation: grokInstallation,
    start: async (configure) => startGrokAimock(configure),
    missingLogin: async () => {
      const env = await startGrokAimock(() => {});
      return { env: { ...envOf(env), GROK_HOME: await freshDir("oar-fail-grok-"), XAI_API_KEY: "" }, stop: async () => env.stop() };
    },
  },
  antigravity: {
    family: "gemini", session: antigravitySession, installation: antigravityInstallation,
    start: async (configure) => startAntigravityAimock(configure),
    missingLogin: async () => {
      const env = await startAntigravityAimock(() => {});
      return { env: { ...envOf(env), GEMINI_HOME: await freshDir("oar-fail-antigravity-"), GEMINI_API_KEY: "" }, stop: async () => env.stop() };
    },
  },
  // In process, against Cursor's service: only what needs no account.
  cursor: {
    family: "anthropic", session: createCursorRuntime({ sdk: async () => import("@cursor/sdk") }).session, installation: cursorInstallation,
    missingLogin: async () => {
      process.env.HOME = await freshDir("oar-fail-cursor-");
      delete process.env.CURSOR_API_KEY;
      return { stop: nothing };
    },
  },
};

interface Options {
  readonly afterTool: boolean;
  readonly fastRetry: boolean;
  readonly timeoutMs: number;
}

interface Target {
  readonly name: string;
  readonly runtime: Runtime;
  readonly testCase: string;
  readonly options: Options;
}

/** A provider whose streamed answers fail inside the stream. */
async function streamFailure({ runtime, options }: Target, streamed: string): Promise<Setup | null> {
  if (runtime.startRewritten === undefined) { return null; }
  // Only streamed answers carry the failure; a plain JSON answer passes as it was.
  const started = await runtime.startRewritten((mock) => {
    mock.onMessage(/[\s\S]*/u, { content: "ok" });
  }, (body) => (/^(?:event|data):/u.test(body.trimStart()) ? streamed : body));
  const extra = options.fastRetry && runtime.fastRetry !== undefined ? await runtime.fastRetry(started) : {};
  return {
    env: { ...envOf(started), ...extra },
    requests: () => started.raw.map((request) => ({ path: request.path, stream: asRecord(request.body)?.stream })),
    stop: async () => started.stop(),
  };
}

/** A provider answering every model request (or every one after a tool call) with `reply`. */
async function httpFailure({ runtime, testCase, options }: Target, reply: ErrorReply): Promise<Setup | null> {
  if (runtime.start === undefined) { return null; }
  const started = await runtime.start((mock) => {
    if (options.afterTool && runtime.tool !== undefined) {
      mock.on({ hasToolResult: false }, { toolCalls: [runtime.tool] });
      mock.on({ hasToolResult: true }, reply);
    } else {
      mock.onMessage(/[\s\S]*/u, reply);
    }
  });
  const extra = options.fastRetry && runtime.fastRetry !== undefined ? await runtime.fastRetry(started) : {};
  return {
    env: { ...envOf(started), ...extra },
    ...(testCase === "model_unknown" ? { model: runtime.unknownModel ?? "oar-missing-model" } : {}),
    stop: async () => started.stop(),
  };
}

/** What one case runs against; null where this runtime cannot be put in it. */
async function setUp(target: Target): Promise<Setup | null> {
  const { name, runtime, testCase } = target;
  if (testCase === "missing_login") {
    return runtime.missingLogin();
  }
  if (name === "cursor") {
    if (testCase !== "invalid_key") { return null; }
    process.env.HOME = await freshDir("oar-fail-cursor-");
    process.env.CURSOR_API_KEY = "crsr_oar_probe_not_a_real_key";
    return { stop: nothing };
  }
  const streamed = STREAMS[runtime.family][testCase];
  if (streamed !== undefined) {
    return streamFailure(target, streamed);
  }
  const reply = REPLIES[runtime.family][testCase === "model_unentitled" ? "model_unknown" : testCase];
  return reply === undefined ? null : httpFailure(target, reply);
}

function serializeError(error: unknown): unknown {
  if (!(error instanceof Error)) { return { thrown: String(error) }; }
  return {
    name: error.name, constructor: error.constructor.name, message: error.message, ...Object.fromEntries(Object.entries(error)),
    ...(error.cause === undefined ? {} : { cause: serializeError(error.cause) }),
  };
}

const ERRORISH = /error|status|code|retry|fail|denied|auth|limit|quota|overload|login/iu;

/** The records after `afterSeq`: every frame, without the bodies of long ones that say nothing about a failure (claude's init). */
function evidence(records: readonly RawEvent[], afterSeq: number): unknown[] {
  return records.filter((record) => record.seq > afterSeq).map((record): unknown => {
    if (record.kind !== "frame") {
      return { seq: record.seq, [record.kind]: record.body };
    }
    const native = JSON.stringify(record.body.native);
    const events = record.body.events.map((event) => event.kind);
    return native.length < 4000 || ERRORISH.test(native)
      ? { seq: record.seq, frame: record.body.type, events, native: record.body.native }
      : { seq: record.seq, frame: record.body.type, events };
  });
}

interface Observation {
  readonly runtime: string;
  readonly case: string;
  readonly afterTool: boolean;
  readonly fastRetry: boolean;
  skipped?: string;
  version?: string | undefined;
  open?: { readonly ok: boolean; readonly ms: number; readonly error?: unknown };
  prompt?: ResponseBody;
  turn?: { readonly outcome: TurnOutcome | { readonly kind: "no turn end" }; readonly ms: number };
  evidence?: unknown[];
  requests?: readonly unknown[] | undefined;
  threw?: unknown;
  allRecords?: number;
}

/** Prompt once and wait for the turn's end, at most `timeoutMs`. */
async function promptOnce(session: Session, observation: Observation, timeoutMs: number): Promise<void> {
  const started = Date.now();
  const result = await session.prompt("Say hello.");
  observation.prompt = result.response.body;
  if (result.response.body.kind === "accepted") {
    const noEnd: { readonly kind: "no turn end" } = { kind: "no turn end" };
    const outcome = await Promise.race([awaitTurnEnd(session, result.request.seq), delay(timeoutMs, noEnd, { ref: false })]);
    observation.turn = { outcome, ms: Date.now() - started };
  }
  observation.evidence = evidence(session.records(), result.request.seq - 1);
}

/** Open, prompt once, and record what the runtime said. */
async function openAndPrompt(target: Target, setup: Setup, observation: Observation): Promise<void> {
  const installation = await target.runtime.installation();
  if (installation.kind !== "available") { throw new Error(`${target.name} not available: ${installation.kind}`); }
  observation.version = installation.via === "executable" ? installation.version : undefined;
  const sessionOptions: SessionOptions = {
    cwd: await freshDir("oar-fail-cwd-"),
    ...(setup.env === undefined ? {} : { env: setup.env }),
    ...(setup.model === undefined ? {} : { model: setup.model }),
  };
  const opened = Date.now();
  let session: Session | null = null;
  try {
    session = await target.runtime.session(installation, sessionOptions);
  } catch (error) {
    observation.open = { ok: false, ms: Date.now() - opened, error: serializeError(error) };
    return;
  }
  observation.open = { ok: true, ms: Date.now() - opened };
  try {
    await promptOnce(session, observation, target.options.timeoutMs);
  } finally {
    observation.allRecords = session.records().length;
    await session.dispose().catch(nothing);
  }
}

async function observe(target: Target): Promise<Observation> {
  const observation: Observation = { runtime: target.name, case: target.testCase, afterTool: target.options.afterTool, fastRetry: target.options.fastRetry };
  const setup = await setUp(target);
  if (setup === null) {
    observation.skipped = "no reply for this runtime's provider, or it would need a real account";
    return observation;
  }
  try {
    await openAndPrompt(target, setup, observation);
  } catch (error) {
    observation.threw = serializeError(error);
  } finally {
    await setup.stop();
    observation.requests = setup.requests?.();
  }
  return observation;
}

/** One line per case. */
function summary(observation: Observation): string {
  const head = `${observation.runtime} ${observation.case}${observation.afterTool ? " [after tool]" : ""}${observation.fastRetry ? " [fast retry]" : ""}`;
  if (observation.skipped !== undefined) { return `${head} | skipped: ${observation.skipped}`; }
  if (observation.threw !== undefined) { return `${head} | threw: ${JSON.stringify(observation.threw).slice(0, 200)}`; }
  if (observation.open?.ok === false) { return `${head} | open: REJECT ${JSON.stringify(observation.open.error).slice(0, 200)}`; }
  if (observation.prompt !== undefined && observation.prompt.kind !== "accepted") { return `${head} | open: ok | prompt: ${JSON.stringify(observation.prompt).slice(0, 200)}`; }
  return `${head} | open: ok | turn: ${JSON.stringify(observation.turn?.outcome).slice(0, 220)} (${String(observation.turn?.ms)} ms)`;
}

/** Take `--name value` out of `args`. */
function flag(args: string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args.splice(index, 2)[1];
}

/** Take `--name` out of `args`; whether it was there. */
function toggle(args: string[], name: string): boolean {
  const index = args.indexOf(name);
  if (index !== -1) { args.splice(index, 1); }
  return index !== -1;
}

const args = process.argv.slice(2);
const options: Options = {
  afterTool: toggle(args, "--after-tool"),
  fastRetry: toggle(args, "--fast-retry"),
  timeoutMs: Number(flag(args, "--timeout") ?? "150") * 1000,
};
const out = flag(args, "--out") ?? path.join(tmpdir(), "oar-failure-evidence");
const [name = "", ...requested] = args;
const runtime = runtimes[name];
if (runtime === undefined) {
  console.error(`usage: failure-evidence.ts <${Object.keys(runtimes).join("|")}> [case ...] [--after-tool] [--fast-retry] [--out dir] [--timeout s]`);
  process.exit(2);
}
await mkdir(out, { recursive: true });
// An in-process runtime (pi) can leave nothing pending while a promise waits: keep the loop alive.
const keepAlive = setInterval(() => {}, 1000);
for (const testCase of requested.length === 0 ? CASES : requested.filter((value) => CASES.includes(value))) {
  // oxlint-disable-next-line eslint/no-await-in-loop -- one case at a time: the runtimes share the machine
  const observation = await observe({ name, runtime, testCase, options });
  const file = `${name}-${testCase}${options.afterTool ? "-after-tool" : ""}${options.fastRetry ? "-fast" : ""}.json`;
  // oxlint-disable-next-line eslint/no-await-in-loop -- written before the next case starts
  await writeFile(path.join(out, file), JSON.stringify(observation, null, 2));
  console.log(summary(observation));
}
clearInterval(keepAlive);
process.exit(0);
