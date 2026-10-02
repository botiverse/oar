/**
 * Open an old Pi SDK session, then resume it in another process with this
 * checkout's SDK. The provider is scripted; no login or model quota is used.
 *
 * Run: pnpm tsx experiments/pi-upgrade-resume.ts <older-oar-checkout> [out-dir]
 * Both checkouts need installed dependencies. The Pi adapter should be the
 * same in both so the dependency change is the variable under test.
 * Observed 2026-10-02: 0.99.2 -> 1.0.0 keeps the id, model and transcript;
 * the reopened OAR record stream starts at seq 0.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { promptAndWait, runtimes } from "../packages/oar/src/index.js";
import { startPiAimock } from "../sea-trial/harness/aimock.js";

const currentRepo = fileURLToPath(new URL("..", import.meta.url));
const model = "aimock/aimock-model";
const beforePrompt = "OAR_PI_BEFORE_UPGRADE_INPUT";
const beforeReply = "OAR_PI_BEFORE_UPGRADE_REPLY";
const afterPrompt = "OAR_PI_AFTER_UPGRADE_INPUT";
const afterReply = "OAR_PI_AFTER_UPGRADE_REPLY";

interface Result {
  readonly version: string;
  readonly id: string;
  readonly model: string | null;
  readonly firstSeq: number | undefined;
  readonly text: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isOarModule(value: unknown): value is { promptAndWait: typeof promptAndWait; runtimes: typeof runtimes } {
  return isRecord(value) && typeof value.promptAndWait === "function"
    && isRecord(value.runtimes) && typeof value.runtimes.require === "function";
}

async function readResult(out: string, stage: string): Promise<Result> {
  const result: unknown = JSON.parse(await readFile(path.join(out, `${stage}.json`), "utf8"));
  assert.ok(isRecord(result));
  const { version, id, model: reportedModel, firstSeq, text } = result;
  assert.ok(typeof version === "string" && typeof id === "string" && typeof text === "string");
  assert.ok(reportedModel === null || typeof reportedModel === "string");
  assert.ok(firstSeq === undefined || typeof firstSeq === "number");
  return { version, id, model: reportedModel, firstSeq, text };
}

async function child(stage: string, repo: string, out: string): Promise<void> {
  delete process.env.PI_PACKAGE_DIR;
  const source = pathToFileURL(path.join(repo, "packages/oar/src/index.ts")).href;
  const oar: unknown = await import(source);
  assert.ok(isOarModule(oar), "checkout must expose runtimes and promptAndWait");
  const adapter = pathToFileURL(path.join(repo, "packages/oar/src/runtimes/pi/installation.ts"));
  const sdkPackage = findPackageJSON("@earendil-works/pi-coding-agent", adapter);
  assert.ok(sdkPackage !== undefined, "cannot resolve the SDK from the checkout's Pi adapter");
  const metadata: unknown = JSON.parse(await readFile(sdkPackage, "utf8"));
  assert.ok(isRecord(metadata) && typeof metadata.version === "string");
  const { version } = metadata;
  const runtime = oar.runtimes.require("pi");
  const installation = await runtime.installation?.();
  assert.ok(installation?.kind === "available", "bundled Pi SDK must be available");
  const before = stage === "after" ? await readResult(out, "before") : undefined;
  const session = await runtime.session(installation, {
    cwd: path.join(out, "cwd"),
    ...(before === undefined ? { model } : { resume: before.id }),
  });
  const text: string[] = [];
  session.events((event) => {
    if (event.kind === "text_delta") {
      text.push(event.text);
    }
  });
  try {
    const run = await oar.promptAndWait(session, stage === "before" ? beforePrompt : afterPrompt, { timeoutMs: 30_000 });
    assert.equal(run.kind, "ended", JSON.stringify(run));
    assert.deepEqual(run.outcome, { kind: "completed" });
    const result: Result = {
      version, id: session.id, model: session.model().value,
      firstSeq: session.records()[0]?.seq, text: text.join(""),
    };
    await writeFile(path.join(out, `${stage}.json`), `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(path.join(out, `${stage}.records.json`), `${JSON.stringify(session.records(), null, 2)}\n`);
  } finally {
    await session.dispose();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--child") {
    const [stage, repo, out] = process.argv.slice(3);
    assert.ok(stage !== undefined && repo !== undefined && out !== undefined, "child arguments required");
    await child(stage, repo, out);
    return;
  }
  const [beforeRepo] = process.argv.slice(2);
  assert.ok(beforeRepo !== undefined, "usage: pi-upgrade-resume.ts <older-oar-checkout> [out-dir]");
  const out = path.resolve(process.argv[3] ?? "oar-trial-run/pi-upgrade-resume");
  await mkdir(path.join(out, "cwd"), { recursive: true });
  const env = await startPiAimock((mock) => {
    mock.onMessage(new RegExp(beforePrompt, "u"), { content: beforeReply });
    mock.onMessage(new RegExp(afterPrompt, "u"), { content: afterReply });
  });
  try {
    const runProcess = async (stage: string, repo: string): Promise<void> => {
      // Separate processes also prevent SDK globals from crossing the upgrade.
      const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
      execFile(process.execPath, [
        path.join(currentRepo, "node_modules/tsx/dist/cli.mjs"),
        import.meta.filename, "--child", stage, repo, out,
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- Bridge Node's callback-only execFile to the promise awaited below.
      ], { timeout: 60_000, env: process.env }, (error, stdout, stderr) => {
        if (error === null) {
          resolve({ stdout, stderr });
        } else {
          reject(new Error(error.message));
        }
      });
      const result = await promise;
      await writeFile(path.join(out, `${stage}.log`), `${result.stdout}${result.stderr}`);
    };
    await runProcess("before", path.resolve(beforeRepo));
    await runProcess("after", currentRepo);
    const before = await readResult(out, "before");
    const after = await readResult(out, "after");
    assert.equal(after.id, before.id);
    assert.equal(before.model, model);
    assert.equal(after.model, model);
    assert.equal(before.text, beforeReply);
    assert.equal(after.text, afterReply);
    assert.equal(after.firstSeq, 0);
    const requests = env.mock.journal.getAll().map((entry) => entry.body);
    assert.equal(requests.length, 2, "one model request per process");
    const resumedRequest = JSON.stringify(requests[1]?.messages);
    assert.ok(resumedRequest.includes(beforePrompt), "resumed request lost the old user message");
    assert.ok(resumedRequest.includes(beforeReply), "resumed request lost the old assistant message");
    assert.ok(resumedRequest.includes(afterPrompt), "resumed request lost the new input");
    const report = { before, after, priorTranscriptSent: true, separateProcesses: true, passed: true };
    await writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await env.stop();
  }
}

await main();
