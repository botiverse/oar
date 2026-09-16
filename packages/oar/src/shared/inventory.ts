import { resolve as resolvePath } from "node:path";
import type { InventoryOptions, InventoryResult, InventoryScope } from "../contracts/inventory.js";
import { asRecord, type JsonRecord } from "./json.js";

export type NativeInventoryRequest = (method: string, params: JsonRecord) => Promise<JsonRecord>;
export function workspaceScope(options: InventoryOptions = {}): InventoryScope & { readonly cwd: string } {
  return { kind: "workspace", cwd: resolvePath(options.cwd ?? process.cwd()) };
}
export function inventoryOk<T>(scope: InventoryScope, view: Extract<InventoryResult<T>, { kind: "ok" }>["view"], items: readonly T[], partial = false): InventoryResult<T> {
  return { kind: "ok", scope, observedAt: new Date().toISOString(), view, items, partial };
}
export function unsupportedInventory(code: Extract<InventoryResult<never>, { kind: "unsupported" }>["code"], reason: string): InventoryResult<never> {
  return { kind: "unsupported", code, reason };
}
export function unavailableInventory(code: Extract<InventoryResult<never>, { kind: "unavailable" }>["code"], reason: string): InventoryResult<never> {
  return { kind: "unavailable", code, reason };
}
export function nativeRows(value: unknown): JsonRecord[] {
  if (!Array.isArray(value)) {
    throw new TypeError("Native inventory response has no list");
  }
  return value.map((item: unknown) => {
    const row = asRecord(item);
    if (row === null) {
      throw new TypeError("Native inventory entry is not an object");
    }
    return row;
  });
}
export function named(row: JsonRecord): string {
  if (typeof row.name !== "string") {
    throw new TypeError("Native inventory entry has no name");
  }
  return row.name;
}
export function textField(key: string, value: unknown): Record<string, string> {
  return typeof value === "string" ? { [key]: value } : {};
}
export function boolField(key: string, value: unknown): Record<string, boolean> {
  return typeof value === "boolean" ? { [key]: value } : {};
}
/** Bound a read with a deadline; subprocess callers dispose their owned process in finally. */
export async function inventoryRead<T>(read: () => Promise<InventoryResult<T>>, timeoutMs = 15_000): Promise<InventoryResult<T>> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive and finite");
  }
  let timer: ReturnType<typeof setTimeout> | undefined = undefined;
  const deadline = new Promise<InventoryResult<T>>((resolve) => {
    timer = setTimeout(() => { resolve(unavailableInventory("timeout", "Native inventory query timed out")); }, timeoutMs);
  });
  try {
    return await Promise.race([read(), deadline]);
  } catch {
    // Raw native errors can contain command arguments, headers or credentials.
    return unavailableInventory("query_failed", "Native inventory query failed");
  } finally {
    clearTimeout(timer);
  }
}
