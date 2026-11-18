/* oxlint-disable oxc/no-map-spread -- Project immutable native entries into credential-free records. */
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import type { CommandEntry, InventoryReader, InventoryResult, InventoryScope, McpServerEntry, SkillEntry, ToolEntry } from "../../contracts/inventory.js";
import { spawnLineProcess } from "../../shared/executable/index.js";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { inventoryOk, inventoryRead, named, nativeRows, skillScope, textField, unsupportedInventory, workspaceScope, type NativeInventoryRequest } from "../../shared/inventory.js";
import { claudeEnv } from "./environment.js";

const CLAUDE_SKILL_SOURCES = { "built-in": "builtin", userSettings: "user", projectSettings: "project", localSettings: "project", policySettings: "managed", plugin: "other", flagSettings: "other", memoryStore: "other", syncedSkills: "other" } as const;

export function projectClaudeSkills(payload: JsonRecord): SkillEntry[] {
  return nativeRows(asRecord(payload.skills)?.skillFrontmatter).map((skill) => ({
    name: named(skill), ...textField("source", skill.source),
    ...skillScope(skill.source, CLAUDE_SKILL_SOURCES),
    ...textField("plugin", skill.pluginName),
    ...textField("path", skill.path),
  }));
}

/**
 * The label Claude appends to a file-backed command's description in
 * `initialize.commands` (2.1.322: "Deploy it (project)", "User cmd (user)"),
 * by the scope it names. Only these two are verified.
 */
const CLAUDE_COMMAND_LABELS = { project: " (project)", user: " (user)" } as const;
/**
 * Sources whose skills were verified (2.1.322) to be listed as commands exactly
 * when a user can run them: a `user-invocable: false` skill at user and at
 * project scope was absent. Local settings were not observed.
 */
const INVOCABILITY_VERIFIED = new Set(["userSettings", "projectSettings"]);

function unlabeled(description: string, scope: SkillEntry["scope"]): string {
  const label = scope === "project" || scope === "user" ? CLAUDE_COMMAND_LABELS[scope] : undefined;
  return label !== undefined && description.endsWith(label) ? description.slice(0, -label.length) : description;
}

/** Well-formed command rows by name; a name listed twice is ambiguous and joins nothing. */
function commandsByName(value: unknown): Map<string, JsonRecord | null> | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const byName = new Map<string, JsonRecord | null>();
  for (const item of value) {
    const row = asRecord(item);
    if (row !== null && typeof row.name === "string") {
      byName.set(row.name, byName.has(row.name) ? null : row);
    }
  }
  return byName;
}

/**
 * Claude's skills as one catalog from one process: the skill list from
 * `get_context_usage` (name, source, path, plugin; it includes legacy
 * `.claude/commands` files, which Claude loads as skills) joined by name with
 * `initialize.commands` (description, and whether a person can run it).
 * A builtin command never describes a non-builtin skill of the same name.
 * `userInvocable: true` needs this skill's own command; a duplicate name or a
 * builtin of the same name leaves it unknown. `userInvocable: false` is claimed
 * only for sources where absence was verified to mean that (user, project).
 * A skill hidden from the model (`disable-model-invocation`) appears only as
 * a command; it is added when Claude's own description label names its scope,
 * with no `source` (the native string is not reported) and no model claim.
 * The result is partial when the context list says it left skills out.
 */
export function projectClaudeSkillCatalog(context: JsonRecord, initialized: JsonRecord): { readonly items: SkillEntry[]; readonly partial: boolean } {
  const skills = projectClaudeSkills(context);
  const counts = asRecord(context.skills);
  const omitted = typeof counts?.totalSkills === "number" && typeof counts.includedSkills === "number" && counts.includedSkills < counts.totalSkills;
  const commands = commandsByName(initialized.commands);
  if (commands === null) {
    return { items: skills, partial: omitted };
  }
  const known = new Set(skills.map((skill) => skill.name));
  const joined = skills.map((skill): SkillEntry => {
    const command = commands.get(skill.name);
    const usable = command !== undefined && command !== null && (command.builtin !== true || skill.scope === "builtin") ? command : undefined;
    const description = typeof usable?.description === "string" ? unlabeled(usable.description, skill.scope) : "";
    // Only this skill's own command makes it runnable. A duplicate name or a
    // builtin of the same name runs something else, so the answer is unknown.
    const unlisted = command === undefined && skill.source !== undefined && INVOCABILITY_VERIFIED.has(skill.source);
    const invocable = usable === undefined ? (unlisted ? { userInvocable: false } : {}) : { userInvocable: true };
    return { ...skill, ...(description === "" ? {} : { description }), ...invocable };
  });
  const hidden = [...commands].flatMap(([name, command]): SkillEntry[] => {
    const text = command?.description;
    if (command === null || command.builtin === true || typeof text !== "string" || known.has(name)) {
      return [];
    }
    const scope = text.endsWith(CLAUDE_COMMAND_LABELS.project) ? "project" : (text.endsWith(CLAUDE_COMMAND_LABELS.user) ? "user" : undefined);
    if (scope === undefined) {
      return [];
    }
    const description = unlabeled(text, scope);
    return [{ name, ...(description === "" ? {} : { description }), scope, userInvocable: true }];
  });
  return { items: [...joined, ...hidden], partial: omitted };
}
export function projectClaudeCommands(payload: JsonRecord): CommandEntry[] {
  return nativeRows(payload.commands).map((command) => {
    const aliases = command.aliases;
    if (aliases !== undefined && (!Array.isArray(aliases) || !aliases.every((alias: unknown) => typeof alias === "string"))) {
      throw new TypeError("Native command aliases are not strings");
    }
    return {
      name: named(command), ...textField("description", command.description),
      // claude gives "" for a command without a hint; absent reads the same as pi (#351).
      ...(command.argumentHint === "" ? {} : textField("argumentHint", command.argumentHint)),
      ...(command.builtin === true ? { source: "builtin" } : {}),
      ...(aliases === undefined ? {} : { aliases }),
    };
  });
}
export function projectClaudeServers(servers: readonly JsonRecord[]): McpServerEntry[] {
  return servers.map((server) => ({
    id: named(server), name: named(server),
    ...textField("status", server.status), ...textField("source", server.scope),
    ...(Array.isArray(server.tools) ? { toolCount: server.tools.length } : {}),
    ...((server.error === null || server.error === undefined) ? {} : { error: "Native MCP connection failed" }),
  }));
}
export function projectClaudeTools(servers: readonly JsonRecord[]): ToolEntry[] {
  return servers.flatMap((server) => server.tools === undefined ? [] : nativeRows(server.tools).map((tool) => ({
    name: named(tool), mcpServerId: named(server), source: "mcp",
    ...textField("description", tool.description),
  })));
}
class UnsupportedControlError extends Error {
  override name = "UnsupportedControlError";
}
function reader<T>(read: (request: NativeInventoryRequest, scope: InventoryScope, initialized: JsonRecord) => Promise<InventoryResult<T>> | InventoryResult<T>): InventoryReader<T> {
  return async (installation, options = {}) => {
    if (installation.via !== "executable") {
      return unsupportedInventory("installation_unsupported", "Claude inventory requires an executable");
    }
    const scope = workspaceScope(options);
    const child = spawnLineProcess(installation.command, [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--no-session-persistence",
    ], { cwd: scope.cwd, env: claudeEnv(options.env), killTree: true });
    let pending: { id: string; resolve(value: JsonRecord): void; reject(error: Error): void } | null = null;
    let closed = false;
    child.onLine((line) => {
      const message = asRecord(parseJson(line));
      const response = asRecord(message?.response);
      if (message?.type === "control_response" && response !== null && response.request_id === pending?.id && pending !== null) {
        const waiter = pending;
        pending = null;
        if (response.subtype === "success") {
          waiter.resolve(asRecord(response.response) ?? {});
        } else if (typeof response.error === "string" && /unsupported|not supported|unknown control/iu.test(response.error)) {
          waiter.reject(new UnsupportedControlError());
        } else {
          waiter.reject(new Error("Native control query failed"));
        }
      }
    });
    child.onExit(() => {
      closed = true;
      pending?.reject(new Error("Native process exited"));
      pending = null;
    });
    const request: NativeInventoryRequest = async (method, params) => {
      if (closed) {
        throw new Error("Native process exited");
      }
      const id = randomUUID();
      const { promise, resolve, reject } = Promise.withResolvers<JsonRecord>();
      pending = { id, resolve, reject };
      child.write(`${JSON.stringify({ type: "control_request", request_id: id, request: { subtype: method, ...params } })  }\n`);
      const result = await promise;
      return result;
    };
    try {
      return await inventoryRead(async () => {
        try {
          await child.spawned;
          const initialized = await request("initialize", {});
          return await read(request, scope, initialized);
        } catch (error) {
          if (error instanceof UnsupportedControlError) {
            return unsupportedInventory("native_query_unavailable", "This Claude build does not expose the inventory query");
          }
          throw error;
        }
      }, options.timeoutMs);
    } finally {
      child.kill();
      await child.exited;
    }
  };
}
async function readServers(request: NativeInventoryRequest): Promise<JsonRecord[]> {
  let payload = await request("mcp_status", {});
  let servers = nativeRows(payload.mcpServers);
  // Bounded startup wait; pending is returned as partial rather than hidden.
  for (let attempt = 0; attempt < 10 && servers.some((server) => server.status === "pending"); attempt += 1) {
    await delay(200);
    payload = await request("mcp_status", {});
    servers = nativeRows(payload.mcpServers);
  }
  return servers;
}
function partial(servers: readonly JsonRecord[]): boolean {
  return servers.some((server) => server.status === "pending" || server.status === "failed");
}
export const claudeSkills = reader(async (request, scope, initialized) => {
  const payload = await request("get_context_usage", { detail: "summary" });
  const catalog = projectClaudeSkillCatalog(payload, initialized);
  return inventoryOk(scope, "discovered", catalog.items, catalog.partial);
});
export const claudeCommands = reader((_request, scope, initialized) =>
  inventoryOk(scope, "discovered", projectClaudeCommands(initialized)));
export const claudeMcpServers = reader(async (request, scope) => {
  const servers = await readServers(request);
  return inventoryOk(scope, "discovered", projectClaudeServers(servers), partial(servers));
});
export const claudeTools = reader(async (request, scope) => {
  const servers = await readServers(request);
  return inventoryOk(scope, "mcp-only", projectClaudeTools(servers), partial(servers));
});
