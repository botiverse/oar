import path from "node:path";

export interface Call { readonly name: string; readonly arguments: string; readonly id?: string }
const tool = (name: string, input: unknown): Call => ({ name, arguments: JSON.stringify(input) });

export function callFor(runtime: string, stage: string, cwd: string): Call | undefined {
  const file = path.join(cwd, "audit.txt");
  const command = String.raw`printf 'AUDIT_COMMAND\n'`;
  const edit = { old_string: "BEFORE", new_string: "AFTER" };
  if (stage === "catalog") { return undefined; }
  if (stage === "mcp") {
    switch (runtime) {
      case "grok": return tool("use_tool", { tool_name: "audit__echo", tool_input: { text: "ACTUAL" } });
      case "opencode": return tool("execute", { code: 'return await tools.audit.echo({text:"ACTUAL"});' });
      case "antigravity": return tool("mcp_audit_echo", { text: "ACTUAL", toolSummary: "Audit echo" });
      case "qwen": return tool("tool_call", { name: "mcp__audit__echo", arguments: { text: "ACTUAL" } });
      default: return tool("mcp__audit__echo", { text: "ACTUAL" });
    }
  }
  if (stage === "search") {
    if (runtime === "claude") { return tool("ToolSearch", { query: "select:mcp__audit__echo", max_results: 1 }); }
    if (runtime === "codebuddy") { return tool("ToolSearch", { tool_names: ["mcp__audit__echo"] }); }
    if (runtime === "qwen") { return tool("tool_search", { query: "select:mcp__audit__echo", max_results: 1 }); }
    return undefined;
  }
  switch (runtime) {
    case "claude": case "codebuddy": case "qoder":
      if (stage === "command") { return tool("Bash", { command: runtime === "codebuddy" ? "pwd" : command }); }
      if (stage === "read") { return tool("Read", { file_path: file }); }
      return tool("Edit", { file_path: file, ...edit });
    case "codex":
      if (stage === "command") { return tool("exec_command", { cmd: command }); }
      if (stage === "read") { return undefined; }
      return tool("apply_patch", {});
    case "grok":
      if (stage === "command") { return tool("run_terminal_command", { command, description: "Print audit marker" }); }
      if (stage === "read") { return tool("read_file", { target_file: file }); }
      return tool("search_replace", { file_path: file, ...edit });
    case "kimi":
      if (stage === "command") { return tool("Bash", { command }); }
      if (stage === "read") { return tool("Read", { path: file }); }
      return tool("Edit", { path: file, ...edit });
    case "opencode":
      if (stage === "command") { return tool("shell", { command }); }
      if (stage === "read") { return tool("read", { path: file }); }
      return tool("edit", { path: file, oldString: "BEFORE", newString: "AFTER" });
    case "qwen":
      if (stage === "command") { return tool("run_shell_command", { command }); }
      if (stage === "read") { return tool("read_file", { file_path: file }); }
      return tool("edit", { file_path: file, ...edit });
    case "antigravity":
      if (stage === "command") { return tool("run_command", { CommandLine: command, toolSummary: "Print audit marker", WaitMsBeforeAsync: 5000 }); }
      if (stage === "read") { return tool("read_file", { Path: file }); }
      return tool("edit_file", { Path: file, Target: "BEFORE", Replacement: "AFTER" });
    case "dsh":
      if (stage === "command") { return tool("bash", { command, description: "Print audit marker" }); }
      if (stage === "read") { return tool("read", { file_path: file }); }
      return tool("edit", { file_path: file, ...edit });
    case "pi": case "pi-rpc":
      if (stage === "command") { return tool("bash", { command }); }
      if (stage === "read") { return tool("read", { path: file }); }
      return tool("edit", { path: file, edits: [{ oldText: "BEFORE", newText: "AFTER" }] });
    default: throw new Error(`Unknown call shape ${runtime}`);
  }
}

/** Preserve Codex's custom freeform call channel rather than pretending it is a function. */
export function patchResponse(cwd: string): string {
  const input = `*** Begin Patch\n*** Update File: ${path.join(cwd, "audit.txt")}\n@@\n-BEFORE\n+AFTER\n*** End Patch`;
  const item = { type: "custom_tool_call", id: "audit_patch_item", call_id: "audit_edit", name: "apply_patch", input };
  const response = { id: "audit_patch_response", object: "response" };
  return [
    { type: "response.created", response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", output_index: 0, item },
    { type: "response.output_item.done", output_index: 0, item },
    { type: "response.completed", response: { ...response, status: "completed", output: [item], usage: { input_tokens: 10, output_tokens: 10, total_tokens: 20 } } },
  ].map((event, sequence_number) => `event: ${event.type}\ndata: ${JSON.stringify({ ...event, sequence_number })}\n\n`).join("");
}
