import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { Harness } from "@earendil-works/pi-durable";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import { createPiDurableRuntime } from "../../packages/oar/src/runtimes/pi-durable/index.js";
import { awaitTurnEnd } from "../../packages/oar/src/observe/turns.js";
import { startDurableFixture } from "../harness/pi-durable.js";

/** Generous on purpose: a native submission settles on its own clock, past `vi.waitFor`'s 1 s default on slow CI runners (macOS). */
const WAIT = { timeout: 15_000 };

const nativeTest = test.skipIf(process.env.OAR_TEST !== "pi-durable-aimock");
nativeTest("JSONL recovery adopts a pending run, preserves queued input and deduplicates across Harness instances", async () => {
  const directory = await mkdtemp(join(tmpdir(), "oar-durable-recovery-"));
  const fixture = await startDurableFixture(undefined, await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT));
  let reopened: Harness | undefined = undefined;
  try {
    const options = { cwd: "/virtual", model: "aimock/aimock-model", appendSystemPrompt: "persistent instructions" };
    const session = await fixture.runtime.session({ kind: "available", via: "bundled" }, options);
    const inputId = globalThis.crypto.randomUUID();
    await session.prompt("slow recover", { inputId });
    await session.queue("queued after restart");
    await vi.waitFor(() => { expect(fixture.mock.getRequests().length).toBeGreaterThan(0); }, WAIT);
    await session.dispose();
    await fixture.harness.close(BACKGROUND_CONTEXT);
    reopened = await Harness.open(await openNodeJsonlStorage(directory, BACKGROUND_CONTEXT), { models: fixture.models, registry: fixture.registry }, BACKGROUND_CONTEXT);
    const runtime = createPiDurableRuntime({ harness: reopened, models: fixture.models });
    const restored = await runtime.session({ kind: "available", via: "bundled" }, { cwd: options.cwd, resume: session.id });
    expect(restored.status().value.kind).toBe("running");
    const repeated = await restored.prompt("slow recover", { inputId });
    expect(repeated.kind).toBe("accepted");
    await reopened.waitForIdle(BACKGROUND_CONTEXT);
    await vi.waitFor(() => { expect(restored.status().value.kind).toBe("idle"); }, WAIT);
    expect(await awaitTurnEnd(restored, repeated.seq)).toEqual({ kind: "completed" });
    const ended = restored.records().filter((record) => record.kind === "frame").flatMap((record) => record.body.events).filter((event) => event.kind === "turn_ended");
    expect(ended).toHaveLength(2);
    const requestCount = fixture.mock.getRequests().length;
    const again = await restored.prompt("slow recover", { inputId });
    expect(again.kind).toBe("accepted");
    expect(restored.status().value.kind).toBe("idle");
    expect(fixture.mock.getRequests()).toHaveLength(requestCount);
    expect(JSON.stringify(fixture.mock.getRequests().at(-1))).toContain("persistent instructions");
    await restored.dispose();
  } finally {
    await reopened?.close(BACKGROUND_CONTEXT);
    await fixture.close();
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
  }
});
