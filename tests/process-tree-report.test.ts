import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "vitest";
import { spawnLineProcess } from "../packages/oar/src/shared/executable/index.js";
import { fakeAgentBinary, gone, reportedProcess, signalFixture, withTreeProbe, type ProcessIdentity } from "./fixtures/process-tree.js";

// oxlint-disable-next-line max-statements -- Observe the launcher, agent, tool and its cwd across the same failed publication.
test("a failed fixture report leaves neither its launcher nor its unreported tool holding the cwd", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "oar-report-error-"));
  const cwd = path.join(dir, "cwd");
  const report = path.join(dir, "occupied");
  mkdirSync(cwd);
  // The fixture can write its temporary report, but cannot publish over a directory.
  mkdirSync(report);
  let tool: ProcessIdentity | undefined = undefined;
  try {
    const child = spawnLineProcess(fakeAgentBinary(dir), [], { cwd, env: { ...process.env, OAR_FIXTURE_PIDS: report, OAR_FIXTURE_DETACH_TOOL: "1", OAR_FIXTURE_IGNORE_SIGTERM: "1" } });
    assert.notEqual(await child.exited, 0);
    const saved: unknown = JSON.parse(readFileSync(`${report}.tmp`, "utf8"));
    assert.ok(typeof saved === "object" && saved !== null && "agent" in saved && "grandchild" in saved);
    tool = reportedProcess(saved.grandchild);
    assert.ok(await gone(reportedProcess(saved.agent)), "fixture agent still running");
    assert.ok(await gone(tool), "unreported fixture tool still running after its launcher exited");
    rmSync(cwd, { recursive: true });
  } finally {
    if (tool !== undefined) { signalFixture(tool); }
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});

test("a cleanup error preserves the probe's original failure", async () => {
  const failure = new Error("fixture assertion");
  let dir = "";
  try {
    await assert.rejects(withTreeProbe({ ignoreSigterm: false }, async probe => {
      ({ dir } = probe);
      writeFileSync(path.join(dir, "late.pid"), "invalid");
      throw failure;
    }), (error: unknown) => {
      assert.ok(error instanceof AggregateError);
      assert.equal(error.cause, failure);
      assert.equal(error.errors[0], failure);
      assert.ok(error.errors[1] instanceof SyntaxError);
      return true;
    });
  } finally {
    if (dir && existsSync(dir)) { rmSync(dir, { recursive: true, force: true }); }
  }
});
