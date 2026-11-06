import { expect, test } from "vitest";
import { foldCodexNotification, initialCodexProjection, type CodexProjectionState, type ProjectionCommand } from "../../packages/oar/src/runtimes/codex/projection.js";
import type { JsonRecord } from "../../packages/oar/src/shared/json.js";

const ROOT = "thread-root";
const CHILD = "thread-child";
const events = (commands: readonly ProjectionCommand[]): unknown => commands.flatMap((command) => command.kind === "frame" ? command.body.events : []);
const reconnect = (threadId: string, n: number): JsonRecord => ({ threadId, willRetry: true, error: { message: `Reconnecting... ${String(n)}/5`, additionalDetails: "stream closed" } });
const retry = (attempt: number): unknown => [{ kind: "retry", attempt, reason: `Reconnecting... ${String(attempt)}/5: stream closed` }];
const reconnected = (state: CodexProjectionState, threadId: string, n: number): ReturnType<typeof foldCodexNotification> => foldCodexNotification(state, "error", reconnect(threadId, n));
const turnEnded = (state: CodexProjectionState, threadId: string): CodexProjectionState => foldCodexNotification(state, "turn/completed", { threadId, turn: { id: "turn", status: "completed" } }).state;

test("a native reconnect is a retry whose attempt OAR counts within the turn", () => {
  const first = reconnected(initialCodexProjection(ROOT), ROOT, 1);
  expect(events(first.commands)).toEqual(retry(1));
  expect(events(reconnected(first.state, ROOT, 2).commands)).toEqual(retry(2));
});

test("each thread counts its own, and a next turn counts from one", () => {
  const root = reconnected(initialCodexProjection(ROOT), ROOT, 1);
  const child = reconnected(root.state, CHILD, 1);
  expect(events(child.commands)).toEqual(retry(1));
  const childEnded = turnEnded(child.state, CHILD);
  expect(events(reconnected(childEnded, ROOT, 2).commands)).toEqual(retry(2));
  const nextTurn = turnEnded(childEnded, ROOT);
  expect(events(reconnected(nextTurn, ROOT, 1).commands)).toEqual(retry(1));
});

test.each([false, undefined])("an error with willRetry %s only details the failure", (willRetry) => {
  const final = foldCodexNotification(initialCodexProjection(ROOT), "error", { threadId: ROOT, ...(willRetry === undefined ? {} : { willRetry }), error: { message: "boom" } });
  expect(events(final.commands)).toEqual([]);
  expect(final.state.lastErrorDetail).toBe("boom");
  expect(final.state.retries.size).toBe(0);
});

test("a reconnect with no message still counts, without an empty reason", () => {
  const bare = foldCodexNotification(initialCodexProjection(ROOT), "error", { threadId: ROOT, willRetry: true });
  expect(events(bare.commands)).toEqual([{ kind: "retry", attempt: 1 }]);
});

test("a child's turn end keeps the root's failure detail", () => {
  const failed = foldCodexNotification(initialCodexProjection(ROOT), "error", { threadId: ROOT, error: { message: "boom" } }).state;
  expect(turnEnded(failed, CHILD).lastErrorDetail).toBe("boom");
  expect(turnEnded(failed, ROOT).lastErrorDetail).toBeNull();
});
