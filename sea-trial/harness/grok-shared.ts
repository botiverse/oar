import assert from "node:assert/strict";
import path from "node:path";
import { defineRuntime, grokRuntime } from "../../packages/oar/src/index.js";
import { startGrokAimock } from "./aimock-acp.js";
import type { Backend } from "./backends.js";

/** Every root uses the same project; fresh and concurrent sessions must remain shared. */
export async function grokSharedBackend(): Promise<Backend> {
  const aimock = await startGrokAimock(mock => {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  });
  const runtime = grokRuntime.withPlacement("auto");
  return {
    concurrency: 2, aimock,
    runtime: defineRuntime({ id: "grok-shared", installation: grokRuntime.installation,
      session: async (installation, options) => {
        const session = await runtime.session(installation, { ...options, cwd: aimock.env.HOME ?? process.cwd(), env: { ...options.env,
          PATH: (process.env.PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry)).join(path.delimiter),
        } });
        if (options.resume === undefined && session.placement !== "shared") {
          await session.dispose(); assert.fail("Grok 1.0.70 fresh sessions must share, including repeated directories");
        }
        return session;
      },
    }, { execution: "process" }),
  };
}
