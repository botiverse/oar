import type { Runtime } from "../packages/oar/src/contracts/runtime.js";
import type { Session } from "../packages/oar/src/contracts/session.js";

/** A daemon-free subject passed to sea-trial behavior cases. */
export interface RuntimeUnderTest {
  readonly id: string;
  readonly runtime: Runtime;
  /** Probe installation, then open a session in the current directory. */
  startSession(): Promise<Session>;
}

export function runtimeUnderTest(runtime: Runtime): RuntimeUnderTest {
  return {
    id: runtime.id,
    runtime,
    async startSession() {
      if (runtime.installation === undefined || runtime.session === undefined) {
        throw new Error(`${runtime.id} lacks installation or session capability`);
      }
      const installation = await runtime.installation();
      if (installation.kind !== "available") {
        throw new Error(`${runtime.id} is not available: ${installation.kind}`);
      }
      return runtime.session(installation, { cwd: process.cwd() });
    },
  };
}
