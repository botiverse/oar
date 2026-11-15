/* oxlint-disable typescript/no-unsafe-assignment, typescript/no-unsafe-member-access, typescript/no-unsafe-call, typescript/no-unsafe-argument, typescript/no-unsafe-return, typescript/strict-boolean-expressions, typescript/promise-function-async -- Standalone comparison of two native package ABIs loaded from caller-selected roots, not OAR's linked types. Assertions check the observer and receipt boundaries. */
/**
 * node --experimental-import-meta-resolve probe.mjs <package-root> <storage-directory> <create|reopen|advance> [pi-ai-alias]
 * Uses only a faux provider and disposable JSONL storage. Full captures are written beside the storage.
 */
import assert from "node:assert/strict";
import { resolve, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { writeFile } from "node:fs/promises";

const [root, directory, mode = "create", ai = "@earendil-works/pi-ai"] = process.argv.slice(2);
assert.ok(root && directory && ["create", "reopen", "advance"].includes(mode));
const load = name => import(import.meta.resolve(name, pathToFileURL(resolve(root, "package.json")).href));
const durable = await load("@earendil-works/pi-durable");
const { BACKGROUND_CONTEXT: context } = await load("@earendil-works/chord/context");
const { openNodeJsonlStorage } = await load("@earendil-works/pi-durable/storage/jsonl/node");
const { createModels } = await load(`${ai}/models`);
const { fauxProvider, fauxAssistantMessage } = await load(`${ai}/providers/faux`);
const models = createModels();
const faux = fauxProvider({ tokensPerSecond: 1000 });
models.setProvider(faux.provider);
faux.setResponses([fauxAssistantMessage("NATIVE_COMPLETE")]);
const frames = [];
const capture = (kind, value) => frames.push({ kind, value });
let harness = null;
const deadline = setTimeout(() => { throw new Error("Native probe exceeded 30 seconds"); }, 30_000);
try {
  harness = await durable.Harness.open(await openNodeJsonlStorage(directory, context), {
    models, registry: durable.createRegistry(), settings: { progress: { partialIntervalMs: 0 } },
  }, context);
  const conversation = await harness.root(context, { agent: {
    model: { provider: "faux", modelId: "faux-1" }, instructions: "STORED_INSTRUCTIONS", cwd: "/virtual",
  } });
  if (mode === "create" || mode === "advance") {
    let observer = null;
    let watch = null;
    const gate = Promise.withResolvers();
    const entered = Promise.withResolvers();
    const drained = Promise.withResolvers();
    if (harness.observeConversation) {
      observer = await harness.observeConversation(conversation.id, {
        advance(call) { capture("observer", call); },
        end(end) { capture("end", end); },
      }, context);
      capture("observer_initial", observer.value);
      watch = await conversation.watch(context);
      let first = true;
      watch.start(async call => {
        capture("watch", call);
        if (first) { first = false; entered.resolve(); await gate.promise; }
        else { drained.resolve(); }
      });
      await conversation.submit({ type: "write", entry: { kind: "probe.note", data: { marker: "hold" } } }, context);
      await entered.promise;
    }
    const submission = await conversation.submit({ type: "input", requestId: mode === "advance" ? "upgraded" : "original", content: "synthetic", whenBusy: "reject" }, context);
    capture("receipt", await submission.wait(context));
    await conversation.waitForIdle(context);
    gate.resolve();
    if (watch) {
      await drained.promise;
      capture("watch_final", watch.value);
      await watch.stop();
    }
    observer?.detach();
  } else {
    const submission = await conversation.submit({ type: "input", requestId: "original", content: "duplicate" }, context);
    capture("receipt", await submission.status(context));
    const watch = await conversation.watch(context);
    capture("reopened", watch.value);
    assert.equal(watch.value.docs["pi.agent"].instructions, "STORED_INSTRUCTIONS");
    await watch.stop();
  }
  capture("context", await conversation.context(context));
  const summary = {
    mode, conversationId: conversation.id,
    observeConversation: Boolean(harness.observeConversation), watchEvents: typeof durable.watchEvents,
    observerFrames: frames.filter(frame => frame.kind === "observer").length,
    watchFrames: frames.filter(frame => frame.kind === "watch").length,
    observerSawRun: frames.some(frame => frame.kind === "observer" && frame.value.value?.docs?.["pi.live"]?.run),
    watchSawRun: frames.some(frame => frame.kind === "watch" && frame.value.value?.docs?.["pi.live"]?.run),
    receipt: frames.find(frame => frame.kind === "receipt")?.value,
  };
  if (mode === "create" && harness.observeConversation) {
    assert.equal(summary.observerSawRun, true);
    assert.equal(summary.watchSawRun, false);
  }
  capture("summary", summary);
  console.log(JSON.stringify(summary));
} catch (error) {
  capture("error", { name: error.name, message: error.message, stack: error.stack });
  console.error(error.stack);
  console.log(JSON.stringify({ mode, error: { name: error.name, message: error.message } }));
  process.exitCode = 1;
} finally {
  clearTimeout(deadline);
  await harness?.close(context);
  const output = resolve(directory, "..", `probe-${basename(directory)}-${mode}.json`);
  await writeFile(output, `${JSON.stringify(frames, null, 2)}\n`);
}
