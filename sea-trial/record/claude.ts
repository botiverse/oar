import { spawn } from "node:child_process";
import { asRecord, parseJson } from "../../packages/oar/src/shared/json.js";

export interface RecordRequest {
  readonly prompt: string;
  readonly followUps: readonly string[];
}

const userLine = (text: string): string =>
  `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text }] } })}\n`;

/** Keep only the fields the claude projection reads. */
export function scrub(line: string): Record<string, unknown> | null {
  const frame = asRecord(parseJson(line));
  if (frame === null) {
    return null;
  }
  const content = asRecord(frame.message)?.content;
  // Attribution: a sub-agent's frames name the Task call that started it.
  const parent = typeof frame.parent_tool_use_id === "string" ? { parent_tool_use_id: frame.parent_tool_use_id } : {};
  switch (frame.type) {
    case "system":
      return { type: "system", subtype: frame.subtype };
    case "assistant":
      return { type: "assistant", ...parent, message: { content: scrubBlocks(content) } };
    case "user":
      return { type: "user", ...parent, message: { content: scrubBlocks(content).filter((block) => block.type === "tool_result") } };
    case "result": {
      const usage = asRecord(frame.usage);
      const modelUsage = asRecord(frame.modelUsage);
      return {
        type: "result", subtype: frame.subtype, is_error: frame.is_error,
        ...(usage === null ? {} : { usage: {
          input_tokens: usage.input_tokens,
          output_tokens: usage.output_tokens,
          cache_read_input_tokens: usage.cache_read_input_tokens,
          cache_creation_input_tokens: usage.cache_creation_input_tokens,
        } }),
        // The session total (#282): each model's counts and window.
        ...(modelUsage === null ? {} : { modelUsage: Object.fromEntries(Object.entries(modelUsage).map(([model, raw]) => {
          const entry = asRecord(raw) ?? {};
          return [model, {
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            cacheReadInputTokens: entry.cacheReadInputTokens,
            cacheCreationInputTokens: entry.cacheCreationInputTokens,
            contextWindow: entry.contextWindow,
          }];
        })) }),
      };
    }
    default:
      return { type: frame.type };
  }
}

function scrubBlocks(content: unknown): Record<string, unknown>[] {
  if (!Array.isArray(content)) {
    return [];
  }
  return content.map((raw: unknown): Record<string, unknown> => {
    const block = asRecord(raw) ?? {};
    switch (block.type) {
      case "text": return { type: "text", text: block.text };
      case "thinking": return { type: "thinking", thinking: block.thinking };
      case "redacted_thinking": return { type: "redacted_thinking" };
      case "tool_use": return { type: "tool_use", id: block.id, name: block.name, input: block.input };
      case "tool_result": return { type: "tool_result", tool_use_id: block.tool_use_id, content: block.content };
      default: return { type: block.type };
    }
  });
}

export async function startClaudeRecording(request: RecordRequest): Promise<Record<string, unknown>[]> {
  const child = spawn("claude", [
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose",
    "--dangerously-skip-permissions", "--model", "haiku",
  ], { stdio: ["pipe", "pipe", "inherit"] });

  const raw: Record<string, unknown>[] = [];
  const pending = [...request.followUps];
  let buffer = "";
  child.stdout.on("data", (chunk: Buffer) => {
    buffer += chunk.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (line.trim().length === 0) {
        continue;
      }
      const scrubbed = scrub(line);
      if (scrubbed !== null) {
        raw.push(scrubbed);
      }
      // Multi-turn: on each result, send the next queued prompt (bare) as a
      // fresh turn; steer prompts (leading "+") were sent on a timer instead.
      if (scrubbed?.type === "result") {
        const next = pending.find((p) => !p.startsWith("+"));
        if (next === undefined) {
          // No more full-turn follow-ups (steers are sent on a timer, not
          // queued here); close stdin so the session ends.
          child.stdin.end();
        } else {
          pending.splice(pending.indexOf(next), 1);
          child.stdin.write(userLine(next));
        }
      }
    }
  });

  child.stdin.write(userLine(request.prompt));
  // Steer prompts land mid-turn on a short timer.
  for (const [index, steer] of request.followUps.filter((p) => p.startsWith("+")).entries()) {
    setTimeout(() => {
      child.stdin.write(userLine(steer.slice(1)));
    }, 1200 * (index + 1));
  }

  const done = new Promise<Record<string, unknown>[]>((resolve) => {
    child.on("exit", () => {
      resolve(raw);
    });
  });
  const result = await done;
  return result;
}
