import { randomUUID } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import type { LLMock } from "@copilotkit/aimock";
import type { ProviderCaptureObserver } from "./raw-capture.js";
import { resolveRunDir } from "./trace.js";

/** One fixture file, outside its disposable HOME. Truncation is explicit. */
export function providerEvidenceWriter(file: string): (entry: Record<string, unknown>) => void {
  let bytes = 0;
  let stopped = false;
  return (entry) => {
    if (stopped) { return; }
    try {
      let json = JSON.stringify({ at: Date.now(), ...entry });
      const entryBytes = Buffer.byteLength(json);
      if (entryBytes > 1024 * 1024) {
        json = JSON.stringify({ at: Date.now(), kind: "entry_truncated", eventKind: entry.kind, requestId: entry.requestId, bytes: entryBytes, tail: json.slice(-32_768) });
      }
      let line = `${json}\n`;
      if (bytes + Buffer.byteLength(line) > 8 * 1024 * 1024 - 256) {
        line = `${JSON.stringify({ at: Date.now(), kind: "file_truncated", bytes })}\n`;
        stopped = true;
      }
      appendFileSync(file, line);
      bytes += Buffer.byteLength(line);
    } catch {
      stopped = true;
      process.stderr.write("[oar fixture] provider evidence could not be written\n");
    }
  };
}

/** Only the synthetic ACP providers use this; no login, request headers or environment dump. */
export function acpProviderEvidence(runtime: string, mock: LLMock): ProviderCaptureObserver {
  try {
    const dir = path.join(resolveRunDir(), "acp-provider");
    mkdirSync(dir, { recursive: true });
    const write = providerEvidenceWriter(path.join(dir, `${runtime}-${randomUUID()}.jsonl`));
    write({ kind: "provider_started", runtime });
    let journalCount = 0;
    return (event) => {
      write({ ...event });
      // A response means aimock has selected a fixture. Persist every newly
      // journaled request without assuming concurrent requests finish in order.
      // Journal indices are separate from the proxy's request ids.
      if (event.kind === "response") {
        const entries = mock.journal.getAll();
        for (const entry of entries.slice(journalCount)) {
          write({
            kind: "matcher_request", journalIndex: journalCount++, path: entry.path.split("?")[0], body: entry.body,
            status: entry.response.status,
            fixtureIndex: entry.response.fixture === null ? null : mock.getFixtures().indexOf(entry.response.fixture),
          });
        }
      }
    };
  } catch {
    process.stderr.write("[oar fixture] provider evidence directory could not be created\n");
    return () => {};
  }
}
