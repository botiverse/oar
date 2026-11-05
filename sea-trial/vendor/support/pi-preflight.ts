import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, vi } from "vitest";
import { startPiAimock } from "../../harness/aimock.js";
import { runtimeUnderTest } from "../../harness/subject.js";
import { piTestRuntime } from "./pi-runtime.js";
import type { Session } from "../../../packages/oar/src/contracts/session.js";

/** Public native input hooks hold preflight and reload the synthetic provider's authentication. */
export async function piPreflightNative(): Promise<{
  session: Session; requests: string[]; entered(): Promise<void>; release(): Promise<void>; close(): Promise<void>;
}> {
  const requests: string[] = [];
  const env = await startPiAimock(mock => { mock.on({ predicate: () => true }, request => {
    requests.push(JSON.stringify(request.messages)); return { content: "native reply" };
  }); });
  const agentDir = process.env.OAR_PI_AGENT_DIR;
  assert.ok(agentDir !== undefined);
  const models = path.join(agentDir, "models.json");
  const entered = path.join(agentDir, "preflight-entered");
  const release = path.join(agentDir, "preflight-release");
  const extensions = path.join(agentDir, "extensions"); await mkdir(extensions, { recursive: true });
  await writeFile(path.join(extensions, "preflight.ts"), `
    import { existsSync } from "node:fs";
    import { readFile, writeFile } from "node:fs/promises";
    import { setTimeout } from "node:timers/promises";
    export default pi => {
      pi.on("input", async (event, ctx) => {
        if (event.text === "A") {
          await writeFile(${JSON.stringify(entered)}, "entered");
          while (!existsSync(${JSON.stringify(release)})) await setTimeout(5);
        }
        if (event.text === "B" || event.text === "C" || event.text === "A") {
          const models = JSON.parse(await readFile(${JSON.stringify(models)}, "utf8"));
          if (event.text !== "C") delete models.providers.aimock.apiKey;
          else models.providers.aimock.apiKey = "aimock";
          await writeFile(${JSON.stringify(models)}, JSON.stringify(models));
          await ctx.modelRegistry.refresh();
        }
        return { action: "continue" };
      });
    }
  `);
  const session = await runtimeUnderTest(piTestRuntime).startSession({ model: "aimock/aimock-model" });
  return { session, requests,
    entered: async (): Promise<void> => { await vi.waitFor(() => { expect(existsSync(entered)).toBe(true); }, { timeout: 10_000 }); },
    release: async (): Promise<void> => { await writeFile(release, "release"); },
    close: async (): Promise<void> => { await writeFile(release, "release"); await session.dispose(); await env.stop(); },
  };
}
