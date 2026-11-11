/* oxlint-disable max-statements -- One live native turn per case, end to end. */
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { expect, test } from "vitest";
import { awaitTurnEnd, grokInstallation, grokSession, promptAndWait, type RawEvent, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock } from "../harness/aimock-acp.js";

/*
 * SessionOptions.endTurnProcessesOnAbort on Grok, against a scripted provider.
 * The model asks for a command that writes a marker after a few seconds; OAR
 * aborts while it runs. Native cancel leaves the terminal OAR hosts for it
 * running (docs/spec/runtime-matrix.md), so without the option the marker
 * appears; with it, OAR stops the terminal when the aborted turn closes and
 * records a `cleanup` response, and the session takes the next prompt.
 * POSIX shells only: Grok runs `sleep 3; touch ...` as one shell line there.
 */
const hasTools = (request: unknown): boolean => { const tools = asRecord(request)?.tools; return Array.isArray(tools) && tools.length > 0; };
const lastRole = (request: unknown): string => {
  const messages: unknown = asRecord(request)?.messages;
  return Array.isArray(messages) ? String(asRecord(messages.at(-1))?.role) : "";
};
/** Only the newest message: a later request still carries the first prompt in its history. */
const asked = (request: unknown): boolean => {
  const messages: unknown = asRecord(request)?.messages;
  return Array.isArray(messages) && JSON.stringify(asRecord(messages.at(-1))?.content ?? "").includes("RUN_MARKER");
};
const toolStarted = (records: readonly RawEvent[]): boolean => records.some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_started"));
const cleanupOf = (records: readonly RawEvent[], requestId: string): unknown => records.find((record) => record.kind === "response" && record.requestId === requestId && record.body.kind === "cleanup");
const until = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) { await delay(50); }
  expect(check()).toBe(true);
};

async function aborted(endTurnProcessesOnAbort: boolean): Promise<{ readonly markerExists: boolean; readonly cleanup: unknown; readonly next: unknown }> {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-abort-terminals-"));
  const marker = path.join(root, "marker");
  const provider = await startGrokAimock((mock) => {
    mock.on({ predicate: (request) => !hasTools(request) }, { content: "a title" });
    mock.on({ predicate: (request) => lastRole(request) === "tool" }, { content: "after-tool" });
    mock.on({ predicate: (request) => asked(request) && lastRole(request) === "user" }, {
      toolCalls: [{ id: "marker", name: "run_terminal_command", arguments: JSON.stringify({ command: `sleep 3; touch ${marker}`, description: "wait, then write a marker" }) }],
    });
    mock.on({ predicate: () => true }, { content: "ok" });
  });
  let session: Session | undefined = undefined;
  try {
    const installation = await grokInstallation();
    if (installation.kind !== "available") { throw new Error("Grok unavailable"); }
    session = await grokSession(installation, { cwd: root, env: provider.env, ...(endTurnProcessesOnAbort ? { endTurnProcessesOnAbort } : {}) });
    const started = await session.prompt("RUN_MARKER");
    const open = session;
    await until(() => toolStarted(open.records()));
    await delay(500);
    const stop = await session.abort();
    expect(stop.kind).toBe("accepted");
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "aborted" });
    if (endTurnProcessesOnAbort) { await until(() => cleanupOf(open.records(), stop.requestId) !== undefined, 10_000); }
    await delay(5000);
    // Read before the next prompt, so nothing that prompt runs can write it.
    const markerExists = existsSync(marker);
    const next = await promptAndWait(session, "hello again");
    return { markerExists, cleanup: cleanupOf(session.records(), stop.requestId), next };
  } catch (error) {
    if (session !== undefined) {
      const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "grok-abort-terminals");
      await mkdir(out, { recursive: true });
      await writeFile(path.join(out, `${String(endTurnProcessesOnAbort)}.json`), JSON.stringify(session.records(), null, 1));
    }
    throw error;
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}

const live = process.env.OAR_TEST !== "grok-aimock" || process.platform === "win32";

test.skipIf(live)("with endTurnProcessesOnAbort, an aborted Grok turn's command is stopped and the session goes on", async () => {
  const result = await aborted(true);
  expect(result.markerExists).toBe(false);
  expect(result.cleanup).toMatchObject({ body: { kind: "cleanup", result: { kind: "completed", signalled: 1 } } });
  expect(result.next).toMatchObject({ kind: "ended", outcome: { kind: "completed" } });
}, 90_000);

test.skipIf(live)("without it, Grok's cancel leaves the command running and no cleanup is recorded", async () => {
  const result = await aborted(false);
  expect(result.markerExists).toBe(true);
  expect(result.cleanup).toBeUndefined();
}, 90_000);
