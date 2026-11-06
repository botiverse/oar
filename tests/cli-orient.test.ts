import { afterEach, expect, test, vi } from "vitest";
import { RuntimeRegistry, defineRuntime, type AccountUsageReadOptions } from "../packages/oar/src/index.js";
import { orientationCommand, renderOrientation } from "../packages/cli/src/orient.js";

afterEach(() => { vi.restoreAllMocks(); });
function registry() {
  return new RuntimeRegistry([defineRuntime({ id: "missing", installation: async () => ({ kind: "not_found" }), session: async () => { throw new Error("must not run"); } })]);
}

test("orient JSON command prints a complete snapshot, including missing installations", async () => {
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const command = orientationCommand(registry()).exitOverride();
  await command.parseAsync(["missing", "--depth", "models", "--json"], { from: "user" });
  const raw = output.mock.calls[0]?.[0];
  expect(typeof raw).toBe("string");
  const parsed: unknown = JSON.parse(String(raw));
  expect(parsed).toMatchObject({ depth: "models", runtimes: [{ id: "missing", installation: { kind: "ok", value: { kind: "not_found" } }, models: { kind: "unsupported" } }] });
});

test.each([["--depth", "invalid"], ["--timeout", "0"]])("invalid orient arguments fail before probing: %j", async (...args) => {
  const command = orientationCommand(registry()).exitOverride().configureOutput({ writeErr: () => {} });
  await expect(command.parseAsync(args, { from: "user" })).rejects.toThrow();
});

test("the human table exposes uncertainty instead of treating missing auth as signed in", async () => {
  const { orient } = await import("../packages/oar/src/index.js");
  const snapshot = await orient(registry());
  expect(renderOrientation(snapshot)).toContain("missing\t\tnot_installed");
});

test("orient --env threads the overlay to the account usage probe", async () => {
  const captured: { current?: unknown } = {};
  const usageRuntime = defineRuntime({
    id: "envprobe",
    session: async () => { throw new Error("must not run"); },
    installation: async () => ({ kind: "available" as const, via: "executable" as const, command: "/bin/envprobe", version: "0.0.1" }),
    accountUsage: async (_installation, options?: AccountUsageReadOptions) => {
      captured.current = options?.env;
      return { kind: "available", email: "agent@example.com", rateLimited: false, windows: [{ label: "Weekly limit", usedRatio: 0 }] };
    },
  });
  const output = vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const command = orientationCommand(new RuntimeRegistry([usageRuntime])).exitOverride();
  await command.parseAsync(["envprobe", "--depth", "account", "--json", "--env", "KIMI_CODE_HOME=/home/b"], { from: "user" });
  expect(captured.current).toEqual({ KIMI_CODE_HOME: "/home/b" });
  const parsed: unknown = JSON.parse(String(output.mock.calls[0]?.[0]));
  expect(parsed).toMatchObject({ runtimes: [{ id: "envprobe", accountUsage: { kind: "ok", value: { kind: "available", email: "agent@example.com" } } }] });
});
