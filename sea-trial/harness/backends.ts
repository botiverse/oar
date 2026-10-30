import { codebuddyRuntime } from "../../packages/oar/src/runtimes/codebuddy/index.js";
import { startCodebuddyAimock } from "./codebuddy-aimock.js";
import { pooledMockRuntime } from "../fixtures/pooled-mock-runtime.js";
import type { RuntimePlacementOptions } from "../../packages/oar/src/contracts/placement.js";
/* oxlint-disable import/max-dependencies -- This composition root selects the shared suite's native backends. */
import { measureQoderStartup } from "./qoder-startup.js";
import {
  claudeInstallation,
  claudeRuntime,
  claudeSession,
  codexInstallation,
  codexRuntime,
  codexSession,
  defineRuntime,
  piInstallation,
  piRuntime,
  piSession,
  type AvailableInstallation,
  createPiRuntime,
  type Runtime,
} from "../../packages/oar/src/index.js";
import { qoderRefusedSessionOptions } from "../../packages/oar/src/runtimes/qoder/options.js";
import { qoderRuntime } from "../../packages/oar/src/runtimes/qoder/index.js";
import { startQoderNative } from "./qoder-native.js";
import { readQwenModels } from "../../packages/oar/src/runtimes/qwen/list-models.js";
import { qwenRuntime } from "../../packages/oar/src/runtimes/qwen/index.js";
import { isolatedQwenEnvironment, startQwenAimock } from "./qwen-aimock.js";
import { measureQwenStartup, recordQwenOpen } from "./qwen-startup.js";
import { startDurableFixture } from "./pi-durable.js";
import { allRuntimes } from "./runtimes.js";
import { scriptedRuntime } from "../../packages/oar/src/testing/index.js";
import { MOCK_DEFAULT_EFFORT, MOCK_EFFORT_LEVELS, startMockSession } from "../fixtures/mock-session.js";
import { startClaudeAimock, startCodexAimock, startPiAimock, type AimockEnv } from "./aimock.js";
import { acpBackend } from "./acp-backends.js";

/**
 * OAR_TEST backend selection. Every entry answers: which runtime, and does
 * it need a scripted provider stood up first. Unknown names fall through to
 * the real-runtime registry (OAR_TEST=claude runs the actual login).
 */
export interface Backend {
  readonly runtime: Runtime;
  readonly aimock: AimockEnv | null;
  readonly concurrency?: number;
  readonly beforeSuite?: (installation: AvailableInstallation) => Promise<void>;
  /** Cleanup for native replay fixtures that need no model HTTP server. */
  readonly close?: () => Promise<void>;
}

/** Keep the native declaration when a fixture exposes only session capabilities. */
function executionOptions(runtime: Runtime): RuntimePlacementOptions {
  return runtime.execution === null ? {} : { execution: runtime.execution };
}

async function qwenBackend(): Promise<Backend> {
  const aimock = await startQwenAimock();
  const homes = new Map<string, Readonly<Record<string, string>>>();
  return {
    ...(process.env.CI === undefined ? {} : {
      concurrency: 2,
      beforeSuite: async (installation: AvailableInstallation) => { await measureQwenStartup(installation, aimock); },
    }),
    runtime: {
      ...qwenRuntime,
      id: "qwen-aimock",
      listModels: async (installation) => installation.via === "executable"
        ? { kind: "ok", models: await readQwenModels(installation.command, aimock.cwd, undefined, aimock.env) }
        : { kind: "unsupported", reason: "executable required" },
      session: async (installation, options) => {
        const environment = options.resume === undefined ? await isolatedQwenEnvironment(aimock) : homes.get(options.resume);
        if (environment === undefined) { throw new Error("Qwen behavior resume must use its original fixture HOME"); }
        const session = await recordQwenOpen("suite", options.resume !== undefined, async () => {
          const opened = await qwenRuntime.session(installation, { ...options, cwd: aimock.cwd, env: { ...options.env, ...environment } });
          return opened;
        });
        homes.set(session.id, environment);
        return session;
      },
    },
    aimock,
  };
}

export async function selectBackend(target: string): Promise<Backend> {
  switch (target) {
    case "mock-shared":
    case "mock-isolated":
      return { runtime: pooledMockRuntime().withPlacement(target === "mock-shared" ? "shared" : "isolated"), aimock: null };
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
        }, { execution: "in_process" }),
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
      return { runtime: defineRuntime({ id: target, session: claudeSession, installation: claudeInstallation }, executionOptions(claudeRuntime)), aimock };
    }
    case "qwen-aimock": return qwenBackend();
    case "codebuddy-aimock": {
      const aimock = await startCodebuddyAimock();
      return { aimock, concurrency: 1, runtime: {
        ...codebuddyRuntime, id: target,
        listModels: async (installation, options) => {
          const result = await codebuddyRuntime.listModels(installation, { ...options, cwd: aimock.cwd, env: { ...options?.env, ...aimock.env } });
          return result;
        },
        session: async (installation, options) => {
          const session = await codebuddyRuntime.session(installation, {
          ...options, cwd: aimock.cwd, env: { ...options.env, ...aimock.env },
          launchArgs: ["--model", "deepseek-flash", ...options.launchArgs ?? []],
          });
          return session;
        },
      } };
    }
    case "antigravity-aimock": return acpBackend("antigravity");
    case "kimi-aimock": return acpBackend("kimi");
    case "grok-aimock": return acpBackend("grok");
    case "opencode-aimock": return acpBackend("opencode");
    case "qoder-native": {
      const fixture = await startQoderNative(Array.from({ length: 100 }, () => ({ chunks: ["o", "k"] })), 900);
      const runtime = defineRuntime({
        id: target, installation: qoderRuntime.installation, refusedSessionOptions: qoderRefusedSessionOptions,
        session: async (installation, options) => {
          const session = await qoderRuntime.session(installation, { ...options, ...fixture.options, model: options.model ?? "efficient" });
          return session;
        },
      }, executionOptions(qoderRuntime));
      return { aimock: null, close: fixture.stop, runtime, ...(process.env.OAR_QODER_STARTUP_PROBE === "1" ? { beforeSuite: measureQoderStartup } : {}) };
    }
    case "codex-aimock": {
      const aimock = await startCodexAimock();
      return { runtime: defineRuntime({ id: target, session: codexSession, installation: codexInstallation }, executionOptions(codexRuntime)), aimock };
    }
    case "pi-durable-aimock": {
      const fixture = await startDurableFixture();
      return {
        runtime: { ...fixture.runtime, session: async (installation, options) => { const session = await fixture.runtime.session(installation, { ...options, model: options.model ?? "aimock/aimock-model" }); return session; } },
        aimock: { mock: fixture.mock, raw: [], stop: async () => { await fixture.close(); } },
      };
    }
    case "pi-rpc-aimock":
    case "pi-aimock": {
      const aimock = await startPiAimock(undefined, { imageInput: true });
      const native = target === "pi-rpc-aimock" ? createPiRuntime({ execution: "subprocess" }) : piRuntime;
      return { runtime: defineRuntime({ id: target, session: target === "pi-rpc-aimock" ? native.session : piSession, installation: piInstallation }, executionOptions(native)), aimock };
    }
    default:
      return { runtime: allRuntimes.require(target), aimock: null };
  }
}
