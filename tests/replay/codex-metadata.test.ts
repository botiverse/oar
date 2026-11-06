import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { foldCodexNotification, initialCodexProjection } from "../../packages/oar/src/runtimes/codex/projection.js";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

const here = import.meta.dirname;
const ROOT = "thread-root";

for (const scenario of ["message-completed-only", "message-streamed", "mcp-echo"]) {
  test(`codex ${scenario}: native text and MCP metadata survive replay`, async () => {
    // Message fixtures: Codex 0.167.0, experiments/codex-projection/probe.ts,
    // loopback provider with/without text deltas. Native identities normalized.
    // MCP uses the existing native stdio/HTTP trace, not a reconstructed frame.
    let state = initialCodexProjection(ROOT);
    const lines = readFileSync(path.join(here, "fixtures", `codex-${scenario}.raw.jsonl`), "utf8").trim().split("\n");
    const rows = lines.flatMap(line => {
      const params = asRecord(parseJson(line)) ?? {};
      const method = String(params.method);
      const result = foldCodexNotification(state, method, params);
      ({ state } = result);
      return result.commands.flatMap(command => command.kind === "frame" ? command.body.events
        .filter(event => event.kind === "text_delta" || event.kind === "tool_call_started")
        .map(event => ({ method, event })) : []);
    });
    await expect(`${JSON.stringify(rows, null, 2)}\n`).toMatchFileSnapshot(path.join(here, "fixtures", `codex-${scenario}.metadata.json`));
  });
}
