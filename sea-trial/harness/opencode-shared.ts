import { experimentalOpenCodeRuntime } from "../../experiments/sharing/opencode-candidate.js";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { defineRuntime, opencodeRuntime } from "../../packages/oar/src/index.js";
import { startOpencodeAimock } from "./aimock-acp.js";
import type { Backend } from "./backends.js";

/** Every fresh behavior session gets a different project; resumes retain their original project. */
export async function opencodeSharedBackend(): Promise<Backend> {
  const aimock = await startOpencodeAimock(mock => {
    mock.onMessage(/slow/u, { content: "ok" }, { latency: 900 });
    mock.onMessage(/^(?![\s\S]*slow)[\s\S]*$/u, { content: "ok" }, { latency: 80 });
  });
  const root = await mkdtemp(path.join(os.tmpdir(), "oar-opencode-behavior-"));
  const runtime = experimentalOpenCodeRuntime().withPlacement("auto");
  const directories = new Map<string, string>();
  let next = 0;
  return {
    concurrency: 2, aimock,
    runtime: defineRuntime({ id: "opencode-shared", installation: opencodeRuntime.installation,
      session: async (installation, options) => {
        const cwd = options.resume === undefined ? path.join(root, String(next++)) : directories.get(options.resume);
        assert.ok(cwd !== undefined, "resume retains the observed native directory");
        await mkdir(cwd, { recursive: true });
        const session = await runtime.session(installation, { ...options, cwd, env: { ...options.env,
          PATH: (process.env.PATH ?? "").split(path.delimiter).filter(entry => path.isAbsolute(entry)).join(path.delimiter),
        } });
        directories.set(session.id, cwd);
        if (options.resume === undefined && session.placement !== "shared") {
          await session.dispose();
          assert.fail("fresh measured-version sessions must use sharing");
        }
        return session;
      },
    }, { execution: "process" }),
    close: async () => { await rm(root, { recursive: true, force: true }); },
  };
}
