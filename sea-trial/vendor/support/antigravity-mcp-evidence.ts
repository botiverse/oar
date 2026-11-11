import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, open, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import { sessionCredentialRedactor } from "../../../packages/oar/src/shared/credential-redactor.js";
import { resolveRunDir } from "../../harness/trace.js";

const FILE_LIMIT = 4;
const BYTE_LIMIT = 512 * 1024;

/** Synthetic fixture logs only. Paths and credential-bearing lines are removed before writing artifacts. */
export function sanitizeAntigravityLog(text: string, homes: readonly string[], secrets: readonly string[]): string {
  const paths = [...homes, process.cwd(), homedir()].filter(value => value.length > 1).toSorted((a, b) => b.length - a.length);
  const values = secrets.filter(value => value.length > 0).toSorted((a, b) => b.length - a.length);
  let omitContinuation = false;
  return text.split("\n").map(line => {
    if (/^[IWEF]\d{4} \d{2}:\d{2}:\d{2}/u.test(line)) { omitContinuation = false; }
    // Native logs can embed whole requests. Omit a credential-bearing line
    // instead of guessing the boundaries of quoted, nested or multiline values.
    const keys = line.replaceAll(/\\+(["'])/gu, "$1");
    if (/(?:authorization|cookie|(?:api[_-]?|access[_-]?|refresh[_-]?)?(?:token|secret|password|passwd|credential)|api[_-]?key)\s*["']?\s*[:=]/iu.test(keys)
      || /\b(?:Bearer|Basic)\s+\S+/iu.test(line)) { omitContinuation = true; return "[credential-bearing log entry omitted]"; }
    if (omitContinuation) { return ""; }
    let clean = line;
    for (const source of paths) {
      clean = clean.replaceAll(source, "<local-path>").replaceAll(JSON.stringify(source).slice(1, -1), "<local-path>");
    }
    for (const secret of values) { clean = clean.replaceAll(secret, "[redacted]").replaceAll(JSON.stringify(secret).slice(1, -1), "[redacted]"); }
    return clean
      .replaceAll(/(?:https?|wss?):\/\/[^\s"'<>]+/giu, "<url>")
      .replaceAll(/\/(?:Users|home)\/[^/\r\n"'<>]+/gu, "/<user>")
      .replaceAll(/[a-z]:\\+(?:Users|Documents and Settings)\\+[^\\\r\n"'<>]+/giu, "<user-home>")
      .replaceAll(/\b(?:sk-|gh[pousr]_|github_pat_|AIza|ya29\.)[\w.-]+/gu, "[redacted]");
  }).join("\n");
}

/** Drop incomplete lines and cropped native entries whose credential key could be outside the tail. */
async function readBounded(file: string, native: boolean): Promise<{ text: string; bytes: number; truncated: boolean }> {
  const handle = await open(file, "r");
  try {
    const { size } = await handle.stat();
    if (!Number.isSafeInteger(size) || size < 0) { throw new Error("Invalid log size"); }
    const length = Math.min(size, BYTE_LIMIT);
    const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(length), position: Math.max(0, size - length) });
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (size > length) {
      text = text.includes("\n") ? text.slice(text.indexOf("\n") + 1) : "";
      if (native) {
        const entry = text.search(/^[IWEF]\d{4} \d{2}:\d{2}:\d{2}/mu);
        text = entry < 0 ? "" : text.slice(entry);
      }
    }
    // The writer may still be active; leave an unfinished line out as well.
    text = text.slice(0, text.lastIndexOf("\n") + 1);
    return { text, bytes: size, truncated: size > length || Buffer.byteLength(text) !== bytesRead };
  } finally { await handle.close(); }
}

export interface AntigravityMcpEvidence {
  readonly directory: string;
  /** Fixed labels, never a username, native session ID or tool argument. */
  flags(server: "session-echo" | "user-echo" | "userecho"): readonly string[];
  retain(geminiHome: string, fixtureEnv: Readonly<Record<string, string>>): Promise<void>;
  remove(): Promise<void>;
}

/** Opted into by the single name-clash case; raw MCP payloads are never recorded. */
export async function createAntigravityMcpEvidence(): Promise<AntigravityMcpEvidence | undefined> {
  const directory = await mkdtemp(path.join(tmpdir(), "oar-agy-mcp-evidence-")).catch(() => null);
  if (directory === null) {
    process.stderr.write("[oar fixture] Antigravity MCP evidence setup failed\n");
    return undefined;
  }
  return {
    directory,
    flags: server => ["--evidence", path.join(directory, `${server}.jsonl`)],
    async retain(geminiHome, fixtureEnv) {
      try {
        const destination = path.join(resolveRunDir(), "agy-mcp-failure", randomUUID());
        await mkdir(destination, { recursive: true });
        const credentials = sessionCredentialRedactor({ env: Object.fromEntries(Object.entries({ ...process.env, ...fixtureEnv }).map(([key, value]) => [key, value ?? null])) }).values();
        const sanitize = (text: string): string => sanitizeAntigravityLog(text,
          [geminiHome, fixtureEnv.HOME ?? "", fixtureEnv.HOME === undefined ? "" : path.dirname(fixtureEnv.HOME), directory], [...credentials, "aimock", "oar-user-credential"]);
        const logDir = path.join(geminiHome, "antigravity-cli", "log");
        const native = await readdir(logDir, { withFileTypes: true }).catch(() => null);
        const names = native?.filter(entry => entry.isFile() && entry.name.endsWith(".log"))
          .map(entry => entry.name).toSorted().toReversed() ?? [];
        const sources = [
          ...names.slice(0, FILE_LIMIT).map((name, index) => ({ source: path.join(logDir, name), file: `native-${String(index)}.log`, kind: name.startsWith("acp-front-") ? "front" : (name.startsWith("acp-worker-") ? "worker" : "native") })),
          ...["session-echo", "user-echo", "userecho"].map(server => ({ source: path.join(directory, `${server}.jsonl`), file: `${server}.jsonl`, kind: "mcp" })),
        ];
        const files = await Promise.all(sources.map(async ({ source, file, kind }) => {
          try {
            const content = await readBounded(source, kind !== "mcp");
            await writeFile(path.join(destination, file), sanitize(content.text));
            return { file, kind, sourceBytes: content.bytes, truncated: content.truncated };
          } catch { return { file, kind, error: "unavailable" }; }
        }));
        await writeFile(path.join(destination, "manifest.json"), JSON.stringify({
          at: Date.now(), case: "antigravity MCP name clash", nativeDirectoryReadable: native !== null,
          omittedNativeFiles: Math.max(0, names.length - FILE_LIMIT), files,
        }, null, 2));
      } catch {
        // Evidence failure cannot replace the vendor assertion or prevent cleanup.
        process.stderr.write("[oar fixture] Antigravity MCP failure evidence could not be retained\n");
      }
    },
    async remove() {
      await rm(directory, { recursive: true, force: true }).catch(() => {
        process.stderr.write("[oar fixture] Antigravity MCP evidence cleanup failed\n");
      });
    },
  };
}
