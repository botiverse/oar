import type { Runtime } from "./contracts/runtime.js";

export class RuntimeRegistry {
  readonly #runtimes: ReadonlyMap<string, Runtime>;

  constructor(runtimes: Iterable<Runtime>) {
    const indexed = new Map<string, Runtime>();
    for (const runtime of runtimes) {
      if (indexed.has(runtime.id)) {
        throw new Error(`duplicate runtime id: ${runtime.id}`);
      }
      indexed.set(runtime.id, runtime);
    }
    this.#runtimes = indexed;
  }

  get(id: string): Runtime | undefined {
    return this.#runtimes.get(id);
  }

  require(id: string): Runtime {
    const runtime = this.get(id);
    if (runtime === undefined) {
      throw new Error(`unknown runtime: ${id}`);
    }
    return runtime;
  }

  list(): readonly Runtime[] {
    return [...this.#runtimes.values()];
  }
}

export function createRuntimeRegistry(runtimes: Iterable<Runtime>): RuntimeRegistry {
  return new RuntimeRegistry(runtimes);
}
