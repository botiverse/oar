import type { SessionOptions } from "../../contracts/session.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import { sessionEnvironment } from "../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../shared/executable/index.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { checkQwenLaunchArgs, qwenRefusedSessionOptions } from "./options.js";

/** Qwen 0.26.0's own SDK channel; credentials and MCP configuration never enter argv. */
export async function launchQwen(command: string, sessionId: string, options: SessionOptions): Promise<LineProcess> {
  refuseSessionOptions(qwenRefusedSessionOptions, options);
  checkQwenLaunchArgs(options.launchArgs);
  const directories = resolvedAdditionalDirectories(options);
  const child = spawnLineProcess(command, [
    "--input-format", "stream-json", "--output-format", "stream-json", "--channel=SDK",
    "--include-partial-messages", "--approval-mode", "yolo",
    ...(options.resume === undefined ? ["--session-id", sessionId] : ["--resume", sessionId]),
    ...(options.model === undefined ? [] : ["--model", options.model]),
    ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
    ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
    ...options.launchArgs ?? [],
    ...(directories.length === 0 ? [] : ["--include-directories", ...directories]),
    ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--exclude-tools", ...options.disallowedTools ?? []]),
  ], { cwd: options.cwd, env: sessionEnvironment(options.env), killTree: true });
  await child.spawned;
  return child;
}
