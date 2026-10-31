import { expect, test } from "vitest";
import { createSessionKernel } from "../../packages/oar/src/shared/session-kernel.js";
import { createAcpRecorder } from "../../packages/oar/src/shared/acp/records.js";
import { createUsageUpdateGate } from "../../packages/oar/src/shared/acp/usage-wait.js";
import { opencodeChildAttribution } from "../../packages/oar/src/runtimes/opencode/attribution.js";
import { graphOf } from "../../packages/oar/src/observe/index.js";
import type { SessionNotification } from "../../packages/oar/src/shared/acp/process.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

function childUpdate(meta: JsonRecord, update: SessionNotification["update"]): SessionNotification { return { sessionId: "root", update: { ...update, _meta: { "opencode/child-session": meta } } }; }
// oxlint-disable-next-line eslint/max-statements -- Observe immutable history before and after the association becomes known.
test("an unresolved parent frame stays native-only after a later accepted association", () => {
  const kernel = createSessionKernel("root");
  let links: { parent: string; child: string }[] = [];
  const capture = createAcpRecorder(createUsageUpdateGate(), opencodeChildAttribution, undefined, () => links);
  capture.bind(kernel);
  const first = childUpdate({ id: "child", parentID: "pending-parent" }, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "before ownership" } });
  capture.update(first);
  const original = structuredClone(kernel.records()[0]);
  expect(original).toMatchObject({ kind: "frame", body: { native: first, events: [] } });
  links = [{ parent: "root", child: "pending-parent" }, { parent: "pending-parent", child: "child" }];
  capture.update(childUpdate({ id: "child", parentID: "pending-parent" }, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "after ownership" } }));
  expect(kernel.records()[0]).toEqual(original);
  expect(kernel.records().flatMap(r => r.kind === "frame" ? r.body.events.filter(e => e.kind === "text_delta").map(e => e.text) : [])).toEqual(["after ownership"]);
  expect(graphOf(kernel.records()).edges).toHaveLength(2);
});
