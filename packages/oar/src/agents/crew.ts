import path from "node:path";
import type { AvailableInstallation } from "../contracts/installation.js";
import type { Runtime } from "../contracts/runtime.js";
import type { Session, SessionOptions, TaskEventBody, Unsubscribe } from "../contracts/session.js";
import { applyTaskEvent, initialTasks, type TaskMap, type TaskView } from "../observe/tasks.js";
import { runtimes as builtInRuntimes } from "../index.js";
import { openVoyage } from "../voyage.js";
import { createSubagent } from "./subagent.js";
import type {
  DeliverOptions,
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

export const SUBAGENT_DEPTH_ENV = "OAR_SUBAGENT_DEPTH";
const DEFAULT_WAIT_MS = 30_000;

function hostDepth(): number {
  const depth = Number(process.env[SUBAGENT_DEPTH_ENV] ?? "0");
  return Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

export function formatReport(report: SubagentReport): string {
  const outcome = report.outcome.kind === "failed" ? `failed: ${report.outcome.reason}` : report.outcome.kind;
  const who = report.name === undefined || report.name === report.id ? report.id : `${report.id} (${report.name})`;
  return `[subagent ${who} on ${report.runtime}, turn ${String(report.turn)}: ${outcome}; session ${report.sessionId}]\n${report.text}`;
}

async function sessionOf(runtime: Runtime, installation: AvailableInstallation, options: SessionOptions): Promise<Session | string> {
  try {
    return await runtime.session(installation, options);
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/** Resolves on the first reader call or after `ms`, whichever comes first. */
async function readerOrTimeout(readers: (() => void)[], ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    readers.push(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function installationOf(runtime: Runtime): Promise<AvailableInstallation | string> {
  if (runtime.installation === undefined) {
    return `${runtime.id} exposes no installation probe`;
  }
  const installation = await runtime.installation();
  return installation.kind === "available" ? installation : `${runtime.id} is ${installation.kind === "not_found" ? "not installed" : `unsupported: ${installation.reason}`}`;
}

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
  let unread: SubagentReport[] = [];
  let tasks: TaskMap = initialTasks;
  const taskObservers = new Set<(event: SubagentTaskEvent) => void>();
  const reportObservers = new Set<(report: SubagentReport) => void>();
  let readers: (() => void)[] = [];
  let starting = 0;

  const running = (): number => starting + [...agents.values()].filter((agent) => agent.info().state === "running").length;

  const emitTask = (body: TaskEventBody, sessionId: string): void => {
    const at = Date.now();
    tasks = applyTaskEvent(tasks, body, { sessionId, agentPath: [], receivedAt: at });
    for (const observer of taskObservers) {
      observer({ ...body, at });
    }
  };

  const received = (report: SubagentReport): void => {
    if (reportObservers.size > 0) {
      for (const observer of reportObservers) {
        observer(report);
      }
      return;
    }
    unread.push(report);
    const pending = readers;
    readers = [];
    for (const reader of pending) {
      reader();
    }
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

  const open = async (spawn: SpawnOptions, runtime: Runtime, installation: AvailableInstallation): Promise<SpawnResult> => {
    const id = freeId(spawn);
    const log = options.logDir === undefined ? undefined : path.join(options.logDir, `${id}.jsonl`);
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
    if (log !== undefined) {
      const recorder = openVoyage(log, { runtime: runtime.id, cwd, sessionId: session.id, startedAt: Date.now(), recorder: "oar-subagents",
        ...(spawn.model === undefined ? {} : { model: spawn.model }), ...(spawn.effort === undefined ? {} : { effort: spawn.effort }) });
      session.rawEvents((record) => {
        recorder.record(record);
        if (record.kind === "response" && record.body.kind === "exited") {
          recorder.end("exited");
        }
      });
    }
    const agent = createSubagent({ id, runtime: runtime.id, ...(spawn.name === undefined ? {} : { name: spawn.name }), ...(log === undefined ? {} : { log }) }, session, {
      report: received,
      task: (body) => {
        emitTask(body, session.id);
      },
      mayRun: () => running() < maxRunning,
      closed: () => {},
    });
    agents.set(id, agent);
    emitTask({ kind: "task_started", taskId: id, taskType: "agent", nativeType: "oar-subagent", description: spawn.name ?? spawn.task.split("\n")[0]?.slice(0, 120) ?? "", childSessionId: session.id, background: true }, session.id);
    const outcome = await session.prompt(spawn.task);
    if (outcome.kind === "rejected") {
      await agent.close();
      agents.delete(id);
      return { kind: "refused", code: "rejected", reason: outcome.reason };
    }
    return { kind: "spawned", agent };
  };

  const take = (ids?: readonly string[]): SubagentReport[] => {
    const taken = unread.filter((report) => ids === undefined || ids.includes(report.id));
    unread = unread.filter((report) => !taken.includes(report));
    return taken;
  };

  return {
    spawn: async (spawn: SpawnOptions): Promise<SpawnResult> => {
      const runtime = registry.get(spawn.runtime);
      if (runtime === undefined) {
        return { kind: "refused", code: "unknown_runtime", reason: `unknown runtime: ${spawn.runtime}` };
      }
      if (hostDepth() + 1 > maxDepth) {
        return { kind: "refused", code: "depth_limit", reason: `subagents nest at most ${String(maxDepth)} deep; do this task yourself` };
      }
      if (running() >= maxRunning) {
        return { kind: "refused", code: "running_limit", reason: `${String(maxRunning)} subagents are already running; wait for one to finish rather than retrying` };
      }
      starting += 1;
      try {
        const installation = await installationOf(runtime);
        return typeof installation === "string"
          ? { kind: "refused", code: "not_installed", reason: installation }
          : await open(spawn, runtime, installation);
      } finally {
        starting -= 1;
      }
    },
    get: (id: string): Subagent | undefined => agents.get(id),
    list: (): readonly SubagentInfo[] => [...agents.values()].map((agent) => agent.info()),
    wait: async (wait: WaitOptions = {}): Promise<readonly SubagentReport[]> => {
      const timeoutMs = wait.timeoutMs ?? DEFAULT_WAIT_MS;
      const deadline = Date.now() + timeoutMs;
      let taken = take(wait.ids);
      while (taken.length === 0 && Date.now() < deadline) {
        await readerOrTimeout(readers, deadline - Date.now());
        taken = take(wait.ids);
      }
      return taken;
    },
    unread: (): readonly SubagentReport[] => [...unread],
    onTask: (observer): Unsubscribe => {
      taskObservers.add(observer);
      return () => {
        taskObservers.delete(observer);
      };
    },
    tasks: (): readonly TaskView[] => [...tasks.values()],
    deliverTo: (parent: Session, deliver: DeliverOptions = {}): Unsubscribe => {
      const format = deliver.format ?? formatReport;
      const send = (report: SubagentReport): void => {
        const input = format(report);
        // An idle parent gets a turn of its own (it wakes); a busy one gets the input mid-turn or after it.
        void (parent.status().value.kind === "idle" ? parent.prompt(input) : parent.steerOrQueue(input));
      };
      for (const report of take()) {
        send(report);
      }
      reportObservers.add(send);
      return () => {
        reportObservers.delete(send);
      };
    },
    close: async (): Promise<void> => {
      await Promise.all([...agents.values()].map(async (agent) => {
        await agent.close();
      }));
    },
  };
}
