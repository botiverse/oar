import { expect, test } from "vitest";
import { createAcpOpening } from "../../packages/oar/src/shared/acp/opening.js";

test.each([
  { name: "unrelated response", response: { jsonrpc: "2.0", id: 2, result: {} } },
  { name: "refused open", response: { jsonrpc: "2.0", id: 1, error: { code: -32_603, message: "refused" } } },
] as const)("$name does not mark notifications as live", ({ response }) => {
  const opening = createAcpOpening();
  const params = { sessionId: "root" };
  opening.outgoing({ jsonrpc: "2.0", id: 1, method: "session/resume", params: {} });
  opening.incoming(response);
  opening.incoming({ jsonrpc: "2.0", method: "_x.ai/session_notification", params });
  expect(opening.afterOpen(params)).toBe(false);
});

test("an initialize answer does not open a session, and an unknown params object stays excluded", () => {
  const opening = createAcpOpening();
  const params = { sessionId: "root" };
  opening.outgoing({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} });
  opening.incoming({ jsonrpc: "2.0", id: 1, result: {} });
  opening.incoming({ jsonrpc: "2.0", method: "_x.ai/session_notification", params });
  expect(opening.afterOpen(params)).toBe(false);
  expect(opening.afterOpen({})).toBe(false);
});
