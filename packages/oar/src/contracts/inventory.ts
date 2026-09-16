import type { AvailableInstallation } from "./installation.js";

/** Independent native discovery in a working directory. */
export interface InventoryScope { readonly kind: "workspace"; readonly cwd: string }

export interface InventoryOptions {
  /** Defaults to process.cwd(); hosts should pass their project directory explicitly. */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}
export interface SkillEntry {
  readonly name: string;
  readonly description?: string;
  readonly path?: string;
  readonly source?: string;
  readonly enabled?: boolean;
  readonly disableModelInvocation?: boolean;
}
export interface McpServerEntry {
  readonly id: string;
  readonly name: string;
  /** Native state, not normalized into a guessed connected boolean. */
  readonly status?: string;
  readonly authStatus?: string;
  readonly enabled?: boolean;
  readonly source?: string;
  readonly toolCount?: number;
  readonly error?: string;
}
export interface ToolEntry {
  readonly name: string;
  readonly description?: string;
  readonly mcpServerId?: string;
  readonly source?: string;
  readonly enabled?: boolean;
  readonly active?: boolean;
  readonly loaded?: boolean;
  readonly inputSchema?: Readonly<Record<string, unknown>>;
}
export type InventoryResult<T> =
  | {
      readonly kind: "ok";
      readonly scope: InventoryScope;
      readonly observedAt: string;
      /** Which native view was read; mcp-only must never be displayed as all tools. */
      readonly view: "discovered" | "context" | "registered" | "mcp-only";
      readonly items: readonly T[];
      /** Native discovery errors / startup gaps, without credentials or raw configs. */
      readonly partial: boolean;
    }
  | {
      readonly kind: "unsupported";
      readonly code: "native_query_unavailable" | "transport_unavailable" | "scope_unavailable" | "installation_unsupported";
      readonly reason: string;
    }
  | {
      readonly kind: "unavailable";
      readonly code: "timeout" | "query_failed";
      readonly reason: string;
    };

export type InventoryReader<T> = (installation: AvailableInstallation, options?: InventoryOptions) => Promise<InventoryResult<T>>;
export interface RuntimeInventories {
  readonly skills: InventoryReader<SkillEntry>;
  readonly mcpServers: InventoryReader<McpServerEntry>;
  readonly tools: InventoryReader<ToolEntry>;
}
