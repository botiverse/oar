/* oxlint-disable import/max-dependencies -- Native startup composes existing session, model, credential and process helpers. */
import { existsSync, readFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import type { RpcSessionState, RpcResponse } from "@earendil-works/pi-coding-agent";
import type { RefusedSessionOptions, SessionOptions } from "../../../contracts/index.js";
import { sessionEnvironment } from "../../../shared/environment.js";
import { spawnLineProcess, type LineProcess } from "../../../shared/executable/index.js";
import { privateTempDir, type PrivateTempDir } from "../../../shared/private-temp.js";
import { checkSessionName, refuseSessionOptions } from "../../../shared/session-options.js";
import type { SessionCredentials } from "../../../shared/session-credentials.js";
import { piMcpServerConfig, validatePiMcpEnvironment } from "../mcp.js";
import { piThinkingLevel, piRefusedSessionOptions, piEffortRefusal } from "../open.js";
import { piFindSessionFile, piSessionDir, splitPiModelId } from "../resolve.js";
import { piRpcControl } from "./control.js";
import { piRpcLaunch } from "./launch.js";
import { piRpcExtensionSource } from "./extension.js";
import { RuntimeFailureError } from "../../../contracts/runtime-failure-error.js";

export const piRpcRefusedSessionOptions: RefusedSessionOptions = {
  ...piRefusedSessionOptions,
  launchArgs: "OAR owns Pi's RPC startup arguments; arbitrary CLI flags are not supported",
};

export function piRpcState(response: RpcResponse): RpcSessionState {
  if (!response.success) { throw new Error(response.error); }
  if (response.command !== "get_state") { throw new Error("Pi replied to a different command"); }
  return response.data;
}

interface OpenPiRpc {
  readonly child: LineProcess;
  readonly control: ReturnType<typeof piRpcControl>;
  readonly state: RpcSessionState;
  readonly directory: PrivateTempDir;
}

/** Native RPC startup, with the same bundled version as the in-process runtime. */
export async function openPiRpc(options: SessionOptions, credentials: SessionCredentials, receive: (message: Record<string, unknown>) => void, command?: string, args?: readonly string[]): Promise<OpenPiRpc> {
  refuseSessionOptions(piRpcRefusedSessionOptions, options);
  checkSessionName(options);
  // Removals are already applied to the RPC child's environment. Only the
  // in-process MCP path has to refuse them when re-inheriting the host env.
  validatePiMcpEnvironment({ ...options, env: {} });
  if (options.effort !== undefined) { piThinkingLevel(options.effort); }
  if (options.model !== undefined) { splitPiModelId(options.model); }
  const env = sessionEnvironment(options.env);
  const launch = await piRpcLaunch(command, options.cwd, env, args);
  const agentDir = path.resolve([env.OAR_PI_AGENT_DIR, env.PI_CODING_AGENT_DIR].find((value) => value !== undefined && value.length > 0)
    ?? path.join(env.HOME ?? env.USERPROFILE ?? homedir(), ".pi", "agent"));
  const sessionDir = piSessionDir(options.cwd, agentDir);
  const { SessionManager } = await import("@earendil-works/pi-coding-agent");
  const sessionFile = options.resume === undefined ? undefined : await piFindSessionFile(SessionManager, options.resume, options.cwd, sessionDir);
  const hasName = sessionFile !== undefined && SessionManager.open(sessionFile, sessionDir).getEntries().some((entry) => entry.type === "session_info");
  const directory = await privateTempDir("oar-pi-rpc-");
  try {
    await writeFile(path.join(directory.path, "config.json"), JSON.stringify({ agentDir, resume: options.resume !== undefined,
      servers: (options.mcpServers ?? []).map((server) => ({ name: server.name, config: piMcpServerConfig(server) })),
    }), { mode: 0o600 });
    // A bundled host need not ship its own source files or a node_modules tree.
    const extension = path.join(directory.path, "extension.mjs");
    await writeFile(extension, piRpcExtensionSource, { mode: 0o600 });
    const child = spawnLineProcess(launch.command, [
      ...launch.args,
      "--approve", "--no-mcp", "--session-dir", sessionDir, "-e", extension,
      ...(sessionFile === undefined ? [] : ["--session", sessionFile]),
      ...(options.model === undefined ? [] : ["--model", options.model]),
      ...(options.effort === undefined ? [] : ["--thinking", options.effort]),
      ...(options.name === undefined || hasName ? [] : ["--name", options.name]),
      ...(options.systemPrompt === undefined ? [] : ["--system-prompt", options.systemPrompt]),
      ...(options.appendSystemPrompt === undefined ? [] : ["--append-system-prompt", options.appendSystemPrompt]),
      ...((options.disallowedTools?.length ?? 0) === 0 ? [] : ["--exclude-tools", (options.disallowedTools ?? []).join(",")]),
    ], { cwd: options.cwd, env: { ...env, PI_CODING_AGENT_DIR: agentDir, OAR_PI_RPC_DIRECTORY: directory.path }, killTree: true, shutdown: "stdin", inheritStderr: false, extraPipe: true });
    const keyPipe = child.extraPipe;
    if (keyPipe === undefined) { child.kill(); await child.exited; throw new Error("Pi RPC requires a private credential pipe"); }
    keyPipe.on("error", () => { child.kill(); });
    const keys = createInterface({ input: keyPipe, crlfDelay: Infinity });
    keys.on("line", (line) => {
      try {
        const key: unknown = JSON.parse(line);
        if (typeof key !== "string") { throw new TypeError("Invalid Pi RPC credential message"); }
        credentials.add(key);
        // The child waits for this before returning from its native hook.
        // Separate stdout and fd 3 reads have no cross-stream ordering.
        keyPipe.write("ok\n");
      } catch { child.kill(); }
    });
    const control = piRpcControl(child, receive);
    try {
      await child.spawned;
      const response = await control.request({ type: "get_state" });
      const state = piRpcState(response);
      if (!existsSync(path.join(directory.path, "ready"))) { throw new Error(`Pi did not load the OAR RPC extension: ${child.diagnostics().stderr}`); }
      // oxlint-disable-next-line typescript/no-unsafe-assignment -- Written only by the bundled extension into this private directory.
      const ready: { modelRegistered: boolean; version: string } = JSON.parse(readFileSync(path.join(directory.path, "ready"), "utf8"));
      if (ready.version !== launch.version) { throw new Error(`Pi RPC session loaded ${ready.version}, expected ${launch.version}`); }
      if (options.model !== undefined && !ready.modelRegistered) {
        throw new RuntimeFailureError("model_unavailable", `pi model ${options.model} is not registered in the native model registry`);
      }
      if (options.resume !== undefined && state.sessionId !== options.resume) { throw new Error(`Pi resumed a different session: ${state.sessionId}`); }
      const effective = state.model === undefined ? null : `${state.model.provider}/${state.model.id}`;
      if (options.model !== undefined && options.model !== effective) { throw new Error(`pi did not apply model ${options.model}: the session reports ${effective ?? "no model"}`); }
      if (options.effort !== undefined && options.effort !== state.thinkingLevel) {
        const { getSupportedThinkingLevels } = await import("@earendil-works/pi-ai");
        throw new Error(piEffortRefusal(options.effort, { model: state.model, thinkingLevel: state.thinkingLevel,
          getAvailableThinkingLevels: () => state.model === undefined ? [] : getSupportedThinkingLevels(state.model),
        }) ?? "Pi did not apply the requested effort");
      }
      return { child, control, state, directory };
    } catch (error) {
      child.kill();
      await child.exited;
      throw credentials.redactValue(error);
    }
  } catch (error) { directory.remove(); throw error; }
}
