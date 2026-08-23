import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { record } from "./trace.js";

/** What a behavior case runs against: one runtime plus how to open a session on it. */
export interface RuntimeUnderTest {
  readonly id: string;
  readonly runtime: Runtime;
  /** Probe installation, then open a session in the current directory. */
  startSession(overrides?: { readonly resume?: string }): Promise<Session>;
}

export function runtimeUnderTest(
  runtime: Runtime,
  env?: Readonly<Record<string, string>>,
): RuntimeUnderTest {
  return {
    id: runtime.id,
    runtime,
    async startSession(overrides = {}) {
      if (runtime.installation === undefined) {
        throw new Error(`${runtime.id} lacks the installation capability`);
      }
      const installation = await runtime.installation();
      if (installation.kind !== "available") {
        throw new Error(`${runtime.id} is not available: ${installation.kind}`);
      }
      const model = process.env.OAR_TEST_MODEL;
      const session = await runtime.session(installation, {
        cwd: process.cwd(),
        ...(model === undefined ? {} : { model }),
        ...(env === undefined ? {} : { env }),
        ...(overrides.resume === undefined ? {} : { resume: overrides.resume }),
      });
      record({ kind: "session_started", sessionId: session.id, resume: overrides.resume ?? null });
      session.subscribe((event) => {
        record({ kind: "session_event", event });
      });
      return session;
    },
  };
}
