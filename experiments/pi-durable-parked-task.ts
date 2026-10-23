/**
 * Probe the native restart limit with real process deaths and JSONL recovery.
 * No credentials or provider network calls. Kills only its own child processes.
 * Run: pnpm tsx experiments/pi-durable-parked-task.ts
 */
/* oxlint-disable import/max-dependencies -- This probe combines native SDK observation with process and temporary-storage control. */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai/providers/faux";
import { createRegistry, Harness, watchEvents, type ReportInfo } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createPiDurableRuntime } from "../packages/oar/src/runtimes/pi-durable/index.js";

function provider(): { models: ReturnType<typeof createModels>; faux: FauxProviderHandle } {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, faux };
}

async function interruptedChild(directory: string): Promise<never> {
  const { models, faux } = provider();
  faux.setResponses([async (): Promise<ReturnType<typeof fauxAssistantMessage>> => {
    process.stdout.write("provider_started\n");
    const response = await Promise.withResolvers<ReturnType<typeof fauxAssistantMessage>>().promise;
    return response;
  }]);
  const harness = await Harness.open(await openNodeJsonlStorage(directory, context), { models, registry: createRegistry() }, context);
  const conversation = await harness.root(context, { agent: { cwd: "/virtual", model: { provider: "faux", modelId: "faux-1" } } });
  // Same durable input on every restart, so no new runs or submissions are created.
  await conversation.submit({ type: "input", requestId: "interrupted", content: "Stay pending", whenBusy: "reject" }, context);
  harness.resume();
  process.stdin.resume();
  return Promise.withResolvers<never>().promise;
}

async function killDuringGeneration(directory: string): Promise<void> {
  const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--child", directory], { stdio: "pipe" });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  let interrupted = false;
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!interrupted && stdout.includes("provider_started\n")) {
      interrupted = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
  try {
    await closed;
    assert.ok(interrupted, `Child did not reach generation: code=${child.exitCode}, signal=${child.signalCode}, stderr=${stderr}`);
  } finally { clearTimeout(timeout); }
}

async function probe(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oar-durable-parked-"));
  let harness: Harness | undefined = undefined;
  try {
    for (let i = 0; i < 5; i++) {
      // oxlint-disable-next-line no-await-in-loop -- Each process reopens the storage left by the preceding crash.
      await killDuringGeneration(directory);
    }
    const { models, faux } = provider();
    faux.setResponses([fauxAssistantMessage("Recovered after explicit host retry")]);
    const reports: ReportInfo[] = [];
    harness = await Harness.open(await openNodeJsonlStorage(directory, context), {
      models, registry: createRegistry(), onReport: (_error, info) => { reports.push(info); },
    }, context);
    const conversation = await harness.root(context);
    const inspection = await harness.inspect(context);
    const parked = inspection.tasks.filter((task) => task.state.kind === "blocked" && task.state.reason === "restart_limit");
    assert.equal(parked.length, 1, JSON.stringify(inspection));
    const [task] = parked;
    assert.ok(task);
    assert.equal(task.record.restarts, 5);
    assert.ok(reports.some((info) => info.type === "task_parked" && info.task.id === task.record.id), JSON.stringify(reports));
    const watch = await watchEvents(harness, conversation.id, context);
    assert.ok(watch.snapshot.run);
    await watch.stop();
    const runtime = createPiDurableRuntime({ harness, models });
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume: String(conversation.id) });
    try {
      const attached = await harness.inspect(context);
      assert.ok(attached.tasks.some((entry) => entry.record.id === task.record.id && entry.state.kind === "blocked" && entry.state.reason === "restart_limit"));
      assert.equal(session.status().value.kind, "running");
      assert.equal(faux.state.callCount, 0);
      const endedBeforeRetry = session.records().filter((record) => record.kind === "frame")
        .flatMap((record) => record.body.events).filter((event) => event.kind === "turn_ended");
      assert.equal(endedBeforeRetry.length, 0);
      process.stdout.write(`${JSON.stringify({ phase: "parked", interruptions: 5, reports, tasks: parked.map((entry) => ({ kind: entry.record.kind, restarts: entry.record.restarts, state: entry.state })), snapshotHasRun: true, oarStatus: session.status().value.kind, oarTurnEnds: endedBeforeRetry.length, providerCalls: faux.state.callCount })}\n`);
      await harness.retryTask(task.record.id, context);
      await harness.waitForIdle(context);
      const completedWatch = await watchEvents(harness, conversation.id, context);
      assert.equal(completedWatch.snapshot.run, undefined);
      await completedWatch.stop();
      // Opening a second observer reads the committed terminal state independently of listener delivery.
      const recovered = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume: session.id });
      try {
        assert.equal(recovered.status().value.kind, "idle");
        assert.equal(faux.state.callCount, 1);
        const settled = await harness.inspect(context);
        assert.equal(settled.tasks.length, 0, JSON.stringify(settled));
        assert.equal(reports.filter((info) => info.type === "task_parked").length, 1);
        process.stdout.write(`${JSON.stringify({ phase: "retried", snapshotHasRun: false, oarStatus: recovered.status().value.kind, providerCalls: faux.state.callCount, remainingTasks: settled.tasks.length, parkedReports: reports.length })}\n`);
      } finally { await recovered.dispose(); }
    } finally { await session.dispose(); }
  } finally {
    await harness?.close(context);
    await rm(directory, { recursive: true, force: true });
  }
}

if (process.argv[2] === "--child") {
  const [directory] = process.argv.slice(3);
  assert.ok(directory !== undefined && directory !== "");
  await interruptedChild(directory);
} else { await probe(); }
