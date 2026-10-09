import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { CredentialProblem, FailureClass, TurnOutcome } from "../../packages/oar/src/contracts/session.js";
import { claudeInstallation, claudeSession, codexInstallation, codexSession, defineRuntime, piInstallation, piSession, RuntimeFailureError } from "../../packages/oar/src/index.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv, type LLMock } from "../harness/aimock.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";

/*
 * Every mapped cell of docs/spec/runtime-matrix.md#failure-evidence, on the
 * real runtime against a scripted provider answering with the provider's
 * documented error (as experiments/failure-evidence.ts gathered them): the
 * class, the credential problem and the status a failed turn carries. A
 * runtime that changes what it says moves a cell here first.
 */

interface ErrorReply {
  readonly status: number;
  readonly error: { readonly type: string; readonly code?: string; readonly message: string };
}

/** A failed turn's class, its status, and an auth failure's credential problem. */
interface Expected { readonly failure: FailureClass; readonly credential?: CredentialProblem; readonly status?: number }

interface Cell {
  readonly name: string;
  /** The provider's answer to every model request, or one replacing each streamed answer. */
  readonly reply: ErrorReply | { readonly stream: string };
  readonly model?: string;
  readonly expected: Expected;
}

const anthropic = (status: number, type: string, message: string): ErrorReply => ({ status, error: { type, message } });
const openai = (status: number, type: string, code: string | undefined, message: string): ErrorReply => ({ status, error: { type, ...(code === undefined ? {} : { code }), message } });

const ANTHROPIC_CELLS = {
  invalidKey: anthropic(401, "authentication_error", "invalid x-api-key"),
  modelNotFound: anthropic(404, "not_found_error", "model: oar-missing-model"),
  rateLimited: anthropic(429, "rate_limit_error", "This request would exceed the rate limit for your organization of 50 requests per minute."),
  spendLimit: anthropic(400, "invalid_request_error", "You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC."),
  creditBalance: anthropic(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."),
  billing402: anthropic(402, "billing_error", "This organization has a billing issue."),
  serverError: anthropic(500, "api_error", "Internal server error"),
  overloaded: anthropic(529, "overloaded_error", "Overloaded"),
  contextTooLarge: anthropic(400, "invalid_request_error", "prompt is too long: 250000 tokens > 200000 maximum"),
};

function sse(event: string, data: unknown): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** The Responses API failing inside a 200 stream. */
function responseFailed(code: string, message: string): { readonly stream: string } {
  return {
    stream: sse("response.created", { type: "response.created", sequence_number: 0, response: { id: "resp_oar", object: "response", status: "in_progress", output: [] } })
      + sse("response.failed", { type: "response.failed", sequence_number: 1, response: { id: "resp_oar", object: "response", status: "failed", output: [], error: { code, message } } }),
  };
}

/** The Messages API failing inside a 200 stream. */
function anthropicStreamError(type: string, message: string): { readonly stream: string } {
  return {
    stream: sse("message_start", { type: "message_start", message: { id: "msg_oar", type: "message", role: "assistant", model: "aimock-model", content: [], stop_reason: null, usage: { input_tokens: 1, output_tokens: 0 } } })
      + sse("error", { type: "error", error: { type, message } }),
  };
}

/** A provider answering with `cell.reply`; a streamed failure replaces only streamed answers. */
function configure(cell: Cell): { readonly fixtures: (mock: LLMock) => void; readonly rewrite?: (body: string) => string } {
  const { reply } = cell;
  if ("stream" in reply) {
    return {
      fixtures: (mock) => { mock.onMessage(/[\s\S]*/u, { content: "ok" }); },
      rewrite: (body) => (/^(?:event|data):/u.test(body.trimStart()) ? reply.stream : body),
    };
  }
  return { fixtures: (mock) => { mock.onMessage(/[\s\S]*/u, reply); } };
}

/** The class, credential problem and status of the turn's outcome (absent ones absent). */
function classOf(outcome: TurnOutcome): Expected | TurnOutcome {
  if (outcome.kind !== "failed") {
    return outcome;
  }
  const { failure, status } = outcome;
  const credential = outcome.failure === "auth" ? outcome.credential : undefined;
  return { failure, ...(credential === undefined ? {} : { credential }), ...(status === undefined ? {} : { status }) };
}

describe.skipIf(process.env.OAR_TEST !== "claude-aimock")("claude: failure classes", () => {
  const runtime = defineRuntime({ id: "claude-aimock", session: claudeSession, installation: claudeInstallation });
  const cells: readonly Cell[] = [
    { name: "invalid key", reply: ANTHROPIC_CELLS.invalidKey, expected: { failure: "auth", credential: "rejected", status: 401 } },
    { name: "unknown model", reply: ANTHROPIC_CELLS.modelNotFound, model: "oar-missing-model", expected: { failure: "model_unavailable", status: 404 } },
    { name: "rate limited", reply: ANTHROPIC_CELLS.rateLimited, expected: { failure: "rate_limited", status: 429 } },
    { name: "spend limit (a 400 claude names unknown: its words decide)", reply: ANTHROPIC_CELLS.spendLimit, expected: { failure: "quota", status: 400 } },
    { name: "credit balance", reply: ANTHROPIC_CELLS.creditBalance, expected: { failure: "billing", status: 400 } },
    { name: "402", reply: ANTHROPIC_CELLS.billing402, expected: { failure: "billing", status: 402 } },
    { name: "server error", reply: ANTHROPIC_CELLS.serverError, expected: { failure: "provider", status: 500 } },
    { name: "overloaded", reply: ANTHROPIC_CELLS.overloaded, expected: { failure: "overloaded", status: 529 } },
    { name: "oversized context", reply: ANTHROPIC_CELLS.contextTooLarge, expected: { failure: "input_too_large", status: 400 } },
  ];
  test.each(cells)("$name", async (cell) => {
    const { fixtures } = configure(cell);
    const env = await startClaudeAimock(fixtures);
    try {
      // One retry, not ten: the class is the same, the wait is not.
      const session = await runtimeUnderTest(runtime, { ...env.env, CLAUDE_CODE_MAX_RETRIES: "1" }).startSession(cell.model === undefined ? {} : { model: cell.model });
      expect(classOf(await runTurn(session, "Say hello."))).toEqual(cell.expected);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("missing login: no request is sent, and claude says so", async () => {
    const env = await startClaudeAimock((mock) => { mock.onMessage(/[\s\S]*/u, ANTHROPIC_CELLS.invalidKey); });
    const home = await mkdtemp(path.join(tmpdir(), "oar-claude-no-login-"));
    try {
      const session = await runtimeUnderTest(runtime, { ...env.env, ANTHROPIC_API_KEY: "", CLAUDE_CONFIG_DIR: home, HOME: home }).startSession();
      expect(classOf(await runTurn(session, "Say hello."))).toEqual({ failure: "auth", credential: "missing" });
      expect(env.mock.getRequests().filter((request) => request.path.includes("/v1/messages"))).toEqual([]);
      await session.dispose();
    } finally {
      await env.stop();
      await rm(home, { recursive: true, force: true });
    }
  }, 120_000);
});

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("codex: failure classes", () => {
  const runtime = defineRuntime({ id: "codex-aimock", session: codexSession, installation: codexInstallation });
  const cells: readonly Cell[] = [
    { name: "invalid key", reply: openai(401, "invalid_request_error", "invalid_api_key", "Incorrect API key provided: aimock."), expected: { failure: "auth", status: 401 } },
    { name: "unknown model", reply: openai(404, "invalid_request_error", "model_not_found", "The model `oar-missing-model` does not exist or you do not have access to it."), expected: { failure: "model_unavailable", status: 404 } },
    { name: "rate limited", reply: openai(429, "requests", "rate_limit_exceeded", "Rate limit reached for aimock-model. Please try again in 20s."), expected: { failure: "rate_limited", status: 429 } },
    { name: "usage limit", reply: openai(429, "requests", "organization_usage_limit_exceeded", "Organization usage limit reached"), expected: { failure: "quota" } },
    { name: "a ChatGPT plan's usage limit", reply: openai(429, "usage_limit_reached", undefined, "The usage limit has been reached"), expected: { failure: "quota" } },
    { name: "credit balance (codex names it as a usage limit)", reply: openai(429, "insufficient_quota", "credit_balance_exhausted", "Credit balance exhausted"), expected: { failure: "quota" } },
    { name: "server error", reply: openai(500, "server_error", undefined, "The server had an error while processing your request."), expected: { failure: "provider" } },
    { name: "overloaded", reply: openai(503, "server_error", "server_is_overloaded", "The server is overloaded or not ready yet."), expected: { failure: "overloaded" } },
    { name: "oversized context as an HTTP 400", reply: openai(400, "invalid_request_error", "context_length_exceeded", "Your input exceeds the context window of this model."), expected: { failure: "input_too_large" } },
    { name: "oversized context in the stream", reply: responseFailed("context_length_exceeded", "Your input exceeds the context window of this model."), expected: { failure: "input_too_large" } },
    { name: "overloaded in the stream", reply: responseFailed("server_is_overloaded", "The server is overloaded or not ready yet."), expected: { failure: "overloaded" } },
    { name: "quota in the stream", reply: responseFailed("insufficient_quota", "You exceeded your current quota."), expected: { failure: "quota" } },
    { name: "rate limited in the stream", reply: responseFailed("rate_limit_exceeded", "Rate limit reached for aimock-model. Please try again in 1s."), expected: { failure: "rate_limited" } },
  ];
  test.each(cells)("$name", async (cell) => {
    const { fixtures, rewrite } = configure(cell);
    const env: AimockEnv = await startCodexAimock(fixtures, rewrite === undefined ? {} : { rewriteResponse: rewrite });
    try {
      // One retry, not five: the class is the same, the wait is not.
      await appendFile(path.join(env.env?.CODEX_HOME ?? "", "config.toml"), "request_max_retries = 1\nstream_max_retries = 1\n");
      const session = await runtimeUnderTest(runtime, env.env).startSession();
      expect(classOf(await runTurn(session, "Say hello."))).toEqual(cell.expected);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);
});

describe.skipIf(process.env.OAR_TEST !== "pi-aimock")("pi: failure classes", () => {
  const runtime = defineRuntime({ id: "pi-aimock", session: piSession, installation: piInstallation });
  const cells: readonly Cell[] = [
    { name: "invalid key", reply: ANTHROPIC_CELLS.invalidKey, expected: { failure: "auth", status: 401 } },
    { name: "unentitled model", reply: ANTHROPIC_CELLS.modelNotFound, expected: { failure: "model_unavailable", status: 404 } },
    { name: "rate limited", reply: ANTHROPIC_CELLS.rateLimited, expected: { failure: "rate_limited", status: 429 } },
    { name: "spend limit", reply: ANTHROPIC_CELLS.spendLimit, expected: { failure: "quota", status: 400 } },
    { name: "credit balance", reply: ANTHROPIC_CELLS.creditBalance, expected: { failure: "billing", status: 400 } },
    { name: "402", reply: ANTHROPIC_CELLS.billing402, expected: { failure: "billing", status: 402 } },
    { name: "server error", reply: ANTHROPIC_CELLS.serverError, expected: { failure: "provider", status: 500 } },
    { name: "overloaded", reply: ANTHROPIC_CELLS.overloaded, expected: { failure: "overloaded", status: 529 } },
    { name: "oversized context (pi-ai's isContextOverflow)", reply: ANTHROPIC_CELLS.contextTooLarge, expected: { failure: "input_too_large", status: 400 } },
    { name: "overloaded in the stream", reply: anthropicStreamError("overloaded_error", "Overloaded"), expected: { failure: "overloaded" } },
  ];
  test.each(cells)("$name", async (cell) => {
    const { fixtures, rewrite } = configure(cell);
    // No auto-retry: the class is the same, the wait is not.
    const env = await startPiAimock(fixtures, { settings: { retry: { enabled: false } }, ...(rewrite === undefined ? {} : { rewriteResponse: rewrite }) });
    try {
      const session = await runtimeUnderTest(runtime).startSession();
      expect(classOf(await runTurn(session, "Say hello."))).toEqual(cell.expected);
      await session.dispose();
    } finally {
      await env.stop();
    }
  }, 120_000);

  test("a model pi does not have fails the open as model_unavailable", async () => {
    const env = await startPiAimock();
    try {
      const opened = runtimeUnderTest(runtime).startSession({ model: "aimock/oar-missing-model" });
      await expect(opened).rejects.toBeInstanceOf(RuntimeFailureError);
      await expect(opened).rejects.toMatchObject({ failure: "model_unavailable" });
    } finally {
      await env.stop();
    }
  }, 60_000);
});
