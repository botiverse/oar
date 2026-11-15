import { expect, test } from "vitest";
import acpFixtureMethodsByInstance from "../fixtures/acp-trace.js";

test("reusing an exited fixture's PID does not combine its methods with a refused launch", () => {
  // A new controlled sample, not the missing trace from the Windows CI failure.
  const rows = [
    { instanceId: "original", pid: 101, method: "initialize" },
    { instanceId: "original", pid: 101, method: "session/new" },
    { instanceId: "original", pid: 101, method: "session/close" },
    { instanceId: "refused-auto", pid: 101, method: "initialize" },
    { instanceId: "isolated", pid: 202, method: "initialize" },
    { instanceId: "isolated", pid: 202, method: "session/new" },
    { instanceId: "refused-shared", pid: 303, method: "initialize" },
  ];
  const methods = acpFixtureMethodsByInstance(rows.map(row => JSON.stringify(row)).join("\n"));
  expect([...methods.values()].filter(value => value.length === 1 && value[0] === "initialize")).toHaveLength(2);
  expect([...methods]).toEqual([
    ["original", ["initialize", "session/new", "session/close"]],
    ["refused-auto", ["initialize"]],
    ["isolated", ["initialize", "session/new"]],
    ["refused-shared", ["initialize"]],
  ]);
});
