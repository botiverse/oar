import { expect, test, vi } from "vitest";
import { RuntimeFailureError, SessionNotFoundError } from "../../packages/oar/src/index.js";
import { cursorSessionWith } from "../../packages/oar/src/runtimes/cursor/session.js";
import type { CursorSdk } from "../../packages/oar/src/runtimes/cursor/sdk.js";
import errors from "../fixtures/missing-resume-errors.json" with { type: "json" };

const agentId = "agent-00000000-0000-4000-8000-000000000294";
const installation = { kind: "available", via: "bundled" } as const;
function sdkWith(error: Error, method: "listRuns" | "resume" | "create" | "models" = "listRuns"): CursorSdk {
  const agent = { agentId, model: { id: "model" }, close: vi.fn(), send: async () => { throw new Error("no prompt expected"); } };
  return {
    Agent: {
      listRuns: async () => { if (method === "listRuns") { throw error; } return { items: [] }; },
      resume: async () => { if (method === "resume") { throw error; } return agent; },
      create: async () => { if (method === "create") { throw error; } return agent; },
    },
    Cursor: { models: { list: async () => { if (method === "models") { throw error; } return []; } } },
  };
}

test.each(["listRuns", "resume"] as const)("Cursor wraps agent_not_found from Agent.%s, preserving native facts", async (method) => {
  const native = Object.assign(new Error(errors.cursor.message), { ...errors.cursor, operation: `Agent.${method}` });
  // A circular cause is SDK internals, not part of the observed diagnostic fields.
  native.cause = native;
  const start = cursorSessionWith(async () => sdkWith(native, method));
  const failure: unknown = await start(installation, { cwd: "/w", resume: agentId, ...(method === "resume" ? { model: "model" } : {}) }).catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SessionNotFoundError);
  expect(failure).toMatchObject({ name: "SessionNotFoundError", sessionId: agentId, message: errors.cursor.message });
  // oxlint-disable-next-line unicorn/prefer-structured-clone -- The host persists this cause as JSON.
  expect(JSON.parse(JSON.stringify(failure instanceof Error ? failure.cause : null))).toEqual({ method: `Agent.${method}`, native: { ...errors.cursor, operation: `Agent.${method}` } });
});

test.each(["listRuns", "resume"] as const)("another SDK failure from Agent.%s keeps its native identity", async (method) => {
  const native = Object.assign(new Error(errors.cursor.message), { code: "network_error" });
  const start = cursorSessionWith(async () => sdkWith(native, method));
  await expect(start(installation, { cwd: "/w", resume: agentId })).rejects.toBe(native);
});

test("Cursor authentication refusal still has its own open-error type", async () => {
  const native = Object.assign(new Error("login refused"), { name: "AuthenticationError", status: 401 });
  const start = cursorSessionWith(async () => sdkWith(native, "resume"));
  const opening = start(installation, { cwd: "/w", resume: agentId, model: "model" });
  await expect(opening).rejects.toBeInstanceOf(RuntimeFailureError);
  await expect(opening).rejects.toMatchObject({ failure: "auth", credential: "rejected" });
});

test("Cursor never maps a new-agent failure or an unrelated model query", async () => {
  const native = Object.assign(new Error(errors.cursor.message), errors.cursor);
  const start = cursorSessionWith(async () => sdkWith(native, "create"));
  await expect(start(installation, { cwd: "/w" })).rejects.toBe(native);
  const models = cursorSessionWith(async () => sdkWith(native, "models"));
  await expect(models(installation, { cwd: "/w", resume: agentId, model: "model", effort: "low" })).rejects.toBe(native);
});
