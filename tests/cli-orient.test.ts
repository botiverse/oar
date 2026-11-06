import { afterEach, expect, test, vi } from "vitest";
import { RuntimeRegistry, defineRuntime } from "../packages/oar/src/index.js";
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

test.each([["--depth", "invalid"], ["--timeout", "0"], ["--env", "no-equals"], ["--env", "=value"]])("invalid orient arguments fail before probing: %j", async (...args) => {
  const command = orientationCommand(registry()).exitOverride().configureOutput({ writeErr: () => {} });
  await expect(command.parseAsync(args, { from: "user" })).rejects.toThrow();
});

test("orient threads --env pairs into the account usage probe", async () => {
  const seen: unknown[] = [];
  const probing = new RuntimeRegistry([defineRuntime({
    id: "probe",
    installation: async () => ({ kind: "available", via: "executable", command: "/bin/fake", version: "1.0.0" }),
    accountUsage: async (_installation, options) => {
      seen.push(options?.env);
      return { kind: "available", rateLimited: false, windows: [] };
    },
    session: async () => { throw new Error("must not run"); },
  })]);
  vi.spyOn(process.stdout, "write").mockReturnValue(true);
  const command = orientationCommand(probing).exitOverride();
  await command.parseAsync(["probe", "--depth", "account", "--json", "--env", "KIMI_CODE_HOME=/tmp/home-b", "--env", "X=1"], { from: "user" });
  expect(seen).toEqual([{ KIMI_CODE_HOME: "/tmp/home-b", X: "1" }]);
});

test("the human table exposes uncertainty instead of treating missing auth as signed in", async () => {
  const { orient } = await import("../packages/oar/src/index.js");
  const snapshot = await orient(registry());
  expect(renderOrientation(snapshot)).toContain("missing\t\tnot_installed");
});
