import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";

/** What a behavior case runs against: one runtime plus how to open a session on it. */
export interface RuntimeUnderTest {
  readonly id: string;
  readonly runtime: Runtime;
  /** Probe installation, then open a session in the current directory. */
  startSession(): Promise<Session>;
}

export function runtimeUnderTest(
  runtime: Runtime,
  env?: Readonly<Record<string, string>>,
): RuntimeUnderTest {
  return {
    id: runtime.id,
    runtime,
    async startSession() {
      if (runtime.installation === undefined) {
        throw new Error(`${runtime.id} lacks the installation capability`);
      }
      const installation = await runtime.installation();
      if (installation.kind !== "available") {
        throw new Error(`${runtime.id} is not available: ${installation.kind}`);
      }
      const model = process.env.OAR_TEST_MODEL;
      return runtime.session(installation, {
        cwd: process.cwd(),
        ...(model === undefined ? {} : { model }),
        ...(env === undefined ? {} : { env }),
      });
    },
  };
}
