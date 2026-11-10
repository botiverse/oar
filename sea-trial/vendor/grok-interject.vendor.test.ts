/* oxlint-disable max-statements -- One live native turn per case, end to end. */
import { mkdtemp, rm } from "node:fs/promises";
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
 * it, and an abort must drop a not-yet-taken interjection.
 */
const user = (request: unknown): string => {
  const messages: unknown = asRecord(request)?.messages;
  const last: unknown = Array.isArray(messages) ? messages.findLast((message: unknown) => ["user", "tool"].includes(String(asRecord(message)?.role))) : undefined;
  return JSON.stringify(asRecord(last)?.content ?? "");
};
const hasTools = (request: unknown): boolean => { const tools = asRecord(request)?.tools; return Array.isArray(tools) && tools.length > 0; };
const sleepTool = (id: string, seconds: number) => ({ toolCalls: [{ id, name: "run_terminal_command", arguments: JSON.stringify({ command: `sleep ${seconds}; echo slept-${id}`, description: "sleep" }) }] });
const toolStarted = (records: readonly RawEvent[]) => records.some((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "tool_call_started"));
const until = async (check: () => boolean, ms = 30_000): Promise<void> => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline) { await new Promise((resolve) => { setTimeout(resolve, 50); }); }
  expect(check()).toBe(true);
};

async function withGrok(run: (session: Session, provider: AcpAimockEnv) => Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "oar-grok-interject-"));
  const provider = await startGrokAimock((mock) => {
    mock.on({ predicate: (request) => !hasTools(request) }, { content: "a title" });
    mock.on({ predicate: (request) => user(request).includes("STEER_TEXT") }, { content: "took-steer" });
    mock.on({ predicate: (request) => user(request).includes("slept-") }, { content: "after-tool" });
    mock.on({ predicate: (request) => user(request).includes("RUN_SLOW") }, sleepTool("slow", 4));
    mock.on({ predicate: () => true }, { content: "ok" });
  });
  let session: Session | undefined = undefined;
  try {
    const installation = await grokInstallation();
    if (installation.kind !== "available") { throw new Error("Grok unavailable"); }
    session = await grokSession(installation, { cwd: root, env: provider.env });
    await run(session, provider);
  } finally { await session?.dispose(); await provider.stop(); await rm(root, { recursive: true, force: true }); }
}

test.skipIf(process.env.OAR_TEST !== "grok-aimock")("a steer joins Grok's running turn without cancelling it", async () => {
  await withGrok(async (session, provider) => {
    const started = await session.prompt("RUN_SLOW");
    await until(() => toolStarted(session.records()));
    expect(await session.steer?.("STEER_TEXT")).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "completed" });
    expect(provider.raw.some(({ body }) => JSON.stringify(body).includes("STEER_TEXT"))).toBe(true);
    const ends = session.records().flatMap((record) => record.kind === "frame" ? record.body.events.filter((event) => event.kind === "turn_ended") : []);
    expect(ends).toHaveLength(1);
    expect(session.status().value.kind).toBe("idle");
  });
}, 120_000);

test.skipIf(process.env.OAR_TEST !== "grok-aimock")("abort drops an interjection Grok has not taken", async () => {
  await withGrok(async (session, provider) => {
    const started = await session.prompt("RUN_SLOW");
    await until(() => toolStarted(session.records()));
    expect(await session.steer?.("STEER_TEXT")).toMatchObject({ kind: "accepted" });
    expect(await session.abort()).toMatchObject({ kind: "accepted" });
    expect(await awaitTurnEnd(session, started.seq)).toMatchObject({ kind: "aborted" });
    await new Promise((resolve) => { setTimeout(resolve, 6000); });
    expect(provider.raw.some(({ body }) => JSON.stringify(body).includes("STEER_TEXT"))).toBe(false);
    expect(session.status().value.kind).toBe("idle");
  });
}, 120_000);
