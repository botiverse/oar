/**
 * What a runtime task is, read from the runtime's own task type: a shell
 * command (claude `local_bash`), a subagent (claude `local_agent` /
 * `remote_agent`, a codex subagent thread), a tool call the runtime moved off
 * the turn (claude `mcp_task`), or another kind it names in `nativeType`.
 */
export type TaskType = "shell" | "agent" | "tool" | "other";

/** A task's state as the runtime reports it; claude's `killed` reads as `stopped`. */
export type TaskStatus = "pending" | "running" | "paused" | "completed" | "failed" | "stopped";

export type TaskEventBody =
  /**
   * The runtime started a task: work it tracks beside the turn that started
   * it (claude `system/task_started`: a background or foreground command or
   * subagent, an MCP call moved to the background; codex `subAgentActivity`
   * started: a subagent thread). `toolCallId` is the call that started it.
   * A codex subagent is its own session (`childSessionId`); a claude
   * subagent's frames attribute through `agentPath` (the call's id). `ambient`
   * marks work the runtime does for its own operation, which activity views
   * should leave out.
   */
  | {
      readonly kind: "task_started";
      readonly taskId: string;
      readonly taskType: TaskType;
      /** The runtime's own word for the task type. */
      readonly nativeType?: string;
      readonly description?: string;
      readonly toolCallId?: string;
      readonly childSessionId?: string;
      /** True when the task runs without holding the call that started it. */
      readonly background?: boolean;
      readonly ambient?: boolean;
    }
  /** A change the runtime reported for a task (claude `task_updated`, codex `subAgentActivity` interacted). A patch: absent fields are unchanged. */
  | {
      readonly kind: "task_updated";
      readonly taskId: string;
      readonly status?: TaskStatus;
      readonly background?: boolean;
      readonly description?: string;
      readonly error?: string;
    }
  /**
   * The runtime's report that a task settled (claude `task_notification`,
   * codex `subAgentActivity` completed or interrupted). `outputFile` is where
   * the runtime wrote the task's output, `summary` its own one-line account.
   * A codex subagent can take more work afterwards; a later `task_updated`
   * says so.
   */
  | {
      readonly kind: "task_ended";
      readonly taskId: string;
      readonly status: "completed" | "failed" | "stopped";
      readonly summary?: string;
      readonly outputFile?: string;
    };
