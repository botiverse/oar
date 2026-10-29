import assert from "node:assert/strict";
import type { Session } from "../../packages/oar/src/contracts/session.js";

export function assertPlacement(session: Session): void {
  if (session.placement === null) { return; } // Legacy custom adapters make no placement claim.
  const [request, response] = session.records();
  assert.ok(request?.kind === "request" && request.body.kind === "open", "placement starts with an open request");
  assert.ok(response?.kind === "response", "placement has an observed opening response");
  assert.deepEqual([request.seq, response.seq, request.direction, response.requestId], [0, 1, "toRuntime", request.id]);
  assert.deepEqual(response.body, { kind: "opened", placement: session.placement });
  assert.ok(["auto", "shared", "isolated"].includes(request.body.placement));
}
