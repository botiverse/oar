import { expect, test } from "vitest";
import { mcpStartupOf } from "../../packages/oar/src/observe/mcp-startup.js";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import type { Frame } from "../../packages/oar/src/contracts/session.js";

function report(threadId: string | null, name: string, status: string): Frame {
  const fold = foldCodexNotification(initialCodexProjection("root"), "mcpServer/startupStatus/updated", { threadId, name, status });
  const [command] = fold.commands;
  if (command?.kind !== "frame") { throw new Error("missing startup frame"); }
  return { ...command, sessionId: command.sessionId ?? "root", receivedAt: 0, agentPath: [], seq: 0 };
}

test("startup belongs to the named thread and server, and a new start supersedes an old ready report", () => {
  const records = [report("root", "one", "ready"), report("child", "one", "failed"), report("root", "one", "starting"),
    report("root", "two", "cancelled"), report(null, "one", "ready"), report("root", "two", "other")];
  expect(Object.fromEntries(mcpStartupOf(records, "root"))).toEqual({ one: "pending", two: "cancelled" });
  expect(Object.fromEntries(mcpStartupOf(records, "child"))).toEqual({ one: "failed" });
  expect(records[4]?.body.events).toEqual([]);
  expect(records[5]?.body.events).toEqual([]);
});
