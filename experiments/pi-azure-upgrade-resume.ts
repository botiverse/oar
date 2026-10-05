/**
 * Resume a Pi 1.0.2 native session naming the removed Azure provider in 1.0.3.
 * Run: pnpm tsx experiments/pi-azure-upgrade-resume.ts <pi-1.0.2-checkout> [out]
 *
 * The old SDK writes a synthetic conversation through its SessionManager.
 * New processes exercise OAR's real resume path: implicit model selection,
 * the old explicit id, and the renamed explicit id. Only the fallback turn
 * calls a model, through aimock; no Azure login or Azure request is used.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { findPackageJSON } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import type { promptAndWait, defaultRuntimes } from "../packages/oar/src/index.js";
import { piSessionDir } from "../packages/oar/src/runtimes/pi/resolve.js";
import { startPiAimock } from "../sea-trial/harness/aimock.js";

const currentRepo = fileURLToPath(new URL("..", import.meta.url));
const oldProvider = "azure-openai-responses";
const modelId = "gpt-4.1";
const oldModel = `${oldProvider}/${modelId}`;
const newModel = `azure/${modelId}`;
const fallback = "aimock/aimock-model";
const beforePrompt = "OAR_AZURE_OLD_USER_MESSAGE";
const beforeReply = "OAR_AZURE_OLD_ASSISTANT_MESSAGE";
const afterPrompt = "OAR_AZURE_RESUME_INPUT";
const afterReply = "OAR_AZURE_RESUME_REPLY";

interface Seed {
  readonly version: string;
  readonly id: string;
  readonly file: string;
  readonly model: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isPiSdk(value: unknown): value is { ModelRuntime: typeof ModelRuntime; SessionManager: typeof SessionManager } {
  return isRecord(value) && typeof value.ModelRuntime === "function" && typeof value.SessionManager === "function";
}

/** A checkout before 0.21.0 names the default registry `runtimes`. */
interface OarModule {
  readonly promptAndWait: typeof promptAndWait;
  readonly defaultRuntimes?: typeof defaultRuntimes;
  readonly runtimes?: typeof defaultRuntimes;
}

function isOarModule(value: unknown): value is OarModule {
  return isRecord(value) && typeof value.promptAndWait === "function"
    && [value.defaultRuntimes, value.runtimes].some((registry) => isRecord(registry) && typeof registry.require === "function");
}

async function readSeed(out: string): Promise<Seed> {
  const value: unknown = JSON.parse(await readFile(path.join(out, "seed.json"), "utf8"));
  assert.ok(typeof value === "object" && value !== null);
  assert.ok("version" in value && typeof value.version === "string");
  assert.ok("id" in value && typeof value.id === "string");
  assert.ok("file" in value && typeof value.file === "string");
  assert.ok("model" in value && typeof value.model === "string");
  return { version: value.version, id: value.id, file: value.file, model: value.model };
}

async function child(stage: string, repo: string, out: string): Promise<void> {
  delete process.env.PI_PACKAGE_DIR;
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined, "isolated agent dir required");
  const cwd = path.join(out, "cwd");
  const manifest = findPackageJSON("@earendil-works/pi-coding-agent",
    pathToFileURL(path.join(repo, "packages/oar/src/runtimes/pi/installation.ts")));
  assert.ok(manifest !== undefined);
  const metadata: unknown = JSON.parse(await readFile(manifest, "utf8"));
  assert.ok(typeof metadata === "object" && metadata !== null && "version" in metadata);
  assert.ok(typeof metadata.version === "string");
  const sdk: unknown = await import(pathToFileURL(path.join(path.dirname(manifest), "dist/index.js")).href);
  assert.ok(isPiSdk(sdk), "checkout must expose the native session manager and model runtime");
  if (stage === "seed") {
    assert.equal(metadata.version, "1.0.2");
    const models = await sdk.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"),
      modelsPath: path.join(agentDir, "models.json"),
      refreshOnCreate: false,
    });
    assert.ok(models.getModel(oldProvider, modelId), "old Azure model must be in the old SDK catalog");
    const manager = sdk.SessionManager.create(cwd, piSessionDir(cwd, agentDir));
    manager.appendModelChange(oldProvider, modelId);
    manager.appendMessage({ role: "user", content: beforePrompt, timestamp: Date.now() });
    manager.appendMessage({
      role: "assistant", content: [{ type: "text", text: beforeReply }],
      api: "azure-openai-responses", provider: oldProvider, model: modelId,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      stopReason: "stop", timestamp: Date.now(),
    });
    const file = manager.getSessionFile();
    assert.ok(file !== undefined);
    await copyFile(file, path.join(out, "seed.session.jsonl"));
    const seed: Seed = { version: metadata.version, id: manager.getSessionId(), file, model: oldModel };
    await writeFile(path.join(out, "seed.json"), `${JSON.stringify(seed, null, 2)}\n`);
    return;
  }

  assert.equal(metadata.version, "1.0.3");
  const seed = await readSeed(out);
  const oar: unknown = await import(pathToFileURL(path.join(repo, "packages/oar/src/index.ts")).href);
  assert.ok(isOarModule(oar), "checkout must expose runtimes and promptAndWait");
  const registry = oar.defaultRuntimes ?? oar.runtimes;
  assert.ok(registry !== undefined, "checkout must expose its default registry");
  const runtime = registry.require("pi");
  const installation = await runtime.installation?.();
  assert.ok(installation?.kind === "available");
  assert.ok(stage === "implicit" || stage === "old-explicit" || stage === "new-explicit");
  const explicitModels: Readonly<Record<string, string>> = { "old-explicit": oldModel, "new-explicit": newModel };
  const requested = explicitModels[stage];
  const options = { cwd, resume: seed.id, ...(requested === undefined ? {} : { model: requested }) };
  if (stage === "old-explicit") {
    let rejected: Error | undefined = undefined;
    try {
      const session = await runtime.session(installation, options);
      await session.dispose();
    } catch (error) {
      assert.ok(error instanceof Error);
      rejected = error;
    }
    assert.ok(rejected !== undefined, "the removed explicit provider must reject");
    assert.equal(rejected.message,
      `pi model ${oldModel} is not registered: provider ${oldProvider} has no model ${modelId} (see \`oar models pi\` for the usable list)`);
    await writeFile(path.join(out, `${stage}.json`), `${JSON.stringify({ rejected: true, error: rejected.message }, null, 2)}\n`);
    return;
  }

  const session = await runtime.session(installation, options);
  const text: string[] = [];
  const modelEvents: { seq: number; model: string }[] = [];
  session.events((event) => {
    if (event.kind === "text_delta") { text.push(event.text); }
    if (event.kind === "model") { modelEvents.push({ seq: event.seq, model: event.model }); }
  }, { cursor: { sessionId: session.id, afterSeq: -1 } });
  try {
    assert.equal(session.id, seed.id);
    assert.equal(session.model().value, requested ?? fallback);
    assert.equal(session.records()[0]?.seq, 0);
    assert.deepEqual(modelEvents, [{ seq: 0, model: requested ?? fallback }]);
    if (stage === "implicit") {
      const run = await oar.promptAndWait(session, afterPrompt, { timeoutMs: 30_000 });
      assert.equal(run.kind, "ended", JSON.stringify(run));
      assert.deepEqual(run.outcome, { kind: "completed" });
      assert.equal(text.join(""), afterReply);
    }
    await writeFile(path.join(out, `${stage}.json`), `${JSON.stringify({
      version: metadata.version, id: session.id, requestedModel: requested ?? null,
      effectiveModel: session.model().value, firstSeq: session.records()[0]?.seq,
      modelEvents, modelRequest: stage === "implicit", text: text.join(""),
    }, null, 2)}\n`);
    await writeFile(path.join(out, `${stage}.records.json`), `${JSON.stringify(session.records(), null, 2)}\n`);
  } finally {
    await session.dispose();
  }
}

async function main(): Promise<void> {
  if (process.argv[2] === "--child") {
    const [stage, repo, out] = process.argv.slice(3);
    assert.ok(stage !== undefined && repo !== undefined && out !== undefined);
    await child(stage, repo, out);
    return;
  }
  const [beforeRepo] = process.argv.slice(2);
  assert.ok(beforeRepo !== undefined, "the Pi 1.0.2 checkout is required");
  const out = path.resolve(process.argv[3] ?? "oar-trial-run/pi-azure-upgrade-resume");
  await mkdir(path.join(out, "cwd"), { recursive: true });
  const env = await startPiAimock((mock) => {
    mock.onMessage(new RegExp(afterPrompt, "u"), { content: afterReply });
  }, { settings: { defaultProvider: "aimock", defaultModel: "aimock-model" } });
  try {
    const run = async (stage: string, repo: string): Promise<void> => {
      const { promise, resolve, reject } = Promise.withResolvers<{ stdout: string; stderr: string }>();
      execFile(process.execPath, [path.join(currentRepo, "node_modules/tsx/dist/cli.mjs"),
        import.meta.filename, "--child", stage, repo, out], { timeout: 60_000, env: process.env },
      // eslint-disable-next-line promise/prefer-await-to-callbacks -- Bridge execFile to the awaited promise.
      (error, stdout, stderr) => {
        if (error === null) { resolve({ stdout, stderr }); } else { reject(new Error(error.message)); }
      });
      const result = await promise;
      await writeFile(path.join(out, `${stage}.log`), `${result.stdout}${result.stderr}`);
    };
    await run("seed", path.resolve(beforeRepo));
    const seed = await readSeed(out);
    const resume = async (stage: string): Promise<void> => {
      await copyFile(path.join(out, "seed.session.jsonl"), seed.file);
      await run(stage, currentRepo);
    };
    // Each process changes the same session file; restore and run sequentially.
    await resume("implicit");
    await resume("old-explicit");
    await resume("new-explicit");
    const requests = env.mock.journal.getAll().map((entry) => entry.body);
    assert.equal(requests.length, 1, "only the fallback turn calls a model");
    const messages = JSON.stringify(requests[0]?.messages);
    assert.ok(messages.includes(beforePrompt), "old user message lost");
    assert.ok(messages.includes(beforeReply), "old assistant message lost");
    const outcomes = await Promise.all(["implicit", "old-explicit", "new-explicit"].map(async (stage) => {
      const result: unknown = JSON.parse(await readFile(path.join(out, `${stage}.json`), "utf8"));
      return { stage, result };
    }));
    const report = {
      passed: true, seed, syntheticTranscript: true, azureRequests: 0,
      fallbackPriorTranscriptSent: true, separateProcesses: true, outcomes,
    };
    await writeFile(path.join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    await env.stop();
  }
}

await main();
