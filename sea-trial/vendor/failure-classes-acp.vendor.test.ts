import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";
import {
  antigravityInstallation, antigravitySession, defineRuntime, grokInstallation, grokSession, kimiInstallation, kimiSession,
  opencodeInstallation, opencodeSession, RuntimeFailureError, type CredentialProblem, type FailureClass, type InstallationProbe, type StartSession, type TurnOutcome,
} from "../../packages/oar/src/index.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";
import { startAntigravityAimock, startGrokAimock, startKimiAimock, startOpencodeAimock, type AcpAimockEnv } from "../harness/aimock-acp.js";
import { runtimeUnderTest } from "../harness/subject.js";
import { runTurn } from "./support/asserts.js";

/*
 * The ACP cells of docs/spec/runtime-matrix.md#failure-evidence, each CLI
 * against a scripted provider (harness/aimock-acp.ts), as
 * failure-classes.vendor.test.ts does for claude, codex and pi. Run locally
 * (OAR_TEST=<id>), as CI has no ACP aimock backend. Pinned too: what kimi
 * and antigravity report as a completed turn (a known gap) and what opencode
 * classes only by its words (its last resort).
 */

interface ErrorReply {
  readonly status: number;
  readonly error: { readonly type: string; readonly code?: string; readonly message: string };
}

/** A failed turn's class, its status, and an auth failure's credential problem; or a completed turn. */
type Seen = { readonly failure: FailureClass; readonly credential?: CredentialProblem; readonly status?: number } | { readonly kind: "completed" };

interface AcpCell {
  readonly name: string;
  /** The provider's answer to every model request; absent for a cell that never reaches it. */
  readonly reply?: ErrorReply;
  /** The environment changed so the CLI has no credential. */
  readonly noLogin?: true;
  readonly model?: string;
  /** What the open rejects with, or what the turn ends as. */
  readonly expected: { readonly open: Pick<RuntimeFailureError, "failure"> } | { readonly turn: Seen };
}

interface AcpRuntime {
  readonly id: string;
  readonly session: StartSession;
  readonly installation: InstallationProbe;
  start(configure: Parameters<typeof startGrokAimock>[0]): Promise<AcpAimockEnv>;
  /** The environment's credential taken away. */
  withoutLogin(env: AcpAimockEnv): Promise<Readonly<Record<string, string>>>;
  readonly cells: readonly AcpCell[];
}

const openai429 = (code: string, message: string): ErrorReply => ({ status: 429, error: { type: "requests", code, message } });
const OPENAI_401: ErrorReply = { status: 401, error: { type: "invalid_request_error", code: "invalid_api_key", message: "Incorrect API key provided: aimock." } };
const OPENAI_CONTEXT: ErrorReply = { status: 400, error: { type: "invalid_request_error", code: "context_length_exceeded", message: "Your input exceeds the context window of this model." } };
const anthropicError = (status: number, type: string, message: string): ErrorReply => ({ status, error: { type, message } });

/** The empty homes the no-login cells use, removed after the suite. */
const made: string[] = [];

async function freshDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

const runtimes: readonly AcpRuntime[] = [
  {
    id: "opencode-aimock", session: opencodeSession, installation: opencodeInstallation, start: startOpencodeAimock,
    withoutLogin: async (env) => {
      const file = path.join(env.env.XDG_CONFIG_HOME ?? "", "opencode", "opencode.json");
      const config = asRecord(parseJson(await readFile(file, "utf8"))) ?? {};
      const provider = asRecord(asRecord(config.provider)?.aimock) ?? {};
      const { apiKey: _key, ...options } = asRecord(provider.options) ?? {};
      await writeFile(file, JSON.stringify({ ...config, provider: { aimock: { ...provider, options } } }));
      return { ...env.env, ANTHROPIC_API_KEY: "" };
    },
    cells: [
      { name: "unknown model", model: "aimock/oar-missing-model", expected: { open: { failure: "model_unavailable" } } },
      { name: "invalid key (its words)", reply: anthropicError(401, "authentication_error", "invalid x-api-key"), expected: { turn: { failure: "auth" } } },
      { name: "rate limited (its words)", reply: anthropicError(429, "rate_limit_error", "This request would exceed the rate limit for your organization of 50 requests per minute."), expected: { turn: { failure: "rate_limited" } } },
      { name: "credit balance (its words)", reply: anthropicError(400, "invalid_request_error", "Your credit balance is too low to access the Anthropic API."), expected: { turn: { failure: "billing" } } },
    ],
  },
  {
    id: "kimi-aimock", session: kimiSession, installation: kimiInstallation, start: startKimiAimock,
    withoutLogin: async (env) => {
      const { KIMI_MODEL_NAME: _n, KIMI_MODEL_API_KEY: _k, KIMI_MODEL_BASE_URL: _u, KIMI_MODEL_PROVIDER_TYPE: _t, KIMI_MODEL_CAPABILITIES: _c, ...rest } = env.env;
      return rest;
    },
    cells: [
      { name: "missing login", noLogin: true, expected: { open: { failure: "auth" } } },
      { name: "invalid key", reply: OPENAI_401, expected: { turn: { failure: "auth" } } },
      { name: "rate limited (reported as completed: a known gap)", reply: openai429("rate_limit_exceeded", "Rate limit reached for aimock-model."), expected: { turn: { kind: "completed" } } },
    ],
  },
  {
    id: "grok-aimock", session: grokSession, installation: grokInstallation, start: startGrokAimock,
    withoutLogin: async (env) => ({ ...env.env, GROK_HOME: await freshDir("oar-grok-no-login-"), XAI_API_KEY: "" }),
    cells: [
      { name: "missing login", noLogin: true, expected: { open: { failure: "auth" } } },
      { name: "unknown model", model: "oar-missing-model", expected: { open: { failure: "model_unavailable" } } },
      { name: "invalid key", reply: OPENAI_401, expected: { turn: { failure: "auth" } } },
      { name: "a 429 (any)", reply: openai429("insufficient_quota", "You exceeded your current quota."), expected: { turn: { failure: "rate_limited" } } },
      { name: "oversized context", reply: OPENAI_CONTEXT, expected: { turn: { failure: "input_too_large" } } },
    ],
  },
  {
    id: "antigravity-aimock", session: antigravitySession, installation: antigravityInstallation, start: startAntigravityAimock,
    withoutLogin: async (env) => ({ ...env.env, GEMINI_HOME: await freshDir("oar-antigravity-no-login-"), GEMINI_API_KEY: "" }),
    cells: [
      { name: "missing login", noLogin: true, expected: { open: { failure: "auth" } } },
      { name: "unknown model", model: "oar-missing-model", expected: { open: { failure: "model_unavailable" } } },
      { name: "invalid key (reported as completed: a known gap)", reply: { status: 400, error: { type: "INVALID_ARGUMENT", message: "API key not valid. Please pass a valid API key." } }, expected: { turn: { kind: "completed" } } },
    ],
  },
];

function seen(outcome: TurnOutcome): Seen | TurnOutcome {
  if (outcome.kind !== "failed") {
    return outcome;
  }
  const { failure, status } = outcome;
  const credential = outcome.failure === "auth" ? outcome.credential : undefined;
  return { failure, ...(credential === undefined ? {} : { credential }), ...(status === undefined ? {} : { status }) };
}

for (const acp of runtimes) {
  describe.skipIf(process.env.OAR_TEST !== acp.id)(`${acp.id}: failure classes`, () => {
    const runtime = defineRuntime({ id: acp.id, session: acp.session, installation: acp.installation });
    test.each(acp.cells)("$name", async (cell) => {
      const env = await acp.start((mock) => {
        if (cell.reply !== undefined) { mock.onMessage(/[\s\S]*/u, cell.reply); }
      });
      try {
        const subject = runtimeUnderTest(runtime, cell.noLogin === true ? await acp.withoutLogin(env) : env.env);
        const opening = subject.startSession(cell.model === undefined ? {} : { model: cell.model });
        if ("open" in cell.expected) {
          await expect(opening).rejects.toBeInstanceOf(RuntimeFailureError);
          await expect(opening).rejects.toMatchObject(cell.expected.open);
          return;
        }
        const session = await opening;
        expect(seen(await runTurn(session, "Say hello."))).toEqual(cell.expected.turn);
        await session.dispose();
      } finally {
        await env.stop();
      }
    }, 240_000);
  });
}

afterAll(async () => {
  await Promise.all(made.map(async (dir) => rm(dir, { recursive: true, force: true })));
});
