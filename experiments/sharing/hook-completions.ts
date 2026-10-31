/** Preserve native execution failures separately from absent hook journal entries. */
import { asRecord, type JsonRecord } from "../../packages/oar/src/shared/json.js";

export function nativeHookCompletions(native: unknown): JsonRecord[] {
  const events = asRecord(native)?.events;
  if (!Array.isArray(events)) { return []; }
  return events.flatMap((event: unknown): JsonRecord[] => {
    const row = asRecord(event);
    if (row?.method !== "hook/completed") { return []; }
    const run = asRecord(asRecord(row.params)?.run); if (run === null) { return []; }
    const entries = Array.isArray(run.entries) ? run.entries.map(asRecord).filter((entry) => entry !== null)
      .map((entry) => ({ kind: entry.kind, text: entry.text })) : [];
    const exitMessage = entries.map((entry) => entry.text).find((text): text is string => typeof text === "string" && /^hook exited with code -?\d+$/u.test(text));
    let exitCode: number | null = null; let exitCodeSource: string | null = null;
    if (typeof run.exitCode === "number") { ({ exitCode } = run); exitCodeSource = "native field"; }
    else if (exitMessage !== undefined) { exitCode = Number(exitMessage.slice("hook exited with code ".length)); exitCodeSource = "native completion message"; }
    return [{ eventName: run.eventName, handlerType: run.handlerType, status: run.status,
      durationMs: run.durationMs, statusMessage: run.statusMessage, entries, exitCode,
      exitCodeSource }];
  });
}

export function hookExecutionFailures(row: JsonRecord, label: string): string[] {
  const completions = Array.isArray(row.nativeHookCompletions) ? row.nativeHookCompletions.map(asRecord) : [];
  return [...new Set(completions.filter((run) => run?.status === "failed" || (typeof run?.exitCode === "number" && run.exitCode !== 0))
    .map((run) => `${label}: hook command execution failed (${typeof run?.exitCode === "number" ? `exit ${run.exitCode}` : `native status ${String(run?.status)}`})`))];
}

/** Shell names explicitly reported in native environment context, without paths. */
export function nativeContextShells(native: unknown): string[] {
  const normalized = JSON.stringify(asRecord(native)?.normalized ?? []);
  return [...new Set([...normalized.matchAll(/<environment_context>[\s\S]*?<shell>(?<shell>[^<]{1,80})<\/shell>/gu)]
    .flatMap((match) => match.groups?.shell === undefined ? [] : [match.groups.shell]))];
}
