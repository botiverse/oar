// Contributed by Otter in the #756 review: boundaries of the Antigravity usage reader.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { antigravityAccountUsage, projectAntigravityUsage } from "../../packages/oar/src/runtimes/antigravity/account-usage.js";
import { fakeAgentBinary, gone } from "../fixtures/process-tree.js";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) { rmSync(dir, { recursive: true, force: true }); } });
const payload = (remaining: number, window = "5h") => ({
  status: "SUCCESS", command: { name: "usage", data: { groups: [{ name: "Gemini Models", buckets: [{ id: "test", name: "Five hour", window, remaining_fraction: remaining }] }] } },
});

test.each([0.0000001, 0.0000004])("positive remaining fraction %s is not exhausted by rounding", remaining => {
  expect(projectAntigravityUsage(payload(remaining))).toMatchObject({ kind: "available", rateLimited: false });
});

test.each(["toString", "constructor", "__proto__"])("unknown window %s does not inherit a duration", window => {
  const snapshot = projectAntigravityUsage(payload(0.5, window));
  expect(snapshot.kind).toBe("available");
  if (snapshot.kind === "available") { expect(snapshot.windows[0]).not.toHaveProperty("durationMs"); }
});

test("ordinary unknown window duration remains absent", () => {
  const snapshot = projectAntigravityUsage(payload(0.5, "monthly"));
  if (snapshot.kind !== "available") { throw new Error("fixture must be available"); }
  expect(snapshot.windows[0]).not.toHaveProperty("durationMs");
});

test("unknown native status is not copied into a public error", () => {
  const synthetic = "synthetic-review756-token-not-a-real-credential";
  let message = "";
  try { projectAntigravityUsage({ status: `unexpected status ${synthetic}` }); }
  catch (error) { message = error instanceof Error ? error.message : String(error); }
  expect(message).not.toBe("");
  expect(message).not.toContain(synthetic);
});

const MODELS_EXIT: Readonly<Record<string, number>> = { logged_in: 0, logged_out: 1, unknown: 2 };

function fakeAgy(mode: "unknown" | "logged_out" | "logged_in", stall?: "models" | "usage") {
  const dir = mkdtempSync(path.join(tmpdir(), "review756-"));
  dirs.push(dir);
  const calls = path.join(dir, "calls");
  const pid = path.join(dir, "pid");
  const script = path.join(dir, "fake.mjs");
  const reply = JSON.stringify(payload(0.5));
  writeFileSync(script, [
    'import { appendFileSync } from "node:fs";',
    `appendFileSync(${JSON.stringify(calls)}, process.argv.slice(2).join(" ") + String.fromCharCode(10));`,
    `if (${JSON.stringify(stall)} === (process.argv[2] === "models" ? "models" : "usage")) { appendFileSync(${JSON.stringify(pid)}, String(process.pid)); await new Promise(() => setInterval(() => {}, 1000)); }`,
    `if (process.argv[2] === "models") { process.stderr.write(${JSON.stringify(mode === "logged_out" ? "Please sign in to view available models" : "unavailable")}); process.exit(${String(MODELS_EXIT[mode])}); }`,
    `process.stdout.write(${JSON.stringify(reply)});`,
  ].join("\n"));
  return { installation: { kind: "available", via: "executable", command: fakeAgentBinary(dir, [script]) } as const,
    calls: () => readFileSync(calls, "utf8").trim().split("\n"), pid: () => Number(readFileSync(pid, "utf8")) };
}

test("unknown authentication does not dispatch the potentially interactive usage command", async () => {
  const fake = fakeAgy("unknown");
  await expect(antigravityAccountUsage(fake.installation)).rejects.toThrow(/did not confirm a login/u);
  expect(fake.calls()).toEqual(["models"]);
});

test("explicit signed-out refusal prevents usage dispatch", async () => {
  const fake = fakeAgy("logged_out");
  expect(await antigravityAccountUsage(fake.installation)).toEqual({ kind: "reauth_required", reason: "not_authenticated" });
  expect(fake.calls()).toEqual(["models"]);
});

test("successful auth preflight dispatches exactly one usage query", async () => {
  const fake = fakeAgy("logged_in");
  expect(await antigravityAccountUsage(fake.installation)).toMatchObject({ kind: "available", rateLimited: false });
  expect(fake.calls()).toEqual(["models", "-p /usage --output-format json"]);
});

test.each(["models", "usage"] as const)("the overall deadline bounds a stalled %s process", async stage => {
  const fake = fakeAgy("logged_in", stage);
  const started = performance.now();
  await expect(antigravityAccountUsage(fake.installation, { timeoutMs: 500 })).rejects.toThrow(/timed out/u);
  expect(performance.now() - started).toBeLessThan(1500);
  expect(await gone(fake.pid())).toBe(true);
  expect(fake.calls()).toEqual(stage === "models" ? ["models"] : ["models", "-p /usage --output-format json"]);
});
