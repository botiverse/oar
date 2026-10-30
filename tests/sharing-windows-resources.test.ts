import { spawn } from "node:child_process";
import { once } from "node:events";
import { expect, test } from "vitest";
import { windowsReadings } from "../experiments/sharing/windows-resources.js";

test("resource PID arguments cannot become PowerShell expressions", () => {
  expect(() => windowsReadings([Number.NaN])).toThrow("positive integer PIDs required");
  expect(windowsReadings([])).toEqual([]);
});

test.skipIf(process.platform !== "win32")("an exited PID does not discard a live process resource reading", async () => {
  const child = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
  await once(child, "close");
  expect(child.exitCode).toBe(0);
  expect(child.pid).toEqual(expect.any(Number));
  const exited = child.pid ?? 0;
  const mixed = windowsReadings([process.pid, exited]);
  expect(mixed.map((row) => row.pid)).toEqual([process.pid]);
  expect(mixed[0]?.rss).toBeGreaterThan(0);
  expect(mixed[0]?.cpuMs).toBeGreaterThanOrEqual(0);
  expect(windowsReadings([exited])).toEqual([]);
}, 30_000);
