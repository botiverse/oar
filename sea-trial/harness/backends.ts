import {
  claudeInstallation,
  claudeSession,
  codexInstallation,
  codexSession,
  defineRuntime,
  piInstallation,
  piSession,
  type Runtime,
} from "../../packages/oar/src/index.js";
import { readQwenModels } from "../../packages/oar/src/runtimes/qwen/list-models.js";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { isolatedQwenEnvironment, startQwenAimock } from "./qwen-aimock.js";
import { startDurableFixture } from "./pi-durable.js";
import { allRuntimes } from "./runtimes.js";
import { scriptedRuntime } from "../../packages/oar/src/testing/index.js";
import { MOCK_DEFAULT_EFFORT, MOCK_EFFORT_LEVELS, startMockSession } from "../fixtures/mock-session.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "./aimock.js";

/**
 * OAR_TEST backend selection. Every entry answers: which runtime, and does
 * it need a scripted provider stood up first. Unknown names fall through to
 * the real-runtime registry (OAR_TEST=claude runs the actual login).
 */
export interface Backend {
  readonly runtime: Runtime;
  readonly aimock: AimockEnv | null;
}

async function qwenBackend(): Promise<Backend> {
  const aimock = await startQwenAimock();
  const homes = new Map<string, Readonly<Record<string, string>>>();
  return {
    runtime: {
      ...qwenRuntime,
      id: "qwen-aimock",
      listModels: async (installation) => installation.via === "executable"
        ? { kind: "ok", models: await readQwenModels(installation.command, aimock.cwd, undefined, aimock.env) }
        : { kind: "unsupported", reason: "executable required" },
      session: async (installation, options) => {
        const environment = options.resume === undefined ? await isolatedQwenEnvironment(aimock) : homes.get(options.resume);
        if (environment === undefined) { throw new Error("Qwen behavior resume must use its original fixture HOME"); }
        const session = await qwenRuntime.session(installation, { ...options, cwd: aimock.cwd, env: { ...options.env, ...environment } });
        homes.set(session.id, environment);
        return session;
      },
    },
    aimock,
  };
}

export async function selectBackend(target: string): Promise<Backend> {
  switch (target) {
    case "mock":
      return {
        runtime: defineRuntime({
          id: "mock",
          session: startMockSession,
          installation: async () => {
            await Promise.resolve();
            return { kind: "available" as const, via: "bundled" as const };
          },
          // The effort menu the mock session enforces, so the effort cases
          // exercise the invariant: listed levels are accepted, others refused.
          listModels: async () => {
            await Promise.resolve();
            return { kind: "ok" as const, models: [{ id: "mock-1", effortLevels: MOCK_EFFORT_LEVELS, defaultEffort: MOCK_DEFAULT_EFFORT }] };
          },
        }),
        aimock: null,
      };
    case "scripted":
      // The public test runtime must honor the same contract as every vendor.
      return {
        runtime: scriptedRuntime({
          turn: async ({ input, say, signal }) => {
            await new Promise<void>((resolve) => {
              const timer = setTimeout(resolve, input.includes("slow") ? 200 : 10);
              signal.addEventListener("abort", () => {
                clearTimeout(timer);
                resolve();
              });
            });
            say(`echo:${input}`);
          },
        }),
        aimock: null,
      };
    case "claude-aimock": {
      // Real binary + real adapter; only the model provider is scripted.
      const aimock = await startClaudeAimock();
      return { runtime: defineRuntime({ id: target, session: claudeSession, installation: claudeInstallation }), aimock };
    }
    case "qwen-aimock": return qwenBackend();
    case "codex-aimock": {
      const aimock = await startCodexAimock();
      return { runtime: defineRuntime({ id: target, session: codexSession, installation: codexInstallation }), aimock };
    }
    case "pi-durable-aimock": {
      const fixture = await startDurableFixture();
      return {
        runtime: { ...fixture.runtime, session: async (installation, options) => { const session = await fixture.runtime.session(installation, { ...options, model: options.model ?? "aimock/aimock-model" }); return session; } },
        aimock: { mock: fixture.mock, raw: [], stop: async () => { await fixture.close(); } },
      };
    }
    case "pi-aimock": {
      const aimock = await startPiAimock(undefined, { imageInput: true });
      return { runtime: defineRuntime({ id: target, session: piSession, installation: piInstallation }), aimock };
    }
    default:
      return { runtime: allRuntimes.require(target), aimock: null };
  }
}
