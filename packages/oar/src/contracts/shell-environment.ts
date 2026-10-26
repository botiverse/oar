import type { SessionOptions } from "./session-options.js";

export interface UserShellEnvironmentOptions {
  /** Bounds shell startup and output collection; default 10 seconds. */
  readonly timeoutMs?: number;
  readonly signal?: AbortSignal;
}

export interface UserShellEnvironment {
  /** Complete shell snapshot, with null for inherited variables the shell removed. Contains secrets: never log or record it. */
  readonly env: NonNullable<SessionOptions["env"]>;
  /** Changed HOME, PATH, runtime credential directories and proxy variable names only, never their values. */
  readonly changedVariables: readonly string[];
}

export type UserShellEnvironmentFailure =
  | "no_node_runtime"
  | "unsupported_platform"
  | "shell_not_set"
  | "shell_unavailable"
  | "shell_failed"
  | "timed_out"
  | "cancelled"
  | "invalid_output"
  | "output_too_large";

const reasons: Readonly<Record<UserShellEnvironmentFailure, string>> = {
  no_node_runtime: "The host executable cannot safely evaluate the environment capture script. Supply an environment map directly from the host instead.",
  unsupported_platform: "Reading a user login shell environment is unsupported on Windows.",
  shell_not_set: "SHELL does not name a user login shell.",
  shell_unavailable: "The user login shell could not be executed.",
  shell_failed: "The user login shell exited unsuccessfully.",
  timed_out: "The user login shell did not finish within the deadline; its startup configuration may wait for interaction.",
  cancelled: "Reading the user login shell environment was cancelled.",
  invalid_output: "The user login shell did not return one complete environment snapshot.",
  output_too_large: "The user login shell exceeded the output limit.",
};

/** No shell output, environment values, native errors or causes are attached. */
export class UserShellEnvironmentError extends Error {
  override readonly name = "UserShellEnvironmentError";
  constructor(readonly reason: UserShellEnvironmentFailure) { super(reasons[reason]); }
}
