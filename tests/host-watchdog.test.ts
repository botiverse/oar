import { afterEach, expect, test, vi } from "vitest";
import { hostWatchdogTarget } from "../packages/oar/src/shared/executable/host-watchdog.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

const target = { command: "opencode", args: ["serve"] };

test("the watchdog runs as this host's own Node, with ELECTRON_RUN_AS_NODE only for itself", () => {
  const launch = hostWatchdogTarget(target, { ELECTRON_RUN_AS_NODE: "0" });
  expect(launch?.command).toBe(process.execPath);
  expect(launch?.env.ELECTRON_RUN_AS_NODE).toBe("1");
  // The command gets the environment's own value back.
  expect(JSON.parse(launch?.args.at(-1) ?? "null")).toEqual(["opencode", ["serve"], false, expect.any(Number), "0"]);
});

test("a compiled single executable host has no watchdog: its executable would start the application again", () => {
  const builtin = process.getBuiltinModule.bind(process);
  vi.spyOn(process, "getBuiltinModule").mockImplementation((id: string) => (id === "node:sea" ? { isSea: () => true } : builtin(id)));
  expect(hostWatchdogTarget(target, {})).toBeNull();
  vi.restoreAllMocks();
  vi.stubGlobal("Bun", { isStandaloneExecutable: true });
  expect(hostWatchdogTarget(target, {})).toBeNull();
  vi.stubGlobal("Bun", { isStandaloneExecutable: false });
  expect(hostWatchdogTarget(target, {})?.command).toBe(process.execPath);
});
