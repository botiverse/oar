import { parseTree, type Node, type ParseError } from "jsonc-parser";
import { UnsupportedOptionError } from "../../contracts/errors.js";
import type { SessionOptions } from "../../contracts/session.js";
import { checkResume } from "../../shared/session-options.js";
import { sessionEnvironment } from "../../shared/environment.js";

type PromptOption = "systemPrompt" | "appendSystemPrompt";

function root(content: string, option: PromptOption): Node {
  const errors: ParseError[] = [];
  const node = parseTree(content, errors, { disallowComments: true });
  if (errors.length > 0 || node?.type !== "object") {
    throw new UnsupportedOptionError(option, "OPENCODE_CONFIG_CONTENT must be a JSON object");
  }
  return node;
}

export function inlineContent(options: SessionOptions): string | undefined {
  return sessionEnvironment(options.env).OPENCODE_CONFIG_CONTENT;
}

export function validateOpenCodePrompts(options: SessionOptions): void {
  checkResume(options);
  const option = options.systemPrompt !== undefined ? "systemPrompt" : "appendSystemPrompt";
  if (options.systemPrompt === undefined && options.appendSystemPrompt === undefined) {
    return;
  }
  const content = inlineContent(options);
  if (content !== undefined) { root(content, option); }
  // An empty agent.prompt selects the built-in prompt in native request.ts.
  if (options.systemPrompt === "") {
    throw new UnsupportedOptionError("systemPrompt", "opencode treats an empty agent prompt as its built-in prompt, so it cannot replace the system prompt with an empty string");
  }
}

// Edit only the targeted container. OpenCode interpolates the raw JSON before
// parsing, so even re-encoding an untouched string can change its meaning.
function insert(content: string, node: Node, entry: string): string {
  const end = node.offset + node.length - 1;
  return content.slice(0, end) + ((node.children?.length ?? 0) === 0 ? "" : ",") + entry + content.slice(end);
}

function member(node: Node, key: string): Node | undefined {
  return node.children?.findLast((property) => property.children?.[0]?.value === key)?.children?.[1];
}

function literal(text: string): string {
  return JSON.stringify(text).replaceAll(/\{(?=env:|file:)/gu, String.raw`\u007b`);
}

function addAgentPrompt(content: string, group: string, agent: string, field: string, text: string): string {
  const path = [group, agent, field];
  let target = root(content, "systemPrompt");
  for (const [index, key] of path.entries()) {
    const child = member(target, key);
    if (child === undefined) {
      let value = literal(text);
      for (const name of path.slice(index + 1).toReversed()) { value = `{${literal(name)}:${value}}`; }
      return insert(content, target, `${literal(key)}:${value}`);
    }
    if (index === path.length - 1 || child.type !== "object") {
      throw new UnsupportedOptionError("systemPrompt", `OPENCODE_CONFIG_CONTENT already sets ${path.slice(0, index + 1).join(".")}`);
    }
    target = child;
  }
  return content;
}

export function promptContent(options: SessionOptions, group: "agent" | "agents", agents: readonly string[], file: string | undefined): string {
  let content = inlineContent(options) ?? "{}";
  if (options.systemPrompt !== undefined) {
    for (const agent of agents) {
      content = addAgentPrompt(content, group, agent, group === "agent" ? "prompt" : "system", options.systemPrompt);
    }
  }
  if (file === undefined) { return content; }
  const config = root(content, "appendSystemPrompt");
  const list = member(config, "instructions");
  if (list === undefined) { return insert(content, config, `"instructions":[${literal(file)}]`); }
  if (list.type !== "array") { throw new UnsupportedOptionError("appendSystemPrompt", "OPENCODE_CONFIG_CONTENT.instructions must be an array"); }
  return insert(content, list, literal(file));
}
