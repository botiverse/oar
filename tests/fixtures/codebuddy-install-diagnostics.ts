// oxlint-disable import/prefer-default-export -- Keep the fixture helper's named import explicit at both call sites.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { redactTokenShapes } from "../../packages/oar/src/shared/token-redaction.js";

const MAX_LOG_BYTES = 1024 * 1024;

function redact(text: string): string {
  return redactTokenShapes(text).replaceAll(/\bnpm_[A-Za-z0-9]{16,}\b/gu, "[redacted]")
    .replaceAll(/\b(?<protocol>[\w+.-]+:\/\/)[^/\s@]+@/gu, "$<protocol>[redacted]@");
}

async function logTail(file: string, sourceBytes: number): Promise<string> {
  const handle = await open(file, "r");
  try {
    const size = Math.min(sourceBytes, MAX_LOG_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, Math.max(0, sourceBytes - size));
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally { await handle.close(); }
}

/** Only the isolated install's npm logs and explicit phase facts, never HOME or npmrc. */
export function installDiagnostics(directory: string) {
  function write(name: string, text: string, append = false): boolean {
    try {
      mkdirSync(directory, { recursive: true });
      const file = path.join(directory, name);
      if (append) { appendFileSync(file, redact(text)); }
      else { writeFileSync(file, redact(text)); }
      return true;
    } catch (error) {
      // Evidence collection must not replace the original installer failure.
      process.stderr.write(`${JSON.stringify({ kind: "codebuddy_install_diagnostic_failed", file: name, code: asRecord(error)?.code ?? null })}\n`);
      return false;
    }
  }
  function record(phase: string, details: object = {}): void {
    write("phases.jsonl", `${JSON.stringify({ phase, at: new Date().toISOString(), pid: process.pid, ...details })}\n`, true);
  }
  async function captureFile(source: string, name: string): Promise<void> {
    try {
      const file = path.join(source, name);
      const info = await lstat(file);
      if (!info.isFile()) { record("npm_log_skipped", { file: name }); return; }
      const tail = await logTail(file, info.size);
      if (write(name, tail)) {
        record("npm_log_saved", { file: name, sourceBytes: info.size, savedBytes: Buffer.byteLength(tail), truncated: info.size > MAX_LOG_BYTES });
      }
    } catch (error) { record("npm_log_capture_failed", { file: name, code: asRecord(error)?.code ?? null }); }
  }
  async function capture(home: string): Promise<void> {
    const source = path.join(home, "npm-cache", "_logs");
    try {
      const entries = await readdir(source);
      const names = entries.filter((name) => /-(?:debug-\d+\.log|timing\.json)$/u.test(name)).toSorted().slice(-10);
      record("npm_logs", { files: names });
      await Promise.all(names.map(async name => { await captureFile(source, name); }));
    } catch (error) { record("npm_logs_unavailable", { code: asRecord(error)?.code ?? null }); }
  }
  return { record, capture, write };
}
