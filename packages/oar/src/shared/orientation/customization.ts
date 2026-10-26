import type { SessionOptions } from "../../contracts/session-options.js";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { InventoryResult } from "../../contracts/inventory.js";
import type { Customization, Probe } from "../../contracts/orientation.js";
import type { Runtime } from "../../contracts/runtime.js";
import { observedNow, type ProbeBudget } from "./budget.js";
import type { ProbeSlots } from "./slots.js";

interface Sourced { readonly source?: string }
const categories = ["skills", "commands", "mcpServers", "tools"] as const;
type Category = typeof categories[number];

function count(result: InventoryResult<Sourced>): number | undefined {
  if (result.kind !== "ok" || result.view === "mcp-only" || result.view === "context") { return undefined; }
  // Source is the native label, not an OAR guess from a file path or runtime id.
  if (result.items.some((item) => item.source === undefined || !["user", "builtin", "project", "local"].includes(item.source))) { return undefined; }
  return result.items.filter((item) => item.source === "user").length;
}

function summarize(results: readonly (readonly [Category, Probe<InventoryResult<Sourced>>])[]): Probe<Customization> {
  if (results.some(([, result]) => result.kind === "timed_out")) { return { kind: "timed_out", observedAt: observedNow() }; }
  if (results.some(([, result]) => result.kind === "failed" || (result.kind === "ok" && (result.value.kind === "unavailable" || (result.value.kind === "ok" && result.value.partial))))) {
    return { kind: "failed", reason: "A native inventory failed or was incomplete", observedAt: observedNow() };
  }
  const value: Partial<Record<Category, number>> = {};
  for (const [category, result] of results) {
    const total = result.kind === "ok" ? count(result.value) : undefined;
    if (total !== undefined) { value[category] = total; }
  }
  return Object.keys(value).length === 0 ? { kind: "unsupported" } : { kind: "ok", value, observedAt: observedNow() };
}

/** Native readers own their child processes; the directory lives until they settle, including after a timeout. */
export async function readCustomization(runtime: Runtime, installation: AvailableInstallation, budget: ProbeBudget, slots: ProbeSlots, env: SessionOptions["env"]): Promise<Probe<Customization>> {
  const result = await budget.run(async () => {
    const temporary = await mkdtemp(join(tmpdir(), "oar-orient-"));
    const pending: Promise<unknown>[] = [];
    try {
      const cwd = await realpath(temporary);
      const results = await Promise.all(categories.map(async (category): Promise<readonly [Category, Probe<InventoryResult<Sourced>>]> => {
        const probe = await budget.run(async (timeoutMs) => {
          const read = runtime[category](installation, { cwd, timeoutMs, ...(env === undefined ? {} : { env }) });
          pending.push(read);
          const value = await read;
          return value;
        }, slots);
        return [category, probe];
      }));
      return summarize(results);
    } finally { await Promise.allSettled(pending); await rm(temporary, { force: true, recursive: true }); }
  });
  return result.kind === "ok" ? result.value : result;
}
