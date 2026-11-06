// Node 24 preloads this only for the explicit bootstrap experiment.
// Default builtin imports share the objects used by the vendor's require().
import childProcess from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

const file = process.env.OAR_GROK_BOOTSTRAP_TRACE;
const home = process.env.GROK_HOME;
const { appendFileSync } = fs;
const started = performance.now();
let bytes = 0;
let stopped = false;

function record(phase: string, details: Readonly<Record<string, unknown>> = {}): void {
  if (stopped || file === undefined) { return; }
  try {
    let line = `${JSON.stringify({ at: Date.now(), sinceHookMs: performance.now() - started, phase, ...details })}\n`;
    if (bytes + Buffer.byteLength(line) > 64 * 1024 - 256) {
      line = `${JSON.stringify({ at: Date.now(), phase: "trace_truncated", bytes })}\n`;
      stopped = true;
    }
    appendFileSync(file, line);
    bytes += Buffer.byteLength(line);
  } catch {
    stopped = true;
    process.stderr.write("[grok startup probe] bootstrap trace write failed\n");
  }
}

function kind(value: unknown): string | null {
  if (typeof value !== "string" || home === undefined) { return null; }
  const name = path.basename(value);
  if (name === "grok.br" || name === "grok.exe.br") { return "compressed_binary"; }
  const inside = path.dirname(path.resolve(value)) === path.resolve(home, "bin");
  if (inside && name.startsWith("grok")) {
    if (name.includes(".tmp.")) { return "temporary_binary"; }
    if (name.includes(".link.")) { return "temporary_link"; }
    if (name.endsWith(".old")) { return "backup_binary"; }
    if (name.startsWith("grok-")) { return "versioned_binary"; }
    return "canonical_binary";
  }
  return name === "grok" || name === "grok.exe" ? "package_binary" : null;
}

function unary(args: readonly unknown[]): Record<string, unknown> | null {
  const target = kind(args[0]);
  return target === null ? null : { target };
}

function binary(args: readonly unknown[]): Record<string, unknown> | null {
  const source = kind(args[0]);
  const target = kind(args[1]);
  return source === null && target === null ? null : { source, target };
}

function timed<T extends (...args: never[]) => unknown>(
  original: T, phase: string, select: (args: readonly unknown[]) => Readonly<Record<string, unknown>> | null,
): T {
  return new Proxy(original, {
    apply(target, receiver: unknown, args: unknown[]): unknown {
      const details = select(args);
      if (details === null) { return Reflect.apply(target, receiver, args); }
      record(`${phase}_started`, details);
      const start = performance.now();
      try {
        const value: unknown = Reflect.apply(target, receiver, args);
        record(`${phase}_finished`, {
          ...details, durationMs: performance.now() - start,
          ...(Buffer.isBuffer(value) ? { resultBytes: value.length } : {}),
        });
        return value;
      } catch (error) {
        const code = typeof error === "object" && error !== null && "code" in error ? error.code : null;
        record(`${phase}_failed`, { ...details, durationMs: performance.now() - start, code: typeof code === "string" ? code : null });
        throw error;
      }
    },
  });
}

if (file !== undefined && file.length > 0 && home !== undefined && home.length > 0) {
  record("hook_loaded", { node: process.version, platform: process.platform });
  fs.readFileSync = timed(fs.readFileSync, "read", unary);
  zlib.brotliDecompressSync = timed(zlib.brotliDecompressSync, "decompress", args => ({
    inputBytes: ArrayBuffer.isView(args[0]) ? args[0].byteLength : null,
  }));
  fs.writeFileSync = timed(fs.writeFileSync, "write", unary);
  fs.copyFileSync = timed(fs.copyFileSync, "copy", binary);
  fs.renameSync = timed(fs.renameSync, "rename", binary);
  fs.symlinkSync = timed(fs.symlinkSync, "symlink", binary);
  const { spawn } = childProcess;
  childProcess.spawn = new Proxy(spawn, {
    apply(target, receiver: unknown, args: Parameters<typeof spawn>): ReturnType<typeof spawn> {
      record("native_spawn_requested", { executable: kind(args[0]) });
      const start = performance.now();
      const child = Reflect.apply(target, receiver, args);
      child.once("spawn", () => { record("native_spawned", { durationMs: performance.now() - start }); });
      // An error listener would swallow an otherwise unhandled spawn error.
      return child;
    },
  });
}
