import { fileURLToPath } from "node:url";
import { afterEach, expect, test, vi } from "vitest";
import type { Session } from "../packages/oar/src/contracts/session.js";
import { awaitTurnEnd } from "../packages/oar/src/observe/turns.js";
import { acpSession } from "../packages/oar/src/shared/acp/session.js";
import { asRecord } from "../packages/oar/src/shared/json.js";
// oxlint-disable-next-line import/no-namespace -- Interpose the real serial batcher with one controlled background query.
import * as tables from "../packages/oar/src/shared/executable/process-table-async.js";
import { processTablePreparation } from "../packages/oar/src/shared/executable/process-table-preparation.js";
import { gone } from "./fixtures/process-tree.js";

afterEach(() => { vi.restoreAllMocks(); });
const fixture = fileURLToPath(new URL("fixtures/cancellation-orphan-agent.mjs", import.meta.url));
function ready(session: Session, since: number): Record<string, unknown> | undefined {
  return session.records().flatMap(record => record.kind === "frame" && record.seq > since
    ? record.body.events.flatMap(event => event.kind === "text_delta" ? [asRecord(JSON.parse(event.text)) ?? {}] : []) : [])
    .find(value => typeof value.tool === "number");
}

// oxlint-disable-next-line eslint/max-statements, eslint/max-lines-per-function -- Two real turns and one held query form a single ordered control.
test.each([false, true])("ACP background query queue: wait before cancelling = %s", async waitBeforeCancel => {
  const session = await acpSession({ args: [fixture, "acp"], capabilities: { queue: { durable: false }, attribution: "opaque" } })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd(), resume: "cancel-root" });
  const entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const owned: number[] = [], source = tables.processTableSource();
  const queries: { background: boolean; started: number; finished?: number }[] = [];
  const batch = tables.batchProcessTableReads(async (selected, options) => {
    const timing: { background: boolean; started: number; finished?: number } = { background: options?.background === true, started: performance.now() };
    queries.push(timing);
    if (options?.background === true) { entered.resolve(); await release.promise; }
    const result = await tables.observeProcessTableOnce(selected, options);
    timing.finished = performance.now();
    return result;
  });
  let preparation: Promise<unknown> | undefined = undefined;
  try {
    if (process.platform === "win32") {
      await expect.poll(() => processTablePreparation(), { timeout: 6000 }).toMatchObject({ ok: true });
    }
    vi.spyOn(tables, "observeProcessTableAsync").mockImplementation(async (selected, options) => batch(selected ?? source, options));
    preparation = batch(source, { background: true });
    await entered.promise;
    for (const round of [1, 2]) {
      // eslint-disable-next-line no-await-in-loop -- The next native turn follows completed cancellation.
      const prompt = await session.prompt(`round-${round}`);
      // eslint-disable-next-line no-await-in-loop -- The tool must exist before the cancellation snapshot.
      await expect.poll(() => ready(session, prompt.seq), { timeout: 10_000 }).toBeDefined();
      const middle = Number(ready(session, prompt.seq)?.middle), tool = Number(ready(session, prompt.seq)?.tool);
      owned.push(tool, middle);
      // eslint-disable-next-line no-await-in-loop -- The negative control must start with a live tool.
      expect(await gone(tool, 50)).toBe(false);
      if (round === 1 && waitBeforeCancel) {
        release.resolve();
        // eslint-disable-next-line no-await-in-loop -- Positive control finishes preparation before the first cancellation.
        await preparation;
      }
      const abort = session.abort();
      if (round === 1 && !waitBeforeCancel) {
        // Let the actual one-second caller budget expire while its fresh read
        // waits behind preparation. No second native query can have started.
        // eslint-disable-next-line no-await-in-loop -- Only this negative control deliberately exceeds the observation budget.
        await abort;
        expect(queries, JSON.stringify(queries)).toHaveLength(1);
        release.resolve();
        // eslint-disable-next-line no-await-in-loop -- Only release the background query after the first observation expired.
        await preparation;
      }
      // eslint-disable-next-line no-await-in-loop -- Both controls must issue and finish native cancellation.
      const abortResult = await abort;
      expect(abortResult.kind).toBe("accepted");
      // eslint-disable-next-line no-await-in-loop -- The native middle exits and leaves the live tool orphaned.
      expect(await awaitTurnEnd(session, prompt.seq)).toEqual({ kind: "aborted" });
      // eslint-disable-next-line no-await-in-loop -- Verify actual parent exit, not only the native cancellation acknowledgment.
      expect(await gone(middle)).toBe(true);
      // eslint-disable-next-line no-await-in-loop -- Cancel does not reclaim a surviving orphan until disposal.
      expect(await gone(tool, 50)).toBe(false);
    }
    await session.dispose();
    const exit = session.records().findLast(record => record.kind === "response" && record.body.kind === "exited");
    const reason = exit?.kind === "response" && exit.body.kind === "exited" ? exit.body.reason : undefined;
    const diagnostic = JSON.stringify({ waitBeforeCancel, queries, exited: exit?.kind === "response" ? exit.body : null });
    const reclaimed = await Promise.all(owned.map(async (pid, index) => gone(pid, index === 0 && !waitBeforeCancel ? 100 : 5000)));
    expect(reclaimed, diagnostic).toEqual([waitBeforeCancel, true, true, true]);
    if (waitBeforeCancel) { expect(reason, diagnostic).toBeUndefined(); }
    else { expect(reason, diagnostic).toMatch(/before_cancel (?:procfs|windows|ps): timeout/u); }
  } finally {
    release.resolve(); await preparation;
    vi.restoreAllMocks(); await session.dispose();
    for (const pid of owned) { try { process.kill(pid, "SIGKILL"); } catch { /* Test-owned processes only. */ } }
  }
}, 30_000);
