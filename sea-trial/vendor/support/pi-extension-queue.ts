/* oxlint-disable max-statements, max-lines-per-function -- One isolated native extension and two separately held provider responses. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import type { Session } from "../../../packages/oar/src/contracts/session.js";
import { startPiAimock } from "../../harness/aimock.js";
import { runtimeUnderTest } from "../../harness/subject.js";
import { piTestRuntime } from "./pi-runtime.js";

export type ExtensionQueueMode = "sync-settled" | "async-settled" | "spawn-command" | "delayed-input";

/** All model calls are local. The real Pi extension schedules its own independent run. */
export async function piExtensionQueue(mode: ExtensionQueueMode): Promise<{
  session: Session; requests: string[]; releaseFirst(): void; releaseExtension(): void;
  entered(): Promise<void>; releaseInput(): Promise<void>; close(): Promise<void>;
}> {
  const requests: string[] = [];
  const extension = Promise.withResolvers<void>(), first = Promise.withResolvers<void>();
  const env = await startPiAimock(mock => { mock.on({ predicate: () => true }, async request => {
    const last = request.messages.findLast(message => message.role === "user");
    const text = JSON.stringify(last);
    const marker = ["OAR_QUEUE_A", "OAR_QUEUE_B", "OAR_QUEUE_EXT"].find(value => text.includes(value));
    assert.ok(marker !== undefined, text); requests.push(marker);
    if (marker === "OAR_QUEUE_A") { await first.promise; }
    if (marker === "OAR_QUEUE_EXT") { await extension.promise; }
    return { content: "native queue reply" };
  }); });
  const agentDir = process.env.OAR_PI_AGENT_DIR; assert.ok(agentDir !== undefined);
  const entered = path.join(agentDir, "queue-input-entered"), released = path.join(agentDir, "queue-input-release"), returned = path.join(agentDir, "queue-input-returned");
  const extensions = path.join(agentDir, "extensions"); await mkdir(extensions, { recursive: true });
  await writeFile(path.join(extensions, "native-queue.ts"), `
    import { existsSync, writeFileSync } from "node:fs";
    import { setImmediate, setTimeout } from "node:timers/promises";
    export default pi => {
      let sent = false;
      pi.registerCommand("spawn", { description: "Queue regression", handler: async () => { pi.sendUserMessage("OAR_QUEUE_EXT"); } });
      pi.on("agent_settled", async () => {
        if (sent) return;
        sent = true;
        if (${JSON.stringify(mode)} === "async-settled") await setImmediate();
        pi.sendUserMessage(${JSON.stringify(mode === "spawn-command" ? "/spawn" : "OAR_QUEUE_EXT")}, { expandPromptTemplates: true });
      });
      pi.on("input", async event => {
        if (event.text === "OAR_QUEUE_B") {
          writeFileSync(${JSON.stringify(entered)}, "entered");
          if (${JSON.stringify(mode)} === "delayed-input") {
            while (!existsSync(${JSON.stringify(released)})) await setTimeout(5);
          }
          writeFileSync(${JSON.stringify(returned)}, "returned");
        }
        return { action: "continue" };
      });
    }
  `);
  const session = await runtimeUnderTest(piTestRuntime).startSession({ model: "aimock/aimock-model" });
  return { session, requests, releaseFirst: (): void => { first.resolve(); }, releaseExtension: (): void => { extension.resolve(); },
    entered: async (): Promise<void> => { await vi.waitFor(() => { expect(existsSync(entered)).toBe(true); }, { timeout: 10_000 }); },
    releaseInput: async (): Promise<void> => { await writeFile(released, "release"); await vi.waitFor(() => { expect(existsSync(returned)).toBe(true); }, { timeout: 10_000 }); },
    close: async (): Promise<void> => { first.resolve(); extension.resolve(); await writeFile(released, "release"); await session.dispose(); await env.stop(); },
  };
}
