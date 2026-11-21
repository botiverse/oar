import { mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { onTestFinished } from "vitest";
import { captureProcess, gone, reportedProcess, signalFixture } from "./process-tree.js";

function identities(directory: string) {
  return readdirSync(directory).filter(file => file.endsWith(".json")).map(file => {
    const text = readFileSync(path.join(directory, file), "utf8");
    return reportedProcess(JSON.parse(text));
  });
}

/** Seal the directory first: a late-starting fixture must either already be recorded or fail before running its script. */
// oxlint-disable-next-line eslint/max-statements -- Seal registration, observe, reap and report in order.
async function checkFixtureExit(directory: string): Promise<void> {
  const sealed = `${directory}.finished`;
  renameSync(directory, sealed);
  try {
    const processes = identities(sealed);
    // An existing finally block may already have sent its termination signal.
    const released = await Promise.all(processes.map(async identity => gone(identity, 300)));
    const survivors = processes.filter((_id, index) => released[index] === false);
    if (survivors.length === 0) { return; }
    for (const identity of survivors) { signalFixture(identity); }
    const exited = await Promise.all(survivors.map(async identity => gone(identity)));
    throw new Error(`Fixture processes outlived their test: ${survivors.map((id, i) => `${String(id.pid)} (${exited[i] === true ? "reaped" : "still present"})`).join(", ")}`);
  } finally { rmSync(sealed, { recursive: true, force: true }); }
}

/** Wrap Node fixture arguments. Its Node descendants inherit the registration before their own scripts run. */
export default function guardedFixtureArgs(...args: string[]): string[] {
  const directory = mkdtempSync(path.join(tmpdir(), "oar-test-processes-"));
  writeFileSync(path.join(directory, "owner"), JSON.stringify(captureProcess(process.pid)));
  onTestFinished(async () => checkFixtureExit(directory));
  const preload = new URL("register-fixture.ts", import.meta.url);
  preload.searchParams.set("directory", directory);
  return ["--import", preload.href, ...args];
}
