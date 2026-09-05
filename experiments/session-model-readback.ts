/**
 * MODEL READ-BACK — `Session.model()` is the runtime's own report of the
 * model in effect, never an echo of `SessionOptions.model`.
 *
 * Why: a resume that silently keeps its old model (codex, see
 * session-resume-model.ts) or an alias the CLI resolves (claude `haiku`) is
 * invisible if a test asserts the request parameter. Each adapter therefore
 * reads the model back from a runtime-owned surface; this script records what
 * the real runtimes answer.
 *
 * Run: unset PI_PACKAGE_DIR && pnpm tsx experiments/session-model-readback.ts [claude|codex|pi|all]
 * Default all. Burns tokens for one short claude turn; codex and pi read the
 * model without a turn.
 *
 * Source pins (per adapter, where the read-back comes from):
 * - codex rust-v0.153.4 (3d2ee51c): ThreadStartResponse.model /
 *   ThreadResumeResponse.model in app-server-protocol v2/thread.rs. Available
 *   at open, before any turn.
 * - claude 2.1.261: print.ts emits the stream-json `system`/`init` frame with
 *   `model: P.model` at the start of every turn; `resolvedModel` exists only
 *   on `list_models` control-response rows, not on the session. So the
 *   read-back is null until the first turn, then the init frame's `model`.
 * - pi SDK 0.84.2: `AgentSession.model` getter ("Current model") — the
 *   runtime-owned field, spelled `provider/id` by the adapter. Available at
 *   open. (The adapter does not yet forward SessionOptions.model to pi; task
 *   #55.)
 * - grok xai-grok-shell 1.0.12 (bc7f02e): `session/new` and `session/load`
 *   answer `models.currentModelId` (agent/handlers/session_new.rs falls back
 *   to the default model when the requested one is not allowed, without an
 *   error); `session/set_model` answers `_meta.model`
 *   (agent/handlers/model_switch.rs:245, leader/server_tests.rs:1572).
 * - kimi kimi-code f9ca33376 (packages/acp-server/src): `session/new|load|
 *   resume` answer `configOptions` with the `id: "model"` row's
 *   `currentValue`; `setModel()` awaits `emitConfigOptionUpdate()` BEFORE the
 *   `session/set_model` request is answered with `{}`, so the update arrives
 *   while the adapter is still opening the session.
 * No grok or kimi binary or account is available on this machine, so those two
 * are pinned from source only and exercised against the ACP fixture in
 * tests/acp/acp-session.test.ts; this script does not claim a live run.
 *
 * ── OBSERVED 2026-09-05, codex-cli 0.153.4 + claude 2.1.261 + pi SDK 0.84.2, linux x64 ──
 *
 * codex: request gpt-5.4-mini → thread/start answered model=gpt-5.4-mini
 * before any turn; after one turn, thread/resume WITHOUT a request answered
 * model=gpt-5.4-mini (the saved model, read from the response, not from us).
 * claude: request `haiku` → null before the turn; the system/init frame
 * reported claude-haiku-4-5-20251001, i.e. the read-back is the resolved id,
 * not the alias we sent — exactly the request/report split the read-back is
 * for.
 * pi: no request → AgentSession.model at open was xai/grok-4.5 (pi's own
 * default from the exe-dev extension's registry; the dummy XAI_API_KEY only
 * keeps the xai provider available).
 */
import assert from "node:assert/strict";
import { runtimes, type Session, type SessionEvent } from "../packages/oar/src/index.js";

const which = process.argv[2] ?? "all";
const record: Record<string, unknown> = {};

async function open(id: string, options: { model?: string; resume?: string }): Promise<Session> {
  const runtime = runtimes.require(id);
  const probed = await runtime.installation?.();
  if (probed?.kind !== "available") {
    throw new Error(`${id} is not available`);
  }
  return runtime.session(probed, { cwd: process.cwd(), ...options });
}

async function oneTurn(session: Session, prompt: string): Promise<string> {
  const texts: string[] = [];
  session.subscribe((event: SessionEvent) => {
    if (event.kind === "text_delta") {
      texts.push(event.text);
    }
  });
  const result = session.prompt(prompt);
  assert.equal(result.kind, "turn", "session was busy");
  const outcome = await result.turn.outcome;
  assert.equal(outcome.kind, "completed", `turn ${outcome.kind}`);
  return texts.join("");
}

if (which === "codex" || which === "all") {
  // Start with a request, read back; then resume the same thread WITHOUT a
  // request and read back what the app-server reports for the saved thread.
  const requested = "gpt-5.4-mini";
  const started = await open("codex", { model: requested });
  const atStart = started.model?.();
  assert.equal(typeof atStart, "string", "codex reports no model at thread/start");
  await oneTurn(started, "Reply with exactly ok.");
  await started.dispose();
  const resumed = await open("codex", { resume: started.id });
  const atResume = resumed.model?.();
  await resumed.dispose();
  record.codex = { requested, atStart, atResume };
  assert.equal(atResume, atStart, "resume without a request should report the saved model");
}

if (which === "claude" || which === "all") {
  // Alias request: claude resolves `haiku` itself, so the read-back must be
  // the resolved id and must differ from the request string.
  const requested = "haiku";
  const session = await open("claude", { model: requested });
  const beforeTurn = session.model?.();
  await oneTurn(session, "Reply with exactly ok.");
  const afterTurn = session.model?.();
  await session.dispose();
  record.claude = { requested, beforeTurn, afterTurn };
  assert.equal(beforeTurn, null, "claude cannot know the model before the init frame");
  assert.equal(typeof afterTurn, "string", "no model in the system/init frame");
  assert.notEqual(afterTurn, requested, "read-back echoed the alias instead of the resolved id");
}

if (which === "pi" || which === "all") {
  process.env.XAI_API_KEY ??= "dummy-not-a-real-key";
  const session = await open("pi", {});
  const atOpen = session.model?.() ?? null;
  await session.dispose();
  record.pi = { requested: null, atOpen };
  assert.ok(atOpen === null || atOpen.includes("/"), "pi read-back should be provider/id or null");
}

process.stdout.write(`${JSON.stringify(record, null, 2)}\n`);
