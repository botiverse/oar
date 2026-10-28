/**
 * BURNS TOKENS: two text-only turns through an existing Cursor login.
 * Run: pnpm tsx experiments/cursor-upgrade-resume.ts <old-sdk-root> <new-sdk-root> <output-dir>
 * Each SDK runs in a separate process. The resumed OAR session omits model,
 * so its native run lookup must recover the original selection. The second
 * prompt omits the random marker; a correct answer must come from history.
 * The output directory is retained, including failures. No credentials are read
 * or printed by this probe. Use a new output directory for every run.
 */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { Agent as NativeAgent, Cursor as NativeCursor } from "@cursor/sdk";
import { createCursorRuntime, type CursorSdk } from "../packages/oar/src/index.js";
import { promptAndWait } from "../packages/oar/src/observe/turns.js";
import { asRecord } from "../packages/oar/src/shared/json.js";

interface State {
  readonly cwd: string;
  readonly marker: string;
  readonly model: string;
  readonly sessionId?: string;
  readonly firstRunId?: string;
}

function readState(file: string): State {
  const value = asRecord(JSON.parse(readFileSync(file, "utf8")));
  assert.ok(value !== null && typeof value.cwd === "string" && typeof value.marker === "string" && typeof value.model === "string");
  assert.ok(value.sessionId === undefined || typeof value.sessionId === "string");
  assert.ok(value.firstRunId === undefined || typeof value.firstRunId === "string");
  return {
    cwd: value.cwd, marker: value.marker, model: value.model,
    ...(value.sessionId === undefined ? {} : { sessionId: value.sessionId }),
    ...(value.firstRunId === undefined ? {} : { firstRunId: value.firstRunId }),
  };
}

/** Validate the entry points of the installed native module before calling it. */
function assertSdk(value: unknown): asserts value is { readonly Agent: typeof NativeAgent; readonly Cursor: typeof NativeCursor } {
  const module = asRecord(value);
  assert.ok(module !== null && typeof module.Agent === "function" && typeof module.Cursor === "function");
  assert.ok("create" in module.Agent && typeof module.Agent.create === "function");
  assert.ok("resume" in module.Agent && typeof module.Agent.resume === "function");
  assert.ok("listRuns" in module.Agent && typeof module.Agent.listRuns === "function");
  assert.ok("models" in module.Cursor);
  assert.ok(typeof asRecord(module.Cursor.models)?.list === "function");
}

function json(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

async function phase(kind: string, sdkRoot: string, output: string): Promise<void> {
  assert.ok(kind === "create" || kind === "resume");
  const stateFile = path.join(output, "state.json");
  const state = readState(stateFile);
  const manifestFile = path.join(sdkRoot, "package.json");
  const manifest = asRecord(JSON.parse(readFileSync(manifestFile, "utf8")));
  assert.ok(manifest !== null && typeof manifest.version === "string");
  assert.equal(manifest.name, "@cursor/sdk");
  const sdk: unknown = await import(pathToFileURL(path.join(sdkRoot, "dist/esm/index.js")).href);
  assertSdk(sdk);
  const wrapped: CursorSdk = {
    Cursor: sdk.Cursor,
    Agent: {
      listRuns: sdk.Agent.listRuns.bind(sdk.Agent),
      create: async (options) => {
        const agent = await sdk.Agent.create({ ...options, tools: [], local: { ...options.local, settingSources: [] } });
        return agent;
      },
      resume: async (id, options) => {
        const agent = await sdk.Agent.resume(id, { ...options, tools: [], local: { ...options.local, settingSources: [] } });
        return agent;
      },
    },
  };
  const runtime = createCursorRuntime({ sdk: async () => { await Promise.resolve(); return wrapped; } });
  const priorResult = state.sessionId === undefined ? { items: [] } : await sdk.Agent.listRuns(state.sessionId, { runtime: "local", cwd: state.cwd });
  const prior = priorResult.items;
  if (kind === "resume") {
    assert.ok(state.sessionId !== undefined && state.firstRunId !== undefined);
    assert.deepEqual(prior.map((run) => ({ id: run.id, model: run.model, status: run.status })), [
      { id: state.firstRunId, model: { id: state.model }, status: "finished" },
    ]);
  }
  const session = await runtime.session({ kind: "available", via: "bundled" }, {
    cwd: state.cwd,
    ...(state.sessionId === undefined ? { model: state.model } : { resume: state.sessionId }),
  });
  try {
    const model = session.records().flatMap((record) => record.kind === "frame"
      ? record.body.events.flatMap((event) => event.kind === "model" ? [event.model] : []) : []);
    assert.deepEqual(model, [state.model]);
    if (kind === "resume") { assert.equal(session.id, state.sessionId); }
    const prompt = kind === "create"
      ? `Remember this exact marker for our next turn: ${state.marker}. Reply only STORED. Do not use tools.`
      : "What exact marker did I ask you to remember in the previous turn? Reply only that marker. Do not use tools.";
    const result = await promptAndWait(session, prompt, { timeoutMs: 90_000 });
    const listed = await sdk.Agent.listRuns(session.id, { runtime: "local", cwd: state.cwd });
    const runs = listed.items;
    const facts = {
      kind, sdk: manifest.version, sessionId: session.id, model, result,
      runs: runs.map((run) => ({ id: run.id, model: run.model, status: run.status, usage: run.usage, result: run.result })),
    };
    json(path.join(output, `${kind}.json`), facts);
    assert.equal(result.kind, "ended", JSON.stringify(result));
    assert.equal(result.outcome.kind, "completed", JSON.stringify(result));
    assert.equal(result.text.trim(), kind === "create" ? "STORED" : state.marker);
    assert.equal(runs.length, kind === "create" ? 1 : 2);
    assert.ok(runs.every((run) => run.status === "finished" && run.model?.id === state.model));
    if (kind === "create") {
      const [first] = runs;
      assert.ok(first);
      json(stateFile, { ...state, sessionId: session.id, firstRunId: first.id });
    } else {
      assert.ok(runs.some((run) => run.id === state.firstRunId));
    }
    console.log(JSON.stringify(facts));
  } finally {
    await session.dispose();
  }
}

const [first, second, third, fourth] = process.argv.slice(2);
assert.ok(first !== undefined && second !== undefined && third !== undefined, "old-sdk-root new-sdk-root output-dir required");
if (first === "--phase") {
  assert.ok(fourth !== undefined);
  await phase(second, third, fourth);
} else {
  const output = path.resolve(third);
  mkdirSync(output, { mode: 0o700 });
  const cwd = path.join(output, "workspace");
  mkdirSync(cwd, { mode: 0o700 });
  json(path.join(output, "state.json"), { cwd, marker: `UPGRADE_${randomUUID()}`, model: process.env.OAR_TEST_MODEL ?? "gpt-5.4-nano" });
  for (const [kind, sdkRoot] of [["create", first], ["resume", second]] as const) {
    const fd = openSync(path.join(output, `${kind}.log`), "wx", 0o600);
    try {
      const child = spawnSync(process.execPath, [...process.execArgv, import.meta.filename, "--phase", kind, path.resolve(sdkRoot), output], {
        stdio: ["ignore", fd, fd], timeout: 120_000,
      });
      json(path.join(output, `${kind}-process.json`), { status: child.status, signal: child.signal, error: child.error?.message });
      assert.equal(child.status, 0, `${kind} failed; inspect ${path.join(output, `${kind}.log`)}`);
    } finally { closeSync(fd); }
  }
  console.log(`PASS Cursor SDK upgrade resume; evidence: ${output}`);
}
