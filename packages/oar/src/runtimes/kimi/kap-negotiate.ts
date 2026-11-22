import type { SessionOptions } from "../../contracts/session.js";
import { resolvedAdditionalDirectories } from "../../shared/additional-directories.js";
import type { LineProcess } from "../../shared/executable/index.js";
import type { JsonRecord } from "../../shared/json.js";
import { sameDirectory } from "../../shared/same-directory.js";
import {
  assertExistingSessionAvailable,
  ignoreRejection,
  mapCreateKapError,
  mapGetResumeKapError,
  mapResumeKapError,
  throwResumeCwdMismatch,
  type KapEndpoint,
} from "./kap-errors.js";
import { kapRequest, toKapMcpServers } from "./kap-protocol.js";
import type { KapSocket } from "./kap-socket.js";
import { stopKimiWeb } from "./web-shutdown.js";

export async function cleanupKapResources(
  child: LineProcess,
  endpoint: KapEndpoint,
  socket: KapSocket | null,
  createdWorkspaceId: string | null,
): Promise<void> {
  if (socket !== null) {
    await socket.close();
  }
  if (createdWorkspaceId !== null) {
    await ignoreRejection(
      kapRequest(endpoint.origin, endpoint.token, `/workspaces/${encodeURIComponent(createdWorkspaceId)}`, {
        method: "DELETE",
        timeoutMs: 3000,
      }),
    );
  }
  await stopKimiWeb(child, endpoint);
}

export async function createKapSessionRecord(
  endpoint: KapEndpoint,
  cwd: string,
  options: SessionOptions,
  agentConfig: JsonRecord,
  onWorkspaceCreated: (workspaceId: string) => void,
): Promise<JsonRecord> {
  const mcpServers = options.mcpServers === undefined ? undefined : toKapMcpServers(options.mcpServers);
  const additionalDirs = resolvedAdditionalDirectories(options);
  let workspaceId: string | null = null;
  if (additionalDirs.length > 0) {
    const ws = await kapRequest(endpoint.origin, endpoint.token, "/workspaces", {
      method: "POST",
      body: { root: cwd, additional_dirs: [...additionalDirs] },
      timeoutMs: 15_000,
    });
    if (typeof ws.id === "string" && ws.id.length > 0) {
      workspaceId = ws.id;
      onWorkspaceCreated(ws.id);
    }
  }
  try {
    return await kapRequest(endpoint.origin, endpoint.token, "/sessions", {
      method: "POST",
      body: {
        ...(workspaceId === null ? { cwd } : { workspace_id: workspaceId }),
        agent_config: agentConfig,
        ...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
        ...(options.appendSystemPrompt === undefined ? {} : { append_system_prompt: options.appendSystemPrompt }),
      },
      timeoutMs: 30_000,
    });
  } catch (error) {
    return mapCreateKapError(error, options);
  }
}

async function fetchExistingSession(endpoint: KapEndpoint, resumeId: string): Promise<JsonRecord> {
  try {
    return await kapRequest(endpoint.origin, endpoint.token, `/sessions/${encodeURIComponent(resumeId)}`, {
      method: "GET",
      timeoutMs: 15_000,
    });
  } catch (error) {
    return mapGetResumeKapError(error, resumeId);
  }
}

export async function resumeKapSessionRecord(
  endpoint: KapEndpoint,
  cwd: string,
  resumeId: string,
  options: SessionOptions,
  agentConfig: JsonRecord,
): Promise<JsonRecord> {
  const existing = await fetchExistingSession(endpoint, resumeId);
  assertExistingSessionAvailable(existing, resumeId);
  const savedCwd = typeof existing.cwd === "string" ? existing.cwd : undefined;
  if (savedCwd !== undefined && !sameDirectory(savedCwd, cwd)) {
    throwResumeCwdMismatch(resumeId, savedCwd, cwd);
  }
  const mcpServers = options.mcpServers === undefined ? undefined : toKapMcpServers(options.mcpServers);
  try {
    return await kapRequest(endpoint.origin, endpoint.token, `/sessions/${encodeURIComponent(resumeId)}:resume`, {
      method: "POST",
      body: {
        agent_config: agentConfig,
        ...(mcpServers === undefined ? {} : { mcp_servers: mcpServers }),
        ...(options.appendSystemPrompt === undefined ? {} : { append_system_prompt: options.appendSystemPrompt }),
      },
      timeoutMs: 30_000,
    });
  } catch (error) {
    return mapResumeKapError(error, resumeId, options);
  }
}
