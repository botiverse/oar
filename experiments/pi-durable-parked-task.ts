/**
 * Probe Pi Durable 1.5.2 restart settlement with real process deaths and JSONL recovery.
 * The 1.4 parking/retryTask probe remains in git history; those native APIs are gone.
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
import { createModels } from "@earendil-works/pi-ai-durable/models";
import { fauxAssistantMessage, fauxProvider, type FauxProviderHandle } from "@earendil-works/pi-ai-durable/providers/faux";
import { createRegistry, Harness, type Report } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createPiDurableRuntime } from "../packages/oar/src/runtimes/pi-durable/index.js";

function provider(): { models: ReturnType<typeof createModels>; faux: FauxProviderHandle } {
  const models = createModels();
  const faux = fauxProvider();
  models.setProvider(faux.provider);
  return { models, faux };
}

async function interruptedChild(directory: string): Promise<void> {
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
  await harness.waitForIdle(context);
  const submission = await conversation.submit({ type: "input", requestId: "interrupted", content: "duplicate" }, context);
  process.stdout.write(`${JSON.stringify({ terminal: await submission.status(context) })}\n`);
  await harness.close(context);
}

async function killDuringGeneration(directory: string): Promise<boolean> {
  const child = spawn(process.execPath, ["--import", "tsx", import.meta.filename, "--child", directory], { stdio: "pipe" });
  const closed = once(child, "close");
  let stdout = "";
  let stderr = "";
  const state = { interrupted: false };
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
    if (!state.interrupted && stdout.includes("provider_started\n")) {
      state.interrupted = true;
      child.kill("SIGKILL");
    }
  });
  child.stderr.on("data", (chunk: string) => { stderr += chunk; });
  const timeout = setTimeout(() => { child.kill("SIGKILL"); }, 15_000);
  try {
    await closed;
    assert.ok(state.interrupted || (child.exitCode === 0 && stdout.includes('"terminal"')), `Child neither reached generation nor settled: code=${child.exitCode}, signal=${child.signalCode}, stdout=${stdout}, stderr=${stderr}`);
    if (!state.interrupted) { process.stdout.write(stdout); }
    return state.interrupted;
  } finally { clearTimeout(timeout); }
}

async function probe(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "oar-durable-parked-"));
  let harness: Harness | undefined = undefined;
  try {
    let interruptions = 0;
    for (let i = 0; i < 8; i++) {
      // oxlint-disable-next-line no-await-in-loop -- Each restart observes the preceding process's persisted state.
      if (!await killDuringGeneration(directory)) { break; }
      interruptions += 1;
    }
    assert.ok(interruptions > 0 && interruptions < 8, `No bounded native settlement after ${String(interruptions)} interruptions`);
    const { models, faux } = provider();
    faux.setResponses([fauxAssistantMessage("Recovered with a new input")]);
    const reports: Report[] = [];
    harness = await Harness.open(await openNodeJsonlStorage(directory, context), {
      models, registry: createRegistry(), onReport: report => { reports.push(report); },
    }, context);
    const conversation = await harness.root(context);
    const watch = await conversation.watch(context);
    const live = watch.value.docs["pi.live"];
    await watch.stop();
    assert.equal(live?.run, undefined);
    assert.notEqual(live?.runFailure, undefined);
    const runtime = createPiDurableRuntime({ harness, models });
    const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume: String(conversation.id) });
    try {
      assert.equal(session.status().value.kind, "idle");
      assert.equal(faux.state.callCount, 0);
      const ends = session.records().flatMap(record => record.kind === "frame" ? record.body.events : []).filter(event => event.kind === "turn_ended");
      assert.equal(ends.length, 0, "An attachment must not invent a new terminal turn from old history");
      process.stdout.write(`${JSON.stringify({ phase: "settled", interruptions, live, oarStatus: session.status().value.kind, providerCalls: faux.state.callCount, reports })}\n`);
      await session.prompt("new input after native failure");
      await harness.waitForIdle(context);
      const recovered = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/virtual", resume: session.id });
      try {
        assert.equal(recovered.status().value.kind, "idle");
        assert.equal(faux.state.callCount, 1);
        process.stdout.write(`${JSON.stringify({ phase: "new_input", oarStatus: recovered.status().value.kind, providerCalls: faux.state.callCount })}\n`);
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
