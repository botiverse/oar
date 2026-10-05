import path from "node:path";
import type { AvailableInstallation } from "../contracts/installation.js";
import type { Runtime } from "../contracts/runtime.js";
import type { Session, TaskEventBody, Unsubscribe } from "../contracts/session.js";
import { applyTaskEvent, initialTasks, type TaskMap, type TaskView } from "../observe/tasks.js";
import { defaultRuntimes as builtInRuntimes } from "../index.js";
import { attachLog, DEFAULT_WAIT_MS, hostDepth, installationOf, logName, readerOrTimeout, sessionOf, SUBAGENT_DEPTH_ENV } from "./helpers.js";
import { createSubagent } from "./subagent.js";
import type {
  SpawnOptions,
  SpawnResult,
  Subagent,
  SubagentInfo,
  SubagentReport,
  Subagents,
  SubagentsOptions,
  SubagentTaskEvent,
  WaitOptions,
} from "./types.js";

/**
 * Subagents: child sessions a host starts on any runtime, follows by
 * reports (one per turn their root agent ends) and task events, and can feed
 * back into a parent session. The mechanism is here; limits, permissions and
 * whether reports wake a parent are the host's choices.
 */
export function createSubagents(options: SubagentsOptions = {}): Subagents {
  const registry = options.runtimes ?? builtInRuntimes;
  const maxRunning = options.maxRunning ?? 4;
  const maxDepth = options.maxDepth ?? 1;
  const agents = new Map<string, Subagent>();
  const reserved = new Map<string, number>();
  const readers = new Set<() => void>();
  const taskObservers = new Set<(event: SubagentTaskEvent) => void>();
  const inFlight = new Set<Promise<SpawnResult>>();
  const reportHandlers = new Set<(report: SubagentReport) => void>();
  let unread: SubagentReport[] = [];
  let tasks: TaskMap = initialTasks;
  let starting = 0;
  let closed = false;

  const running = (): number => starting + [...agents.values()].filter((agent) => agent.info().state === "running").length;

  const wake = (): void => {
    for (const reader of readers) {
      reader();
    }
  };

  const emitTask = (body: TaskEventBody): void => {
    const at = Date.now();
    tasks = applyTaskEvent(tasks, body, { sessionId: "", agentPath: [], receivedAt: at });
    for (const observer of taskObservers) {
      try {
        observer({ ...body, at });
      } catch {
        // An observer's failure is its own; the next one still hears.
      }
    }
  };

  const received = (report: SubagentReport): void => {
    if (reportHandlers.size > 0 && !reserved.has(report.id)) {
      let handled = false;
      for (const handler of reportHandlers) {
        try {
          handler(report);
          handled = true;
        } catch {
          // The next handler still gets it; a report no handler takes stays unread.
        }
      }
      if (handled) {
        return;
      }
    }
    unread.push(report);
    wake();
  };

  const freeId = (spawn: SpawnOptions): string => {
    const base = spawn.name ?? spawn.runtime;
    if (spawn.name !== undefined && !agents.has(base)) {
      return base;
    }
    let n = 1;
    while (agents.has(`${base}-${String(n)}`)) {
      n += 1;
    }
    return `${base}-${String(n)}`;
  };

  const register = (spawn: SpawnOptions, runtime: Runtime, session: Session, log: string | undefined): Subagent => {
    const id = freeId(spawn);
    const agent = createSubagent({ id, runtime: runtime.id, ...(spawn.name === undefined ? {} : { name: spawn.name }), ...(log === undefined ? {} : { log }) }, session, {
      report: received,
      task: emitTask,
      mayRun: () => running() < maxRunning,
      closed: wake,
    });
    agents.set(id, agent);
    const description = spawn.name ?? spawn.task.split("\n")[0]?.slice(0, 120) ?? "";
    emitTask({ kind: "task_started", taskId: id, taskType: "agent", nativeType: "oar-subagent", description, childSessionId: session.id, background: true });
    return agent;
  };

  const open = async (spawn: SpawnOptions, runtime: Runtime, installation: AvailableInstallation, registered: () => void): Promise<SpawnResult> => {
    const cwd = spawn.cwd ?? options.cwd ?? process.cwd();
    const session = await sessionOf(runtime, installation, {
      cwd,
      ...(spawn.model === undefined ? {} : { model: spawn.model }),
      ...(spawn.effort === undefined ? {} : { effort: spawn.effort }),
      ...(spawn.resume === undefined ? {} : { resume: spawn.resume }),
      env: { ...options.env, ...spawn.env, [SUBAGENT_DEPTH_ENV]: String(hostDepth() + 1) },
    });
    if (typeof session === "string") {
      return { kind: "refused", code: "open_failed", reason: session };
    }
    const log = options.logDir === undefined ? undefined : path.join(options.logDir, logName(spawn.name ?? spawn.runtime, session.id));
    const logFailure = log === undefined ? null : attachLog(session, log, { runtime: runtime.id, cwd, sessionId: session.id, startedAt: Date.now(), recorder: "oar-subagents",
      ...(spawn.model === undefined ? {} : { model: spawn.model }), ...(spawn.effort === undefined ? {} : { effort: spawn.effort }) });
    if (closed || logFailure !== null) {
      await session.dispose();
      return logFailure === null
        ? { kind: "refused", code: "closed", reason: "the subagents were closed while this one opened" }
        : { kind: "refused", code: "open_failed", reason: `cannot write the log: ${logFailure}` };
    }
    const agent = register(spawn, runtime, session, log);
    registered();
    const outcome = await session.prompt(spawn.task);
    if (outcome.kind === "rejected") {
      await agent.close();
      agents.delete(agent.id);
      return { kind: "refused", code: "rejected", reason: outcome.reason };
    }
    return { kind: "spawned", agent };
  };

  const refusal = (spawn: SpawnOptions): SpawnResult | null => {
    if (closed) {
      return { kind: "refused", code: "closed", reason: "the subagents are closed" };
    }
    const runtime = registry.get(spawn.runtime);
    if (runtime === undefined) {
      return { kind: "refused", code: "unknown_runtime", reason: `unknown runtime: ${spawn.runtime}` };
    }
    // A child carries its depth in `env`, so a runtime that refuses `env` cannot be one.
    const envRefused = runtime.refusedSessionOptions?.env;
    if (envRefused !== undefined) {
      return { kind: "refused", code: "open_failed", reason: `${spawn.runtime} cannot be a subagent: ${envRefused}` };
    }
    if (hostDepth() + 1 > maxDepth) {
      return { kind: "refused", code: "depth_limit", reason: `subagents nest at most ${String(maxDepth)} deep; do this task yourself` };
    }
    return running() >= maxRunning
      ? { kind: "refused", code: "running_limit", reason: `${String(maxRunning)} subagents are already running; wait for one to finish rather than retrying` }
      : null;
  };

  const spawnOne = async (spawn: SpawnOptions, runtime: Runtime): Promise<SpawnResult> => {
    // Counted from the refusal check until the child is registered, where its own state takes over.
    starting += 1;
    let counted = true;
    const release = (): void => {
      if (counted) {
        counted = false;
        starting -= 1;
      }
    };
    try {
      const installation = await installationOf(runtime);
      if (typeof installation === "string") {
        return { kind: "refused", code: "not_installed", reason: installation };
      }
      const result = await open(spawn, runtime, installation, release);
      return result;
    } finally {
      release();
    }
  };

  const take = (ids?: readonly string[]): SubagentReport[] => {
    const wanted = (report: SubagentReport): boolean => (ids === undefined ? !reserved.has(report.id) : ids.includes(report.id));
    const taken = unread.filter((report) => wanted(report));
    unread = unread.filter((report) => !wanted(report));
    return taken;
  };

  const reserve = (id: string, delta: number): void => {
    const count = (reserved.get(id) ?? 0) + delta;
    if (count <= 0) {
      reserved.delete(id);
    } else {
      reserved.set(id, count);
    }
  };

  const next = async (id: string, signal?: AbortSignal): Promise<SubagentReport | null> => {
    reserve(id, 1);
    try {
      const over = (): boolean => closed || signal?.aborted === true || agents.get(id)?.info().state === "closed";
      let [report] = take([id]);
      while (report === undefined && !over()) {
        await readerOrTimeout(readers, 60_000, signal);
        [report] = take([id]);
      }
      return report ?? null;
    } finally {
      reserve(id, -1);
    }
  };

  return {
    spawn: async (spawn: SpawnOptions): Promise<SpawnResult> => {
      const refused = refusal(spawn);
      const runtime = registry.get(spawn.runtime);
      if (refused !== null || runtime === undefined) {
        return refused ?? { kind: "refused", code: "unknown_runtime", reason: `unknown runtime: ${spawn.runtime}` };
      }
      const pending = spawnOne(spawn, runtime);
      inFlight.add(pending);
      try {
        const result = await pending;
        return result;
      } finally {
        inFlight.delete(pending);
      }
    },
    get: (id: string): Subagent | undefined => agents.get(id),
    list: (): readonly SubagentInfo[] => [...agents.values()].map((agent) => agent.info()),
    wait: async (wait: WaitOptions = {}): Promise<readonly SubagentReport[]> => {
      const deadline = Date.now() + (wait.timeoutMs ?? DEFAULT_WAIT_MS);
      const over = (): boolean => closed || wait.signal?.aborted === true || Date.now() >= deadline;
      let taken = take(wait.ids);
      while (taken.length === 0 && !over()) {
        await readerOrTimeout(readers, deadline - Date.now(), wait.signal);
        taken = take(wait.ids);
      }
      return taken;
    },
    next: async (id, nextOptions = {}): Promise<SubagentReport | null> => {
      const report = await next(id, nextOptions.signal);
      return report;
    },
    unread: (): readonly SubagentReport[] => [...unread],
    onTask: (observer): Unsubscribe => {
      taskObservers.add(observer);
      return () => {
        taskObservers.delete(observer);
      };
    },
    tasks: (): readonly TaskView[] => [...tasks.values()],
    onReport: (handler): Unsubscribe => {
      reportHandlers.add(handler);
      return () => {
        reportHandlers.delete(handler);
      };
    },
    close: async (): Promise<void> => {
      closed = true;
      wake();
      await Promise.allSettled(inFlight);
      await Promise.all([...agents.values()].map(async (agent) => {
        await agent.close();
      }));
      wake();
    },
  };
}
