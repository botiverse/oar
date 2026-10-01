import type { RuntimeEventBody, TaskStatus, TaskType } from "../contracts/session.js";

export interface ScriptedTaskSpec {
  readonly taskType: TaskType;
  readonly description?: string;
  /** Whether the task runs without holding the turn's call that started it. */
  readonly background?: boolean;
}

/** A task a script started: report its changes and its end, during or after the turn. */
export interface ScriptedTask {
  readonly taskId: string;
  update(patch: { readonly status?: TaskStatus; readonly description?: string }): void;
  end(status?: "completed" | "failed" | "stopped", detail?: { readonly summary?: string; readonly outputFile?: string }): void;
}

type Emit = (type: string, native: unknown, events: readonly RuntimeEventBody[]) => void;

/**
 * Task reports for the scripted runtime, numbered per session. A task may
 * end after the turn that started it, as claude reports a background task's
 * end whenever it comes; nothing is recorded once `recording()` says no
 * (the session was disposed), and a task reports one end.
 */
export function scriptedTasks(emit: Emit, recording: () => boolean): (spec: ScriptedTaskSpec, live: boolean) => ScriptedTask {
  let count = 0;
  return (spec, live) => {
    count += 1;
    const taskId = `task-${String(count)}`;
    let open = live;
    if (open) {
      const started: RuntimeEventBody = {
        kind: "task_started",
        taskId,
        taskType: spec.taskType,
        ...(spec.description === undefined ? {} : { description: spec.description }),
        ...(spec.background === undefined ? {} : { background: spec.background }),
      };
      emit("scripted/task_started", { taskId, ...spec }, [started]);
    }
    return {
      taskId,
      update: (patch) => {
        if (open && recording()) {
          emit("scripted/task_updated", { taskId, ...patch }, [{ kind: "task_updated", taskId, ...patch }]);
        }
      },
      end: (status = "completed", detail = {}) => {
        if (open && recording()) {
          open = false;
          emit("scripted/task_ended", { taskId, status, ...detail }, [{ kind: "task_ended", taskId, status, ...detail }]);
        }
      },
    };
  };
}
