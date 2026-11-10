/* oxlint-disable max-statements -- One live native turn per case, end to end. */
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "vitest";
import { awaitTurnEnd, grokInstallation, grokSession, type RawEvent, type Session } from "../../packages/oar/src/index.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { startGrokAimock, type AcpAimockEnv } from "../harness/aimock-acp.js";

/*
 * Grok's `_x.ai/interject` through OAR's steer, against a scripted provider.
 * The model asks for a slow command; OAR steers while it runs. The steer must
 * reach the next provider request inside the same turn, without cancelling
 * it, and an abort must drop a not-yet-taken interjection. The command is
 * one word per platform: on Windows Grok ran `sleep 4; echo ...` as `sleep`
 * with the argument `4;`, which failed at once and ended the turn before the
 * steer (2026-11-10, CI run 42880524360).
 */
const user = (request: unknown): string => {
  const messages: unknown = asRecord(request)?.messages;
  const last: unknown = Array.isArray(messages) ? messages.findLast((message: unknown) => ["user", "tool"].includes(String(asRecord(message)?.role))) : undefined;
  return JSON.stringify(asRecord(last)?.content ?? "");
};
const hasTools = (request: unknown): boolean => { const tools = asRecord(request)?.tools; return Array.isArray(tools) && tools.length > 0; };
const lastRole = (request: unknown): string => {
  const messages: unknown = asRecord(request)?.messages;
  return Array.isArray(messages) ? String(asRecord(messages.at(-1))?.role) : "";
};
const SLOW = process.platform === "win32" ? "ping -n 5 127.0.0.1" : "sleep 4";
const slowTool = { toolCalls: [{ id: "slow", name: "run_terminal_command", arguments: JSON.stringify({ command: SLOW, description: "wait a few seconds" }) }] };
const events = (records: readonly RawEvent[]) => records.flatMap((record) => record.kind === "frame" ? record.body.events : []);
const toolStarted = (records: readonly RawEvent[]) => events(records).some((event) => event.kind === "tool_call_started");
const toolEnded = (records: readonly RawEvent[]) => events(records).some((event) => event.kind === "tool_call_ended");
const until = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) { await new Promise((resolve) => { setTimeout(resolve, 50); }); }
  expect(check()).toBe(true);
};

/** On failure the records go next to the provider evidence, so the order of tool, steer and abort can be read. */
async function retain(name: string, session: Session | undefined): Promise<void> {
  if (session === undefined) { return; }
  const out = path.resolve(process.env.OAR_TRIAL_RUN_DIR ?? "oar-trial-run", "grok-interject");
  await mkdir(out, { recursive: true });
  await writeFile(path.join(out, `${name}.json`), JSON.stringify(session.records(), null, 1));
}

async function withGrok(name: string, run: (session: Session, provider: AcpAimockEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-interject-"));
  const provider = await startGrokAimock((mock) => {
    mock.on({ predicate: (request) => !hasTools(request) }, { content: "a title" });
    mock.on({ predicate: (request) => user(request).includes("STEER_TEXT") }, { content: "took-steer" });
    mock.on({ predicate: (request) => lastRole(request) === "tool" }, { content: "after-tool" });
    mock.on({ predicate: (request) => user(request).includes("RUN_SLOW") }, slowTool);
    mock.on({ predicate: () => true }, { content: "ok" });
  });
  let session: Session | undefined = undefined;
  try {
    const installation = await grokInstallation();
    if (installation.kind !== "available") { throw new Error("Grok unavailable"); }
    session = await grokSession(installation, { cwd: root, env: provider.env });
    await run(session, provider);
  } catch (error) {
    await retain(name, session);
    throw error;
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}

test.skipIf(process.env.OAR_TEST !== "grok-aimock")("a steer joins Grok's running turn without cancelling it", async () => {
  await withGrok("steer", async (session, provider) => {
    const started = await session.prompt("RUN_SLOW");
    await until(() => toolStarted(session.records()));
    expect(toolEnded(session.records())).toBe(false);
    expect(await session.steer?.("STEER_TEXT")).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "completed" });
    expect(provider.raw.some(({ body }) => JSON.stringify(body).includes("STEER_TEXT"))).toBe(true);
    const ends = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "turn_ended") : []);
    expect(ends).toHaveLength(1);
    expect(session.status().value.kind).toBe("idle");
  });
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "grok-aimock")("abort drops an interjection Grok has not taken", async () => {
  await withGrok("abort", async (session, provider) => {
    const started = await session.prompt("RUN_SLOW");
    await until(() => toolStarted(session.records()));
    expect(toolEnded(session.records())).toBe(false);
    expect(await session.steer?.("STEER_TEXT")).toMatchObject({ kind: "accepted" });
    expect(toolEnded(session.records())).toBe(false);
    expect(await session.abort()).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "aborted" });
    await new Promise((resolve) => { setTimeout(resolve, 6000); });
    expect(provider.raw.some(({ body }) => JSON.stringify(body).includes("STEER_TEXT"))).toBe(false);
    expect(session.status().value.kind).toBe("idle");
  });
}, 120_000);
