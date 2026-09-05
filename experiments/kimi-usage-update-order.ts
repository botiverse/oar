/**
 * KIMI USAGE_UPDATE ORDER — the turn's `usage_update` arrives AFTER the
 * `session/prompt` response, from an un-awaited task, and may not arrive.
 *
 * Why: `Session.contextUsage()` is meant to be current at `turn_ended`. The
 * shared ACP session settles the OAR turn when the prompt response lands, so
 * a runtime that reports usage only after answering leaves the reader on the
 * previous turn's value at exactly the moment a caller checks it.
 *
 * Source pin — kimi-code 0.41.0, commit f9ca33376,
 * packages/acp-server/src/session.ts:
 * - line 308: `events.on('turn.ended', …)` dispatches to `onTurnEnded`.
 * - lines 907-921 `onTurnEnded`: `settleDriver(driver, () => driver.resolve({
 *   stopReason }))` answers the pending `session/prompt` FIRST, then the last
 *   statement is `void this.emitUsageUpdate()` — not awaited.
 * - lines 923-945 `emitUsageUpdate` ("Push a one-shot `usage_update` after a
 *   turn settles"): awaits `klient.global.kosong.listModels()`, returns
 *   without pushing when no `max_context_size` matches `currentModelId`, then
 *   awaits `agent.getContext()` and only then emits
 *   `usageUpdateNotification(sessionId, context.tokenCount, size)`; any error
 *   is swallowed into `log.warn('acp: failed to push usage_update')`.
 * So: response, then two awaited calls, then maybe an update. The adapter
 * therefore declares `usageUpdateAfterPrompt` on the kimi profile and holds
 * the turn for at most `usageUpdateTimeoutMs` (default 500 ms) after the
 * response; on timeout it settles with what it has. Other profiles are
 * untouched.
 *
 * No kimi binary or account is available on this machine, so the timing is
 * pinned from source only and exercised against the ACP fixture's
 * "usage-after-response" / "usage-never" modes (tests/fixtures/
 * fake-acp-agent.mjs), the same way tests/acp/acp-session.test.ts does. With
 * a kimi binary present, `live` re-checks the real runtime.
 *
 * Run: pnpm tsx experiments/kimi-usage-update-order.ts [fixture|live]
 * Default fixture. `live` burns tokens for one short kimi turn.
 *
 * ── OBSERVED 2026-09-05, fixture only (kimi-code f9ca33376 source), linux x64 ──
 *
 * kimi profile (flag on): contextUsage() at turn_ended reads the turn's own
 * value (100, then 200 on the second turn). Same profile with the flag off:
 * undefined at the first turn_ended, 100 at the second — the previous turn's
 * value, the bug this pins. "usage-never" with a 100 ms bound: the turn
 * completes after the bound with contextUsage() still null.
 */
import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { kimiRuntime, type Session } from "../packages/oar/src/index.js";
import { kimiAcpProfile } from "../packages/oar/src/runtimes/kimi/session.js";
import { acpSession, type AcpSessionProfile } from "../packages/oar/src/shared/acp/session.js";

const which = process.argv[2] ?? "fixture";
const fixture = fileURLToPath(new URL("../tests/fixtures/fake-acp-agent.mjs", import.meta.url));
const fixtureInstallation = { kind: "available", via: "executable", command: process.execPath } as const;

type Tokens = number | null | undefined;

/** `contextUsage().tokens` as read inside each `turn_ended` handler, in order. */
function tokensAtTurnEnded(session: Session): readonly Tokens[] {
  const seen: Tokens[] = [];
  session.subscribe((event) => {
    if (event.kind === "turn_ended") {
      seen.push(session.contextUsage?.()?.tokens);
    }
  });
  return seen;
}

async function runTurn(session: Session, text: string): Promise<void> {
  const result = session.prompt(text);
  assert.equal(result.kind, "turn");
  const outcome = await result.turn.outcome;
  assert.equal(outcome.kind, "completed", JSON.stringify(outcome));
}

// A 150 ms gap between turns: a caller does not usually prompt again within
// the 40 ms the fixture takes to push, and the gap makes the second turn's
// stale read (flag off) observable as "the previous turn's value".
async function fixtureRun(mode: string, overrides: Partial<AcpSessionProfile>): Promise<readonly Tokens[]> {
  const profile: AcpSessionProfile = {
    ...kimiAcpProfile,
    args: [fixture, mode],
    selectAuthMethod: () => "cached",
    ...overrides,
  };
  const session = await acpSession(profile)(fixtureInstallation, { cwd: process.cwd() });
  const atEnd = tokensAtTurnEnded(session);
  await runTurn(session, "one");
  await sleep(150);
  await runTurn(session, "two");
  await session.dispose();
  return atEnd;
}

if (which === "fixture") {
  const flagOn = await fixtureRun("usage-after-response", {});
  assert.deepEqual(flagOn, [100, 200], "kimi profile should read each turn's own usage at turn_ended");
  const flagOff = await fixtureRun("usage-after-response", { usageUpdateAfterPrompt: false });
  assert.deepEqual(flagOff, [undefined, 100], "without the flag the read-back is one turn behind");
  const started = performance.now();
  const never = await fixtureRun("usage-never", { usageUpdateTimeoutMs: 100 });
  const elapsed = Math.round(performance.now() - started);
  assert.deepEqual(never, [undefined, undefined], "no update: settle with nothing, not with a stale value");
  assert.ok(elapsed >= 350, `two 100 ms bounds plus the 150 ms gap should take at least 350 ms, took ${elapsed}`);
  process.stdout.write(`${JSON.stringify({ source: "kimi-code f9ca33376", flagOn, flagOff, never, elapsedMs: elapsed }, null, 2)}\n`);
} else {
  const installation = await kimiRuntime.installation();
  assert.ok(installation.kind === "available", "kimi is not available on this machine");
  const session = await kimiRuntime.session(installation, { cwd: process.cwd() });
  const atEnd = tokensAtTurnEnded(session);
  await runTurn(session, "Reply with the single word: ok");
  await sleep(150);
  await runTurn(session, "Reply with the single word: ok");
  await session.dispose();
  const [first, second] = atEnd;
  process.stdout.write(`${JSON.stringify({
    version: installation.via === "executable" ? (installation.version ?? null) : null,
    tokensAtTurnEnded: atEnd,
    reportedAtFirstTurnEnd: typeof first === "number",
    grewBetweenTurns: typeof first === "number" && typeof second === "number" && second > first,
  }, null, 2)}\n`);
}
