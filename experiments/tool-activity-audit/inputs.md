# Exact tool inputs

Selected successful Linux command/edit/MCP controls from the [audit](README.md).
Input cells below are the actual string payload, with disposable paths replaced.
Missing fields are shown as absent; native categories and locations are evidence only.

## claude

[Selected records](results/claude.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `Bash` | absent | `{"command":"printf 'AUDIT_COMMAND\\n'"}` | absent / absent |
| `Edit` | absent | `{"replace_all":false,"file_path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | absent / absent |
| `mcp__audit__echo` | absent | `{"text":"ACTUAL"}` | absent / absent |

## codex

[Selected records](results/codex.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `commandExecution` | `/bin/bash -lc "printf 'AUDIT_COMMAND\\n'"` | none | absent / absent |
| `fileChange` | `[{"path":"<project>/audit.txt","kind":{"type":"update","move_path":null},"diff":"@@ -1 +1 @@\n-BEFORE\n+AFTER\n"}]` | none | absent / absent |
| `mcpToolCall` | `{"text":"ACTUAL"}` | none | `audit` / `echo` |

## grok

[Selected records](results/grok.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `run_terminal_command` | `{"command":"printf 'AUDIT_COMMAND\\n'","description":"Print audit marker"}` | `{"variant":"Bash","command":"printf 'AUDIT_COMMAND\\n'","description":"Print audit marker","is_background":false}` | absent / absent |
| `search_replace` | `{"file_path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | `{"variant":"SearchReplace","file_path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER","replace_all":false}` | absent / absent |
| `use_tool` | `{"tool_name":"audit__echo","tool_input":{"text":"ACTUAL"}}` | `{"variant":"UseTool","tool_name":"audit__echo","tool_input":{"text":"ACTUAL"}}` | absent / absent |

## kimi

[Selected records](results/kimi.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `Bash` | absent | `{"command":"printf 'AUDIT_COMMAND\\n'"}` | absent / absent |
| `Edit` | absent | `{"path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | absent / absent |
| `mcp__audit__echo` | absent | `ACTUAL` | absent / absent |

## opencode

[Selected records](results/opencode.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `shell` | `{"cwd":"<project>"}` | `{"command":"printf 'AUDIT_COMMAND\\n'","cwd":"<project>"}` | absent / absent |
| `edit` | `{}` | `{"path":"<project>/audit.txt","oldString":"BEFORE","newString":"AFTER"}` | absent / absent |
| `execute` | `{}` | `{"code":"return await tools.audit.echo({text:\"ACTUAL\"});"}` | absent / absent |

## qwen

[Selected records](results/qwen.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `run_shell_command` | absent | `{"command":"printf 'AUDIT_COMMAND\\n'"}` | absent / absent |
| `edit` | absent | `{"file_path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | absent / absent |
| `tool_call` | absent | `{"name":"mcp__audit__echo","arguments":{"text":"ACTUAL"}}` | absent / absent |

## qoder

[Selected records](results/qoder.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `Bash` | `{"command":"printf 'AUDIT_COMMAND\\n'"}` | none | absent / absent |
| `Edit` | `{"file_path":"<probe>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | none | absent / absent |
| `mcp__audit__echo` | `{"text":"ACTUAL"}` | none | absent / absent |

## codebuddy

[Selected records](results/codebuddy.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `Bash` | `{}` | `{"command":"pwd"}` | absent / absent |
| `Edit` | `{}` | `{"file_path":"/tmp/o"}`<br>`{"file_path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | absent / absent |
| `mcp__audit__echo` | `{}` | `ACTUAL` | absent / absent |

## antigravity

[Selected records](results/antigravity.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `run_command` | `{"CommandLine":"printf 'AUDIT_COMMAND\\n'","WaitMsBeforeAsync":5000,"toolSummary":"Print audit marker"}` | none | absent / absent |
| `edit_file` | `{"Path":"<project>/audit.txt","Replacement":"AFTER","Target":"BEFORE"}` | none | absent / absent |
| `mcp_audit_echo` | `ACTUAL` | none | absent / absent |

## dsh

[Selected records](results/dsh.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `bash` | `{"command":"printf 'AUDIT_COMMAND\\n'","description":"Print audit marker"}` | none | absent / absent |
| `edit` | `{"file_path":"<project>/audit.txt","old_string":"BEFORE","new_string":"AFTER"}` | none | absent / absent |
| `mcp__audit__echo` | `{"text":"ACTUAL"}` | none | absent / absent |

## pi

[Selected records](results/pi.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `bash` | `{"command":"printf 'AUDIT_COMMAND\\n'"}` | none | absent / absent |
| `edit` | `{"path":"<project>/audit.txt","edits":[{"oldText":"BEFORE","newText":"AFTER"}]}` | none | absent / absent |
| `mcp__audit__echo` | `{"text":"ACTUAL"}` | none | absent / absent |

## pi-rpc

[Selected records](results/pi-rpc.json).

| `tool` | Start `input` | Subsequent `tool_call_input` values | `server` / `toolName` |
|---|---|---|---|
| `bash` | `{"command":"printf 'AUDIT_COMMAND\\n'"}` | none | absent / absent |
| `edit` | `{"path":"<project>/audit.txt","edits":[{"oldText":"BEFORE","newText":"AFTER"}]}` | none | absent / absent |
| `mcp__audit__echo` | `{"text":"ACTUAL"}` | none | absent / absent |

