import { defineRuntime } from "../packages/oar/src/index.js";
import assert from "node:assert/strict";
import { test } from "vitest";
import { installFailed, readInstall, renderInstallReport } from "../packages/cli/src/install.js";

// Fixtures use the runtime definition helper and the CLI functions' input shapes.
type Runtime = Parameters<typeof readInstall>[0];
type InstallPlan = Awaited<ReturnType<NonNullable<Runtime["installPlan"]>>>;
type InstallResult = Awaited<ReturnType<NonNullable<Runtime["install"]>>>;

const neverSession: Runtime["session"] = async () => {
  await Promise.resolve();
  throw new Error("not exercised");
};

const noInventory = async () => ({
  kind: "unsupported" as const,
  code: "native_query_unavailable" as const,
  reason: "not exercised",
});

function runtime(id: string, extra: Partial<Runtime>): Runtime {
  return defineRuntime({
    skills: noInventory, commands: noInventory, mcpServers: noInventory, tools: noInventory,
    id,
    brand: { name: id, icon: null },
    session: neverSession,
    ...extra,
  });
}

const plan: InstallPlan = {
  kind: "plan",
  steps: [{ command: ["sh", "-c", "curl -fsSL https://example.test/install.sh | sh"], display: "curl -fsSL https://example.test/install.sh | sh" }],
  source: "https://example.test/docs",
  network: true,
  privileges: false,
};

function installer(result: InstallResult, calls: string[] = []): Partial<Runtime> {
  return {
    installPlan: async () => { calls.push("plan"); await Promise.resolve(); return plan; },
    install: async () => { calls.push("install"); await Promise.resolve(); return result; },
  };
}

test("--plan only plans; without it the installer runs and nothing plans first", async () => {
  const calls: string[] = [];
  const fake = runtime("fake", installer({ kind: "failed", exitCode: 1, output: "" }, calls));
  const planned = await readInstall(fake, { install: false });
  assert.deepEqual(calls, ["plan"]);
  assert.deepEqual(renderInstallReport(planned), ["fake\twould run:", "  curl -fsSL https://example.test/install.sh | sh", "  (https://example.test/docs)"]);
  assert.equal(installFailed(planned), false);
  calls.length = 0;
  await readInstall(fake, { install: true });
  assert.deepEqual(calls, ["install"]);
});

// oxlint-disable-next-line eslint/max-statements -- One case per installer outcome, in the order a person meets them.
test("outcomes: installed, already installed, failed with output tail, and the line a runtime needs", async () => {
  const installed = await readInstall(runtime("fake", installer({ kind: "installed", installation: { kind: "available", via: "executable", command: "/bin/fake", version: "2.0.0" }, output: "ok" })), { install: true });
  assert.deepEqual(renderInstallReport(installed), ["fake\tinstalled 2.0.0"]);
  assert.equal(installFailed(installed), false);

  const already = await readInstall(runtime("fake", installer({ kind: "already_installed", installation: { kind: "available", via: "executable", command: "/bin/fake", version: "1.0.0" } })), { install: true });
  assert.deepEqual(renderInstallReport(already), ["fake\talready installed: 1.0.0"]);

  const failed = await readInstall(runtime("fake", installer({ kind: "failed", exitCode: 7, output: "a\nb\n" })), { install: true });
  assert.deepEqual(renderInstallReport(failed), ["fake\tinstall failed (exit 7); its output:", "  a", "  b"]);
  assert.equal(installFailed(failed), true);

  const lineRequired = await readInstall(runtime("lines", installer({ kind: "unsupported", reason: "line_required", detail: "choose a release line: v1, v2" })), { install: true });
  assert.deepEqual(renderInstallReport(lineRequired, ["v1", "v2"]), ["lines\tcannot install (line_required): choose a release line: v1, v2", "  choose one with --line: v1, v2"]);
  assert.equal(installFailed(lineRequired), true);
});

test("an installer oar will not run here shows the vendor steps for a person to run", async () => {
  const report = await readInstall(runtime("fake", installer({ kind: "unsupported", reason: "requires_privileges", steps: plan.steps, source: plan.source })), { install: true });
  assert.deepEqual(renderInstallReport(report), [
    "fake\tcannot install (requires_privileges)",
    "  run it yourself:",
    "  curl -fsSL https://example.test/install.sh | sh",
    "  (https://example.test/docs)",
  ]);
});

test("a runtime without an installer and a throwing planner are reported, not thrown", async () => {
  const none = await readInstall(runtime("bundled", {}), { install: true });
  assert.deepEqual(renderInstallReport(none), ["bundled\tbundled has no installer oar can run"]);
  assert.equal(installFailed(none), false);
  const throwing = await readInstall(runtime("fake", {
    installPlan: async () => { await Promise.resolve(); throw new Error("boom"); },
    install: async () => { await Promise.resolve(); throw new Error("boom"); },
  }), { install: false });
  assert.deepEqual(renderInstallReport(throwing), ["fake\terror: boom"]);
  assert.equal(installFailed(throwing), true);
});
