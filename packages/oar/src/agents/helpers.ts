import { mkdirSync } from "node:fs";
import path from "node:path";
import type { AvailableInstallation } from "../contracts/installation.js";
import type { Runtime } from "../contracts/runtime.js";
import type { Session, SessionOptions } from "../contracts/session.js";
import { openVoyage } from "../voyage.js";
import type { SubagentReport } from "./types.js";

export const SUBAGENT_DEPTH_ENV = "OAR_SUBAGENT_DEPTH";
export const DEFAULT_WAIT_MS = 30_000;

export function hostDepth(): number {
  const depth = Number(process.env[SUBAGENT_DEPTH_ENV] ?? "0");
  return Number.isInteger(depth) && depth >= 0 ? depth : 0;
}

export function formatReport(report: SubagentReport): string {
  const outcome = report.outcome.kind === "failed" ? `failed: ${report.outcome.reason}` : report.outcome.kind;
  const who = report.name === undefined || report.name === report.id ? report.id : `${report.id} (${report.name})`;
  return `[subagent ${who} on ${report.runtime}, turn ${String(report.turn)}: ${outcome}; session ${report.sessionId}]\n${report.text}`;
}

export async function sessionOf(runtime: Runtime, installation: AvailableInstallation, options: SessionOptions): Promise<Session | string> {
  try {
    const session = await runtime.session(installation, options);
    return session;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

export async function installationOf(runtime: Runtime): Promise<AvailableInstallation | string> {
  if (runtime.installation === undefined) {
    return `${runtime.id} exposes no installation probe`;
  }
  const installation = await runtime.installation();
  return installation.kind === "available" ? installation : `${runtime.id} is ${installation.kind === "not_found" ? "not installed" : `unsupported: ${installation.reason}`}`;
}

/** Resolves on the first reader call, after `ms`, or when `signal` aborts. */
export async function readerOrTimeout(readers: Set<() => void>, ms: number, signal?: AbortSignal): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  const done = (): void => {
    clearTimeout(timer);
    readers.delete(done);
    signal?.removeEventListener("abort", done);
    resolve();
  };
  const timer = setTimeout(done, ms);
  readers.add(done);
  signal?.addEventListener("abort", done);
  await promise;
}

/** A log file name from an id a model may have chosen (`frontend/api`, `../x`). */
export function logName(id: string, sessionId: string): string {
  return `${`${id}-${sessionId}`.replaceAll(/[^\w.-]/gu, "_")}.jsonl`;
}

export function attachLog(session: Session, file: string, header: Parameters<typeof openVoyage>[1]): string | null {
  try {
    mkdirSync(path.dirname(file), { recursive: true });
    const recorder = openVoyage(file, header);
    session.rawEvents((record) => {
      recorder.record(record);
      if (record.kind === "response" && record.body.kind === "exited") {
        recorder.end("exited");
      }
    }, { sessionId: session.id, afterSeq: -1 });
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

