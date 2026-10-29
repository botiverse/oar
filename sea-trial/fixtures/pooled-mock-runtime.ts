import { defineRuntime, type Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { SessionResources, StartSession } from "../../packages/oar/src/contracts/session.js";
import { createProcessPool } from "../../packages/oar/src/shared/process-pool.js";
import { processSessionLifecycle } from "../../packages/oar/src/shared/process-session.js";
import { createMockSession, MOCK_DEFAULT_EFFORT, MOCK_EFFORT_LEVELS } from "./mock-session.js";

/** Synthetic process ownership only. Timers produce the mock's native frames. */
function sessionFactory(placement: "shared" | "isolated"): StartSession {
  const pool = createProcessPool(async () => {
    await Promise.resolve();
    const exit = Promise.withResolvers<number | null>();
    const stops = new Set<() => void>();
    let ended = false;
    return {
      stops,
      exited: exit.promise,
      stop: (): void => { ended = true; for (const stop of stops) { stop(); } exit.resolve(0); },
      resources: async (): Promise<SessionResources | null> => { await Promise.resolve(); return ended ? null : { rss: 100, processes: 1 }; },
    };
  });
  return createMockSession(async (kernel, options, stop) => {
    const lease = await pool.acquire({ command: "mock", args: options.launchArgs ?? [], env: options.env ?? {}, ...(options.env?.HOME === undefined || options.env.HOME === null ? {} : { home: options.env.HOME }) }, placement);
    lease.process.stops.add(stop);
    const lifecycle = processSessionLifecycle(kernel, lease, async () => { stop(); lease.process.stops.delete(stop); await Promise.resolve(); });
    return { dispose: lifecycle.dispose, resources: lease.resources };
  });
}

/** A fresh runtime instance owns its pool. Native runtimes remain behind their evidence gate. */
export function pooledMockRuntime(): Runtime {
  return defineRuntime({
    id: "pooled-mock",
    session: sessionFactory("isolated"),
    installation: async () => { await Promise.resolve(); return { kind: "available", via: "bundled" }; },
    listModels: async () => { await Promise.resolve(); return { kind: "ok", models: [{ id: "mock-1", effortLevels: MOCK_EFFORT_LEVELS, defaultEffort: MOCK_DEFAULT_EFFORT }] }; },
  }, { shared: { refusal: () => null, session: () => sessionFactory("shared") } });
}
