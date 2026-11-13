/* oxlint-disable eslint/max-lines-per-function, eslint/max-statements -- Each recorded native run is one regression with its complete record assertions. */
/* oxlint-disable import/max-dependencies -- Replays the same evidence through the live session and the bare recorder. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "vitest";
import type { RawEvent } from "../../packages/oar/src/contracts/session.js";
import { graphOf, promptAndWait, statusOf, tasksOf } from "../../packages/oar/src/observe/index.js";
import { opencodeChildAttribution } from "../../packages/oar/src/runtimes/opencode/attribution.js";
import { opencodeBackgroundChildProfile, opencodeV2AcpProfile } from "../../packages/oar/src/runtimes/opencode/session.js";
import { hasBackgroundChildUpdates, opencodeRelease } from "../../packages/oar/src/runtimes/opencode/version.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { acpSession, type AcpSessionProfile } from "../../packages/oar/src/shared/acp/session.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { asRecord, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import type { SessionNotification } from "../../packages/oar/src/shared/acp/process.js";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";

const evidence = (name: string): string => fileURLToPath(new URL(`../../experiments/opencode-child-background/${name}`, import.meta.url));
const replayAgent = fileURLToPath(new URL("../fixtures/fake-acp-opencode-replay.mjs", import.meta.url));
const CHILD_UPDATE = "opencode/session/child_update";

interface WireFrame { readonly atMs: number; readonly direction?: string; readonly message: JsonRecord }
function wireOf(name: string): WireFrame[] {
  const text = readFileSync(evidence(name), "utf8");
  const recorded = asRecord(parseJson(text));
  assert.ok(Array.isArray(recorded?.wire));
  // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Recorded native evidence, read verbatim.
  return recorded.wire as WireFrame[];
}
/** The native runtime→client notifications, in recorded order. */
function notificationsOf(name: string): { readonly method: string; readonly params: JsonRecord }[] {
  return wireOf(name).flatMap(({ direction, message }) => {
    const params = asRecord(message.params);
    return direction === undefined && typeof message.method === "string" && params !== null ? [{ method: message.method, params }] : [];
  });
}
const frames = (log: readonly RawEvent[], sessionId: string) => log.flatMap((entry) => entry.kind === "frame" && entry.sessionId === sessionId ? [entry] : []);
const eventsOf = (log: readonly RawEvent[], sessionId: string) => frames(log, sessionId).flatMap((entry) => entry.body.events);

async function replay(profile: AcpSessionProfile, name: string) {
  const directory = mkdtempSync(path.join(os.tmpdir(), "oar-opencode-child-"));
  const capture = path.join(directory, "initialize.json");
  const session = await acpSession({ ...profile, args: [replayAgent, evidence(name), capture] })(
    { kind: "available", via: "executable", command: process.execPath }, { cwd: process.cwd() },
  );
  return {
    session,
    /** OAR's `initialize` params as the agent received them. */
    clientCapabilities: () => {
      const params = asRecord(parseJson(readFileSync(capture, "utf8")));
      return asRecord(params?.clientCapabilities);
    },
    cleanup: async () => { await session.dispose(); rmSync(directory, { recursive: true, force: true }); },
  };
}

test("2.3.0 replay: the declared capability delivers background child text and completion after the parent prompt returns", async () => {
  const { session, clientCapabilities, cleanup } = await replay(opencodeBackgroundChildProfile, "enabled.json");
  try {
    expect(clientCapabilities()).toMatchInlineSnapshot(`
      {
        "_meta": {
          "opencode/child-session-updates": true,
        },
        "fs": {
          "readTextFile": false,
          "writeTextFile": false,
        },
        "terminal": true,
      }
    `);
    const run = await promptAndWait(session, "ACP_SHARE_A_child");
    expect(run.kind).toBe("ended");
    await expect.poll(() => session.records().filter((record) => record.kind === "frame" && record.body.type === CHILD_UPDATE).length).toBe(4);
    await expect.poll(() => eventsOf(session.records(), "session-1").filter((event) => event.kind === "text_delta").length).toBe(2);
    const records = session.records();
    // Every native extension notification is one frame, verbatim, never dropped.
    const native = notificationsOf("enabled.json").filter(({ method }) => method === CHILD_UPDATE).map(({ params }) => params);
    expect(records.flatMap((record) => record.kind === "frame" && record.body.type === CHILD_UPDATE ? [record.body.native] : [])).toEqual(native);
    // The parent prompt ended first; the child's text and completion arrived later and still landed.
    const turnEnds = frames(records, "session-1").filter((record) => record.body.events.some((event) => event.kind === "turn_ended"));
    expect(turnEnds).toHaveLength(1);
    const childText = frames(records, "session-2").find((record) => record.body.events.some((event) => event.kind === "text_delta"));
    const completed = records.find((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "task_ended"));
    assert.ok(childText !== undefined && completed !== undefined && turnEnds[0] !== undefined);
    expect(childText.seq).toBeGreaterThan(turnEnds[0].seq);
    expect(completed.seq).toBeGreaterThan(childText.seq);
    expect(eventsOf(records, "session-2")).toMatchInlineSnapshot(`
      [
        {
          "kind": "text_delta",
          "text": "ANSWER_A_childreply",
        },
      ]
    `);
    // Child output is never root output; the root's own late reply stays the root's.
    expect(eventsOf(records, "session-1").flatMap((event) => event.kind === "text_delta" ? [event.text] : [])).toEqual(["ANSWER_A_child", "ANSWER_A_child"]);
    // The edge is proven by the subagent call's own output naming the child.
    const linked = records.filter((record) => record.kind === "frame" && record.body.events.some((event) => event.kind === "session_linked"));
    expect(linked.map((record) => record.kind === "frame" ? { sessionId: record.sessionId, type: record.body.type, native: asRecord(asRecord(record.body.native)?.update)?.rawOutput } : null)).toMatchInlineSnapshot(`
      [
        {
          "native": {
            "metadata": {
              "sessionID": "session-2",
              "status": "running",
              "truncated": false,
            },
          },
          "sessionId": "session-1",
          "type": "tool_call_update",
        },
      ]
    `);
    expect(session.graph()).toEqual(graphOf(records));
    expect(session.graph()).toMatchInlineSnapshot(`
      {
        "edges": [
          {
            "child": "session-2",
            "parent": "session-1",
            "via": "tool_call",
          },
        ],
        "nodes": [
          {
            "id": "session-1",
          },
          {
            "id": "session-2",
          },
        ],
      }
    `);
    // The lifecycle is the parent's task; late completion neither reopens nor ends the root turn.
    expect(tasksOf(records, "session-1").value.map(({ taskId, status, childSessionId, background, description }) => ({ taskId, status, childSessionId, background, description }))).toMatchInlineSnapshot(`
      [
        {
          "background": true,
          "childSessionId": "session-2",
          "description": "Check child routing",
          "status": "completed",
          "taskId": "session-2",
        },
      ]
    `);
    // Child records after the parent's end leave the root idle. The root's own later reply
    // (the parent model answering the native completion report) is a separate native turn
    // with no ACP end, and only it makes the existing status fold adopt a running turn.
    const rootWake = frames(records, "session-1").at(-1);
    assert.ok(rootWake !== undefined && rootWake.seq > completed.seq);
    expect(statusOf(records.filter((record) => record.seq !== rootWake.seq), "session-1").value.kind).toBe("idle");
    expect(statusOf(records, "session-1").value).toEqual(session.status().value);
    expect(session.status().value.kind).toBe("running");
    const seen: string[] = [];
    session.events((event) => { if (event.sessionId === "session-2" && event.kind === "text_delta") { seen.push(event.text); } }, { cursor: { sessionId: "session-1", afterSeq: -1 } })();
    expect(seen).toEqual(["ANSWER_A_childreply"]);
  } finally {
    await cleanup();
  }
});

test("disabled control on the 2.2 profile: no capability is declared and 2.3.0 sends no child frame to attribute", async () => {
  const { session, clientCapabilities, cleanup } = await replay(opencodeV2AcpProfile, "disabled.json");
  try {
    expect(clientCapabilities()).not.toHaveProperty("_meta");
    const run = await promptAndWait(session, "ACP_SHARE_A_child");
    expect(run.kind).toBe("ended");
    await expect.poll(() => eventsOf(session.records(), "session-1").filter((event) => event.kind === "text_delta").length).toBe(2);
    expect(session.records().every((record) => record.sessionId === "session-1")).toBe(true);
    expect(session.graph()).toEqual({ nodes: [{ id: "session-1" }], edges: [] });
    expect(tasksOf(session.records(), "session-1").value).toEqual([]);
  } finally {
    await cleanup();
  }
});

test("only 2.3 and later declare the capability; 2.2 profiles keep the standard child projection", async () => {
  const installation = { kind: "available", via: "executable", command: "opencode" } as const;
  const releases = await Promise.all(["2.2.5", "2.2.7", "opencode v2.3.0", "2.3.1-beta.1", "2.4.0", "1.18.35"].map(async (version) => opencodeRelease({ ...installation, version })));
  expect(releases.map((release) => hasBackgroundChildUpdates(release))).toEqual([false, false, true, true, true, false]);
  expect(opencodeV2AcpProfile.clientCapabilitiesMeta).toBeUndefined();
  expect(opencodeV2AcpProfile.extensionNotifications ?? []).not.toContain(CHILD_UPDATE);
  expect(opencodeBackgroundChildProfile.clientCapabilitiesMeta?.({ cwd: "/" })).toEqual({ "opencode/child-session-updates": true });
  expect(opencodeBackgroundChildProfile.extensionNotifications).toEqual([CHILD_UPDATE]);
});

/** Feed recorded notifications through the real recorder and projection, without a process. */
function recordNative(notifications: readonly { readonly method: string; readonly params: JsonRecord }[]) {
  const kernel = createSessionKernel("session-1");
  const profile = opencodeBackgroundChildProfile;
  const recorder = createAcpRecorder(createUsageUpdateGate(), profile.attributeUpdate, undefined, undefined, profile.projectUpdate, profile.projectExtension, undefined, profile);
  recorder.bind(kernel);
  for (const { method, params } of notifications) {
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- Recorded native notifications, validated by the SDK in a live session.
    if (method === "session/update") { recorder.update(params as unknown as SessionNotification); } else { recorder.extension(method, params); }
  }
  return kernel;
}
const enabled = notificationsOf("enabled.json");
const isSpawnReport = ({ params }: { readonly params: JsonRecord }): boolean => asRecord(asRecord(params.update)?.rawOutput) !== null;
const links = (records: readonly RawEvent[]) => records.flatMap((record) => record.kind === "frame" ? record.body.events.flatMap((event) => event.kind === "session_linked" ? [{ type: record.body.type, sessionId: record.sessionId, event }] : []) : []);

test("tool output before the first child notification links on that notification instead", () => {
  const spawn = enabled.filter((entry) => isSpawnReport(entry));
  const kernel = recordNative([...spawn, ...enabled.filter((entry) => !isSpawnReport(entry))]);
  expect(links(kernel.records())).toEqual([{ type: CHILD_UPDATE, sessionId: "session-1", event: { kind: "session_linked", parent: "session-1", child: "session-2", via: "tool_call" } }]);
});

test("without the spawning tool output the child keeps its node and records, but no edge is fabricated", () => {
  const kernel = recordNative(enabled.filter((entry) => !isSpawnReport(entry)));
  expect(links(kernel.records())).toEqual([]);
  expect(kernel.graph()).toEqual({ nodes: [{ id: "session-1" }, { id: "session-2" }], edges: [] });
  expect(eventsOf(kernel.records(), "session-2").map((event) => event.kind)).toEqual(["text_delta"]);
});

test("a spawn report from another session does not prove the claimed parent", () => {
  const moved = enabled.map((entry) => isSpawnReport(entry) ? { ...entry, params: { ...entry.params, sessionId: "session-9" } } : entry);
  expect(links(recordNative(moved).records())).toEqual([]);
});

test("a standard copy of a child update already seen on the extension is retained without duplicate events", () => {
  const extension = enabled.find(({ method, params }) => method === CHILD_UPDATE && params.type === "update");
  assert.ok(extension !== undefined);
  const update = asRecord(extension.params.update);
  assert.ok(update !== null);
  // Synthetic: 2.3.0 never sends both channels (translate.ts `route`); the recorded enabled run had none.
  const legacy = { sessionId: "session-1", update };
  expect(opencodeChildAttribution(legacy)).toEqual({ sessionId: "session-2", parent: "session-1" });
  const kernel = recordNative([...enabled, { method: "session/update", params: legacy }]);
  const last = kernel.records().at(-1);
  expect(last).toMatchObject({ kind: "frame", sessionId: "session-2", body: { type: "agent_message_chunk", native: legacy, events: [] } });
  expect(eventsOf(kernel.records(), "session-2").filter((event) => event.kind === "text_delta")).toHaveLength(1);
});

test("a nested child links its reported parent from that parent's own spawn report", () => {
  // Synthetic depth 2: 2.3.0 projects a grandchild with the same envelope and the middle child's prefixed tool call.
  const nested = (type: string, extra: JsonRecord): { method: string; params: JsonRecord } => ({ method: CHILD_UPDATE, params: {
    rootSessionId: "session-1", childSessionId: "session-3", parentSessionId: "session-2", depth: 2, title: "nested", type, ...extra } });
  const middleSpawn = { method: CHILD_UPDATE, params: {
    rootSessionId: "session-1", childSessionId: "session-2", parentSessionId: "session-1", depth: 1, type: "update",
    update: { sessionUpdate: "tool_call_update", toolCallId: "session-2:call-B", status: "completed", rawOutput: { metadata: { sessionID: "session-3", status: "running" } } } } };
  const kernel = recordNative([...enabled, nested("status", { status: "created" }), middleSpawn,
    nested("update", { update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "deep" } } }), nested("status", { status: "completed" })]);
  expect(kernel.graph().edges).toEqual([
    { parent: "session-1", child: "session-2", via: "tool_call" },
    { parent: "session-2", child: "session-3", via: "tool_call" },
  ]);
  expect(eventsOf(kernel.records(), "session-3").map((event) => event.kind)).toEqual(["text_delta"]);
  expect(tasksOf(kernel.records(), "session-1").value.map(({ sessionId, taskId, status }) => ({ sessionId, taskId, status }))).toEqual([
    { sessionId: "session-1", taskId: "session-2", status: "completed" },
    { sessionId: "session-2", taskId: "session-3", status: "completed" },
  ]);
});
