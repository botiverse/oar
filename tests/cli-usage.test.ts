import { afterEach, expect, test, vi } from "vitest";
import { RuntimeRegistry, defineRuntime, type AccountUsageReadOptions, type AccountUsageSnapshot } from "../packages/oar/src/index.js";
import { parseEnvOptions } from "../packages/cli/src/env-option.js";
import { usageCommand } from "../packages/cli/src/usage.js";

afterEach(() => { vi.restoreAllMocks(); });

const SNAPSHOT: AccountUsageSnapshot = {
  kind: "available",
  email: "agent@example.com",
  rateLimited: false,
  windows: [{ label: "Weekly limit", usedRatio: 0.5 }],
};

function registry(captured: { current?: AccountUsageReadOptions }) {
  const runtime = defineRuntime({
    id: "probe",
    session: async () => { throw new Error("must not run"); },
    installation: async () => ({ kind: "available" as const, via: "executable" as const, command: "/bin/probe", version: "0.0.1" }),
    accountUsage: async (_installation, options?: AccountUsageReadOptions) => {
      captured.current = options ?? {};
      return SNAPSHOT;
    },
  });
  return new RuntimeRegistry([runtime]);
}

test("usage --env threads the overlay to the account usage reader", async () => {
  const captured: { current?: AccountUsageReadOptions } = {};
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const command = usageCommand(registry(captured)).exitOverride();
  await command.parseAsync(["probe", "--env", "KIMI_CODE_HOME=/home/a", "--env", "KIMI_CODE_MARKER=x=y"], { from: "user" });
  expect(captured.current?.env).toEqual({ KIMI_CODE_HOME: "/home/a", KIMI_CODE_MARKER: "x=y" });
  const report: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
  expect(report).toMatchObject([{ runtimeId: "probe", accountUsage: SNAPSHOT }]);
});

test("usage without --env reads the default environment (no overlay)", async () => {
  const captured: { current?: AccountUsageReadOptions } = {};
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const command = usageCommand(registry(captured)).exitOverride();
  await command.parseAsync(["probe"], { from: "user" });
  expect(captured.current?.env).toBeUndefined();
  expect(output).toHaveBeenCalled();
});

test("usage rejects a malformed --env before probing", async () => {
  const command = usageCommand(registry({})).exitOverride().configureOutput({ writeErr: () => {} });
  await expect(command.parseAsync(["probe", "--env", "=value"], { from: "user" })).rejects.toThrow();
});

test.each([
  [[], undefined],
  [undefined, undefined],
  [["A=1", "A=2", "B="], { A: "2", B: "" }],
  [["NO_EQUALS"], { NO_EQUALS: "" }],
] as const)("parseEnvOptions(%j) -> %j", (values, expected) => {
  expect(parseEnvOptions(values)).toEqual(expected);
});
