import assert from "node:assert/strict";
import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

export function assertPlacement(runtime: Runtime, session: Session): void {
  if (runtime.execution === "in_process") {
    assert.equal(session.placement, "in_process", "SDK execution agrees with the opened session");
  } else if (runtime.execution === "process") {
    assert.ok(session.placement === "isolated" || session.placement === "shared", "process execution opens a process placement");
    if (runtime.placement !== "auto") { assert.equal(session.placement, runtime.placement); }
  }
  if (session.placement === null) { return; } // Legacy custom adapters make no placement claim.
  const [request, response] = session.records();
  assert.ok(request?.kind === "request" && request.body.kind === "open", "placement starts with an open request");
  assert.ok(response?.kind === "response", "placement has an observed opening response");
  assert.deepEqual([request.seq, response.seq, request.direction, response.requestId], [0, 1, "toRuntime", request.id]);
  assert.deepEqual(response.body, { kind: "opened", placement: session.placement });
  assert.ok(["auto", "shared", "isolated"].includes(request.body.placement));
}
