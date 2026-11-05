import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { codexInstallation, codexSession, serveMcpTools } from "../../packages/oar/src/index.js";
import { promptAndWait } from "../../packages/oar/src/observe/turns.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { namespaceMcpToolCalls, startCodexAimock } from "../harness/aimock.js";
import { expectAvailable, withProcessEnv } from "./support/asserts.js";

const APPROVAL_REFUSAL = "MCP tool call requires approval, but approval policy is never";
const PATCH_REFUSAL = "patch rejected: writing is blocked by read-only sandbox; rejected by user approval settings";

/** aimock scripts function calls; Codex's apply_patch takes a custom, freeform call. */
function patchResponse(patch: string): string {
  const item = { type: "custom_tool_call", id: "patch-item", call_id: "patch", name: "apply_patch", input: patch };
  const response = { id: "patch-response", object: "response" };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}

describe.skipIf(process.env.OAR_TEST !== "codex-aimock")("Codex host-tool annotations under approvalPolicy never", () => {
  // Both cases use the same valid tool calls and patch. The full-access
  // control proves that a missing handler or malformed patch cannot pass the
  // read-only case. Only the model is scripted; Codex and the HTTP server run.
  test.each(["read-only", "danger-full-access"] as const)("%s: host hints affect MCP approval without changing file-write policy", async (sandbox) => {
    await withProcessEnv({ OAR_CODEX_SANDBOX: sandbox }, async () => {
      const directory = await mkdtemp(path.join(tmpdir(), "oar-codex-annotations-"));
      const target = path.join(directory, "written.txt");
      const calls: string[] = [];
      const http = await serveMcpTools({ name: "annotation_probe", tools: [
        { name: "plain", inputSchema: { type: "object", properties: {} }, handler: () => { calls.push("plain"); return "PLAIN_CALLED"; } },
        { name: "readonly", inputSchema: { type: "object", properties: {} }, annotations: { readOnlyHint: true }, handler: () => { calls.push("readonly"); return "READONLY_CALLED"; } },
      ] });
      const scripted = [
        { id: "plain", name: "mcp__annotation_probe__plain", arguments: "{}" },
        { id: "readonly", name: "mcp__annotation_probe__readonly", arguments: "{}" },
        { id: "patch", name: "apply_patch", arguments: "{}" },
      ];
      let requests = 0;
      const env = await startCodexAimock((mock) => {
        mock.on({ predicate: () => true }, () => {
          const call = scripted[requests++];
          return call === undefined ? { content: "ANNOTATIONS_DONE" } : { toolCalls: [call] };
        });
      }, { captureRaw: true, rewriteResponse: body => body.includes('"name":"apply_patch"')
        ? patchResponse(`*** Begin Patch\n*** Add File: ${target}\n+WRITTEN\n*** End Patch`)
        : namespaceMcpToolCalls(body) });
      try {
        const installation = await codexInstallation();
        expectAvailable(installation, "codex");
        // gpt-5.5 offers native apply_patch; gpt-5.1 does not on Codex 0.166.0.
        const session = await codexSession(installation, { cwd: directory, model: "gpt-5.5", ...(env.env === undefined ? {} : { env: env.env }), mcpServers: [http.server] });
        try {
          expect(await promptAndWait(session, "Probe both host tools, then write the file.", { timeoutMs: 60_000 })).toMatchObject({ kind: "ended", outcome: { kind: "completed" }, text: "ANNOTATIONS_DONE" });
          const restricted = sandbox === "read-only";
          const open = session.records().find(record => record.kind === "frame" && record.body.type === "thread/start");
          expect(open).toMatchObject({ body: { native: { approvalPolicy: "never", sandbox: { type: restricted ? "readOnly" : "dangerFullAccess" } } } });
          expect(requests).toBe(4);
          expect(calls).toEqual(restricted ? ["readonly"] : ["plain", "readonly"]);
          const completed = session.records().flatMap(record => record.kind === "frame" && record.body.type === "item/completed" ? [asRecord(asRecord(record.body.native)?.item)] : []);
          expect(completed.find(item => item?.id === "plain")).toMatchObject({ type: "mcpToolCall", status: restricted ? "failed" : "completed", error: restricted ? { message: APPROVAL_REFUSAL } : null });
          expect(completed.find(item => item?.id === "readonly")).toMatchObject({ type: "mcpToolCall", status: "completed", readOnlyHint: true, error: null });

          const input = asRecord(env.raw.at(-1)?.body)?.input;
          expect(Array.isArray(input)).toBe(true);
          const results = (Array.isArray(input) ? input : []).map(item => asRecord(item)).filter(item => item?.type === "function_call_output" || item?.type === "custom_tool_call_output");
          expect(results.map(item => item?.call_id)).toEqual(["plain", "readonly", "patch"]);
          expect(JSON.stringify(results[0]?.output)).toContain(restricted ? APPROVAL_REFUSAL : "PLAIN_CALLED");
          expect(JSON.stringify(results[1]?.output)).toContain("READONLY_CALLED");
          expect(results[2]?.output).toContain(restricted ? PATCH_REFUSAL : "Success. Updated the following files:");
          expect(existsSync(target)).toBe(!restricted);
          if (!restricted) { expect(await readFile(target, "utf8")).toBe("WRITTEN\n"); }
        } finally {
          await session.dispose();
        }
      } finally {
        await http.close();
        await env.stop();
        await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      }
    });
  }, 90_000);
});
