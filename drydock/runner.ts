import type { Runtime } from "../src/contracts/runtime.js";

/** A daemon-free subject passed to sea-trial behavior cases. */
export interface RuntimeUnderTest {
  readonly id: string;
  readonly runtime: Runtime;
}

export function runtimeUnderTest(runtime: Runtime): RuntimeUnderTest {
  return { id: runtime.id, runtime };
}
