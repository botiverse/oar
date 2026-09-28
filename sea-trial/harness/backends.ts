import {
  claudeInstallation,
  claudeSession,
  codexInstallation,
  codexSession,
  defineRuntime,
  piInstallation,
  piSession,
  runtimes,
  type Runtime,
} from "../../packages/oar/src/index.js";
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
    case "codex-aimock": {
      const aimock = await startCodexAimock();
      return { runtime: defineRuntime({ id: target, session: codexSession, installation: codexInstallation }), aimock };
    }
    case "pi-aimock": {
      const aimock = await startPiAimock();
      return { runtime: defineRuntime({ id: target, session: piSession, installation: piInstallation }), aimock };
    }
    default:
      return { runtime: runtimes.require(target), aimock: null };
  }
}
