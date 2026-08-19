/**
 * Claude Code host runtime.
 *
 * Models: Claude Code accepts **aliases** and **full Anthropic API model names**.
 * Docs (hardcode authority — not a live probe):
 * - https://code.claude.com/docs/en/model-config  (alias vs full model name)
 * - https://platform.claude.com/docs/en/about-claude/models/overview  (API model ids)
 * Any name starting with `claude-` is recognized on the Anthropic API; the curated
 * full-id table is not exhaustive → `user-configured` covers the rest.
 * There is no reliable machine `claude models` list; raft treats claude as a
 * **static** catalog (`STATIC_RUNTIME_MODEL_SOURCE_IDS` + `RUNTIME_MODELS.claude`).
 *
 * Catalog shape (aligned with raft `RUNTIME_MODELS.claude` + Code model aliases):
 * - aliases: curated create-form set (not every string Claude Code still accepts)
 * - full IDs: convenience set (not exhaustive)
 * - user-configured escape (zero options) for any other Anthropic / gateway id
 * - optional `CLAUDE_MODEL_LIST=id1,id2` extends the list (host override)
 *
 * Omitted: `sonnet[1m]` / `opus[1m]` / `fable[1m]` (xxchan + Huaihuai 2026-08-11).
 * Claude Code 2.1.225 `/model` still *lists* them, but model-config says `sonnet[1m]`
 * has **no effect** when `sonnet` already resolves to Sonnet 5 (native 1M). Same
 * for current Opus 5. oar create-form drops no-op aliases; re-add if product wants
 * picker parity with every `/model` row. Use user-configured / CLAUDE_MODEL_LIST.
 *
 * Fixture: fixtures/claude-models.sample.txt (ids one per line; same set as default catalog).
 */
import { runText, firstLineVersion, modelsToInfo } from "../probe.js";
import { resolveClaudeCommand } from "../claudeResolve.js";
import { subprocessDriver, type PromptIo } from "../../../backend/subprocessDriver.js";
import type { LaunchSpec } from "../../../backend/process/lifecycle.js";
import type { RuntimeDriver } from "../../../backend/trait.js";
import type { ModelInfo } from "../../../config/model.js";
import type { RuntimeEvent } from "../../../events/event.js";
import type { TokenUsage, UsageReport } from "../../../events/usage.js";
import { Diagnostic } from "../../../events/diagnostic.js";
import { model } from "../../../config/model.js";

/** Claude Code model aliases for create-form (no-op [1m] suffixes omitted). */
export const CLAUDE_ALIASES: readonly { id: string; label: string }[] = [
  { id: "default", label: "Default (account / org recommended)" },
  { id: "best", label: "Best (Fable 5 when available, else latest Opus)" },
  { id: "fable", label: "Claude Fable (alias)" },
  { id: "opus", label: "Claude Opus (alias → latest)" },
  { id: "sonnet", label: "Claude Sonnet (alias → latest)" },
  { id: "haiku", label: "Claude Haiku (alias → latest)" },
  { id: "opusplan", label: "Opus plan → Sonnet execute" },
];

/**
 * Full Anthropic API model IDs commonly used with Claude Code.
 * Mirrors raft `RUNTIME_MODELS.claude` full-id rows + current platform overview.
 * Claude Code also accepts other `claude-*` IDs; those use user-configured.
 */
export const CLAUDE_API_MODELS: readonly { id: string; label: string }[] = [
  { id: "claude-fable-5", label: "Claude Fable 5" },
  { id: "claude-opus-5", label: "Claude Opus 5" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7" },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6" },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
  { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5" },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5" },
];

const USER_CONFIGURED: ModelInfo = model(
  "user-configured",
  "User-configured (env / config file / full claude-* id)",
  [],
);

/** Default catalog ids (aliases + API names). */
export function defaultClaudeModelIds(): readonly string[] {
  return [...CLAUDE_ALIASES.map((m) => m.id), ...CLAUDE_API_MODELS.map((m) => m.id)];
}

/**
 * Build ModelInfo list for Claude Code.
 *
 * Sample catalog source (fixtures/claude-models.sample.txt — one id per line):
 * ```
 * opus
 * sonnet
 * claude-opus-5
 * claude-fable-5
 * user-configured
 * ```
 */
export function buildClaudeModels(extraIds: readonly string[] = []): readonly ModelInfo[] {
  const byId = new Map<string, { id: string; label: string }>();
  for (const m of CLAUDE_ALIASES) byId.set(m.id, m);
  for (const m of CLAUDE_API_MODELS) byId.set(m.id, m);
  for (const id of extraIds) {
    const t = id.trim();
    if (!t || byId.has(t)) continue;
    byId.set(t, { id: t, label: t });
  }

  const live = [...byId.values()].map((m) => ({
    id: m.id,
    label: m.label,
    // Effort levels: model-dependent; declare a common closed set for form width.
    // Full accuracy would need per-id tables (raft has partial data).
    supportedReasoningEfforts: ["low", "medium", "high", "xhigh", "max"] as const,
  }));

  const listed = modelsToInfo("claude", live);
  if (listed.some((m) => m.id === "user-configured")) return listed;
  return [...listed, USER_CONFIGURED];
}

// ── Turn protocol ───────────────────────────────────────────────────────────
//
// Claude Code is driven as newline-delimited "stream-json" over stdin/stdout,
// extracted from the raft daemon claude driver
// (`packages/daemon/src/drivers/claude.ts` + `claudeEventNormalizer.ts` +
// `claudeLaunch.ts`). A user turn is submitted by WRITING a single JSON line to
// stdin; the runtime streams JSON event lines back on stdout.
//
// ⚠️ NO PRE-TURN HANDSHAKE (structural divergence from codex — FLAG 1).
// Unlike codex (initialize → thread/start request/response witness), raft does
// NOT perform any readiness handshake for claude: it spawns the CLI and writes
// the user turn to stdin immediately (raft `claude.ts:144-153`), and it treats
// the session as ready only at a turn boundary (raft `claude.ts:59`
// `liveSessionReadyAt: "turn_end"`) — the `system/init` frame's session id is
// explicitly NOT trusted as a readiness signal. There is therefore no pre-turn
// witness to extract, and building a handshake that waits for `system/init`
// before sending a prompt would be unsourced (and could deadlock if the CLI
// blocks on stdin first). oar's honest declaration is `first_event`: the first
// contract event the turn produces is the readiness witness — strictly stronger
// than `process_spawned`, and faithful to raft.

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Longest a first turn may take before the session is considered inert. */
const CLAUDE_FIRST_EVENT_TIMEOUT_MS = 120_000;

/**
 * claude launch plan — the stream-json turn transport, from raft
 * `claudeLaunch.ts:59-98` (`buildClaudeArgs`). Only the turn-protocol-essential
 * flags are carried; daemon-only args are intentionally omitted (FLAG 9):
 *   - `--append-system-prompt-file` / `--disallowed-tools` (daemon policy),
 *   - `--mcp-config` / credential-proxy env / `--resume <sessionId>`
 * are agent-orchestration concerns with no analogue on oar's drive path.
 */
function claudePlan(options: Readonly<Record<string, string>>): LaunchSpec {
  const command = resolveClaudeCommand() ?? "claude";
  const args = [
    "--verbose", // raft claudeLaunch.ts:68
    "--permission-mode", "bypassPermissions", // raft :69 — non-interactive: a turn cannot hang on a permission prompt (mirrors codex approvalPolicy:"never")
    "--allow-dangerously-skip-permissions", // raft claudeLaunch.ts:65 — companion gate: some claude versions require this to honor --dangerously-skip-permissions
    "--dangerously-skip-permissions", // raft :67
    "--output-format", "stream-json", // raft :70
    "--input-format", "stream-json", // raft :71
    "--include-partial-messages", // raft :72
    "--model", options.model && options.model.length > 0 ? options.model : "sonnet", // raft :73 (`|| "sonnet"`)
  ];
  if (options.reasoningEffort && options.reasoningEffort.length > 0) {
    args.push("--effort", options.reasoningEffort); // raft claudeLaunch.ts:77-79
  }
  return { command, args, env: {} };
}

/**
 * Submit a user turn by writing one stream-json line to stdin. Shape is raft's
 * exact stdin encoding (`claude.ts:145-153` initial turn / `:166-179`
 * `encodeStdinMessage`). No session_id: oar's drive path holds no resumable
 * session (session-id threading is dropped — FLAG 5).
 */
function claudeSendPrompt(io: PromptIo, text: string): void {
  io.send(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: [{ type: "text", text }] },
    }),
  );
}

/**
 * Provider/network API-failure gate on assistant `text` blocks, faithful port of
 * raft `claudeEventNormalizer.ts:56-66`. When an assistant text block (in a
 * message with no tool_use) reads like a transport API error, raft surfaces it
 * as an error rather than model text; oar maps that to `runtime_error`.
 */
function isProviderApiFailureText(value: string, hasToolUse: boolean): boolean {
  return !hasToolUse
    && /^\s*API Error:/i.test(value)
    && (
      /\b(?:ECONNRESET|EPIPE|ETIMEDOUT|ECONNREFUSED|ENOTFOUND|EAI_AGAIN)\b/i.test(value)
      || /\bUnable to connect to API\b/i.test(value)
      || /\b(?:timed out|timeout)\b/i.test(value)
      || /\b4\d{2}\b/.test(value)
      || /\b5\d{2}\b/.test(value)
    );
}

/** result-frame error detail assembly — raft `claudeEventNormalizer.ts:43-54`. */
function collectResultErrorDetail(event: Record<string, unknown>, fallback: string): string {
  const parts: string[] = [];
  if (Array.isArray(event.errors)) {
    for (const err of event.errors) {
      if (typeof err === "string" && err.trim()) parts.push(err.trim());
    }
  }
  if (typeof event.result === "string" && event.result.trim()) parts.push(event.result.trim());
  return parts.join(" | ") || fallback;
}

/**
 * Per-turn token usage off the `result` frame's `usage` object (raft
 * `claudeEventNormalizer.ts:152-155,199`; field names are claude's).
 * Unlike codex (usage arrived on a SEPARATE `thread/tokenUsage/updated` frame,
 * so a stateless per-frame mapper could not attach it), claude reports usage on
 * the SAME frame that ends the turn — so it attaches to `turn_end.usage` with no
 * cross-frame state (FLAG 10, a stateless-friendly win). Absent components stay
 * ABSENT (usage.ts contract: an unreported component is not a zero); an empty
 * usage object yields `undefined` rather than a hollow report.
 */
function claudeUsage(event: Record<string, unknown>): UsageReport | undefined {
  const usage = isRecord(event.usage) ? event.usage : null;
  if (!usage) return undefined;
  const inputTokens = finiteNumber(usage.input_tokens);
  const outputTokens = finiteNumber(usage.output_tokens);
  const cacheReadTokens = finiteNumber(usage.cache_read_input_tokens);
  const cacheWriteTokens = finiteNumber(usage.cache_creation_input_tokens);
  const tok: TokenUsage = {
    ...(inputTokens !== undefined ? { inputTokens } : {}),
    ...(outputTokens !== undefined ? { outputTokens } : {}),
    ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens !== undefined ? { cacheWriteTokens } : {}),
  };
  if (Object.keys(tok).length === 0) return undefined;
  return { scope: "turn", usage: tok };
}

/**
 * Assistant message → events (raft `claudeEventNormalizer.ts:314-338`).
 * - `text` block → `text`, UNLESS the API-failure gate fires → `runtime_error`.
 * - `tool_use` block → `tool_call{callId, name}`. callId is the block's own `id`
 *   (FLAG 8): raft's ParsedEvent `tool_call` drops the id, but the claude frame
 *   carries it and raft reads that same id namespace on the result side
 *   (`block.tool_use_id`, `:347`). No id → no call envelope → skip (mirrors codex).
 * - `thinking` block → raft emits `thinking` (`:324-325`); oar has no thinking
 *   event kind → tolerated/dropped (FLAG 3).
 */
function assistantEvents(event: Record<string, unknown>): RuntimeEvent[] {
  const message = isRecord(event.message) ? event.message : null;
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (!content) return [];
  const hasToolUse = content.some((b) => isRecord(b) && b.type === "tool_use");
  const out: RuntimeEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text") {
      const text = nonEmptyString(block.text);
      if (!text) continue;
      if (isProviderApiFailureText(text, hasToolUse)) {
        out.push({ kind: "runtime_error", detail: Diagnostic.fromRaw("unknown", text) });
      } else {
        out.push({ kind: "text", text });
      }
    } else if (block.type === "tool_use") {
      const callId = nonEmptyString(block.id);
      if (callId === null) continue; // no id → cannot form a call envelope
      const name = nonEmptyString(block.name) ?? "unknown_tool"; // raft :333
      out.push({ kind: "tool_call", callId, name });
    }
  }
  return out;
}

/**
 * User message → events (raft `claudeEventNormalizer.ts:340-352`).
 * A `tool_result` block → `tool_result{callId, ok}`.
 * - callId = `block.tool_use_id` (the correlating id raft uses at `:347`). No id
 *   → skip (oar needs the correlating id; mirrors codex).
 * - ok = `block.is_error !== true` (FLAG 2): raft's normalizer emits a name-only
 *   `tool_output` and does NOT read `is_error`; oar reads it from the claude
 *   tool_result content-block (Anthropic tool_result shape — VERIFY). Absent
 *   `is_error` → ok:true, which matches raft's implicit behavior; only an
 *   explicit `is_error:true` diverges (→ ok:false), which is strictly more
 *   correct. Unlike codex's `ok` (no per-item source, hardcoded true), this IS
 *   a real per-item field on the same frame.
 */
function userEvents(event: Record<string, unknown>): RuntimeEvent[] {
  const message = isRecord(event.message) ? event.message : null;
  const content = message && Array.isArray(message.content) ? message.content : null;
  if (!content) return [];
  const out: RuntimeEvent[] = [];
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "tool_result") {
      const callId = nonEmptyString(block.tool_use_id);
      if (callId === null) continue;
      out.push({ kind: "tool_result", callId, ok: block.is_error !== true });
    }
  }
  return out;
}

/**
 * `result` frame → terminal events (raft `claudeEventNormalizer.ts:354-390`).
 * The result subtype selects an optional error message; a `turn_end` is always
 * emitted. oar has no distinct TurnEndReason for max-turns/budget/structured-
 * output exhaustion, so every result-level error folds to `crashed` with the
 * specific message carried in the `runtime_error` detail (FLAG 7; mirrors codex
 * failed→crashed). Usage (when present) rides the `turn_end`.
 */
function resultEvents(event: Record<string, unknown>): RuntimeEvent[] {
  const subtype = nonEmptyString(event.subtype) ?? "success";
  const stopReason = nonEmptyString(event.stop_reason);
  const isMaxTokenError = stopReason === "max_tokens" && (event.is_error === true || subtype !== "success");

  let errorMessage: string | null = null;
  switch (subtype) {
    case "success":
      if (event.is_error === true) errorMessage = collectResultErrorDetail(event, "Execution failed");
      break;
    case "error_during_execution":
      if (stopReason !== "max_tokens" || isMaxTokenError) errorMessage = collectResultErrorDetail(event, "Execution failed");
      break;
    case "error_max_budget_usd":
      errorMessage = collectResultErrorDetail(event, "Budget limit exceeded");
      break;
    case "error_max_turns":
      errorMessage = collectResultErrorDetail(event, "Max turns exceeded");
      break;
    case "error_max_structured_output_retries":
      errorMessage = collectResultErrorDetail(event, "Structured output retries exceeded");
      break;
  }

  const usage = claudeUsage(event);
  if (errorMessage !== null) {
    return [
      { kind: "runtime_error", detail: Diagnostic.fromRaw("crashed", errorMessage) },
      { kind: "turn_end", reason: "crashed", ...(usage ? { usage } : {}) },
    ];
  }
  return [{ kind: "turn_end", reason: "completed", ...(usage ? { usage } : {}) }];
}

/**
 * Frame → oar `RuntimeEvent`s for the claude stream-json turn protocol, extracted
 * from raft's production daemon driver (`packages/daemon/src/drivers/claudeEventNormalizer.ts`).
 * Stateless and per-frame: TOLERATES unsolicited / out-of-order / unrecognised
 * frames by returning `[]` rather than desyncing.
 *
 * Top-level `type` → handling (raft file:line is the authority for each):
 * - `assistant` → text / runtime_error / tool_call. raft `:314-338`
 * - `user`      → tool_result. raft `:340-352`
 * - `result`    → runtime_error? + turn_end (+ usage). raft `:354-390`
 * - everything else → `[]`:
 *     · `system` subtype `init` → raft `session_init` (`:252-254`); oar carries
 *       no session id → dropped (FLAG 5).
 *     · `system` subtype `status`/`compact_boundary`/task-lifecycle → raft
 *       internal_progress / compaction / subagent (`:261-300`); no oar kind.
 *     · `stream_event` → raft internal_progress partial-stream envelope
 *       (`:303-312`); oar surfaces full text at the completed `assistant`
 *       message instead (FLAG 4; parallels codex delta handling).
 *     · `rate_limit_event` → raft telemetry-only (`:232-250`), NOT routed to an
 *       error; oar tolerates (FLAG 6).
 */
export function claudeNormalise(raw: unknown): readonly RuntimeEvent[] {
  if (!isRecord(raw)) return [];
  switch (raw.type) {
    case "assistant":
      return assistantEvents(raw);
    case "user":
      return userEvents(raw);
    case "result":
      return resultEvents(raw);
    default:
      return [];
  }
}

export function claudeDriver(): RuntimeDriver {
  return subprocessDriver({
    id: "claude",
    detect: async () => {
      // PATH → (darwin) "Claude Code URL Handler.app" bundle, per raft
      // resolveClaudeCommand. Desktop-installed claude off PATH was invisible.
      const path = resolveClaudeCommand();
      if (!path) return null;
      const r = runText(path, ["--version"], { timeoutMs: 10_000 });
      const v = firstLineVersion(r.stdout) ?? firstLineVersion(r.stderr);
      return v ? { version: v } : { version: "claude" };
    },
    models: async () => {
      const fromEnv =
        process.env.CLAUDE_MODEL_LIST?.split(",")
          .map((s) => s.trim())
          .filter(Boolean) ?? [];
      return buildClaudeModels(fromEnv);
    },
    // Drive-layer: real stream-json launch + a wired user-turn submitter (stdin
    // stream-json) + tolerant normalise. No pre-turn handshake exists to extract
    // (see the Turn protocol note), so readiness is the first turn event.
    plan: claudePlan,
    readiness: { kind: "first_event", withinMs: CLAUDE_FIRST_EVENT_TIMEOUT_MS },
    sendPrompt: claudeSendPrompt,
    normalise: claudeNormalise,
    shutdown: { graceMs: 2_000, onGraceExpiry: "immediate" },
  });
}
