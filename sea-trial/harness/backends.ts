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
import { startMockSession } from "../fixtures/mock-session.js";
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
