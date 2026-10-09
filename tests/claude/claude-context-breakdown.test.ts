import { afterEach, expect, test, vi } from "vitest";
import { claudeSession } from "../../packages/oar/src/runtimes/claude/session.js";
import { claudeContextBreakdown } from "../../packages/oar/src/runtimes/claude/context-breakdown.js";
import { asRecord } from "../../packages/oar/src/shared/json.js";
import { fakeLineProcess, type FakeLineProcess } from "../fixtures/fake-line-process.js";

// Session.contextBreakdown (oar#262): claude's `get_context_usage` with
// `detail: "full"`, asked now and never recorded.

const spawnLineProcess = vi.hoisted(() => vi.fn<(command: string, args: readonly string[]) => FakeLineProcess>());
vi.mock("../../packages/oar/src/shared/executable/index.js", () => ({ spawnLineProcess }));
const installation = { kind: "available", via: "executable", command: "claude", version: "2.1.292" } as const;
afterEach(() => { spawnLineProcess.mockReset(); });

/** The shape claude 2.1.292 answered mid-turn with one MCP server under tool search; gridRows and the rest trimmed. */
const ANSWER = {
  categories: [
    { name: "System prompt", tokens: 2375, color: "promptBorder", kind: "used" },
    { name: "System tools", tokens: 4225, color: "inactive", kind: "used" },
    { name: "MCP server instructions", tokens: 717, color: "cyan_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "MCP tools", tokens: 120, color: "cyan_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "MCP tools (deferred)", tokens: 165, color: "inactive", isDeferred: true, kind: "deferred" },
    { name: "Memory files", tokens: 111, color: "claude", kind: "used" },
    { name: "Skills", tokens: 556, color: "warning", kind: "used" },
    { name: "Messages", tokens: 8801, color: "purple_FOR_SUBAGENTS_ONLY", kind: "used" },
    { name: "Autocompact buffer", tokens: 33_000, color: "inactive", kind: "buffer" },
    { name: "Free space", tokens: 950_095, color: "promptBorder", kind: "free" },
  ],
  totalTokens: 16_905,
  maxTokens: 1_000_000,
  gridRows: [[{ color: "promptBorder", isFilled: true, categoryName: "System prompt", tokens: 2375 }]],
  memoryFiles: [{ path: "/home/user/.claude/CLAUDE.md", type: "User", tokens: 111 }],
  mcpTools: [
    { name: "mcp__echo__echo", serverName: "echo", tokens: 120, isLoaded: true },
    { name: "mcp__docs__search", serverName: "docs", tokens: 165, isLoaded: false },
  ],
  agents: [],
  skills: { totalSkills: 2, includedSkills: 2, tokens: 556, skillFrontmatter: [{ name: "dataviz", source: "built-in", tokens: 482 }, { name: "frontend-design", source: "userSettings", tokens: 74 }] },
};

const WITH_NEW_KIND = { ...ANSWER, categories: [...ANSWER.categories, { name: "Something new", tokens: 5, kind: "pinned" }] };

test("claude's categories stay in its order and words, and its kinds are OAR's", () => {
  const breakdown = claudeContextBreakdown(WITH_NEW_KIND);
  expect(breakdown.tokens).toBe(16_905);
  expect(breakdown.contextWindow).toBe(1_000_000);
  expect(breakdown.categories.map((category) => [category.name, category.kind])).toEqual([
    ["System prompt", "used"], ["System tools", "used"], ["MCP server instructions", "used"], ["MCP tools", "used"],
    ["MCP tools (deferred)", "deferred"], ["Memory files", "used"], ["Skills", "used"], ["Messages", "used"],
    ["Autocompact buffer", "reserved"], ["Free space", "free"], ["Something new", "unknown"],
  ]);
  // The sums hold as documented: used = tokens; all but deferred = the window.
  const sum = (kinds: readonly string[]): number => ANSWER.categories.filter((category) => kinds.includes(category.kind)).reduce((total, category) => total + category.tokens, 0);
  expect(sum(["used"])).toBe(breakdown.tokens);
  expect(sum(["used", "buffer", "free"])).toBe(breakdown.contextWindow);
});

test("claude's lists itemize the category each one makes up", () => {
  const items = Object.fromEntries(claudeContextBreakdown(ANSWER).categories.map((category) => [category.name, category.items]));
  expect(items["Memory files"]).toEqual([{ name: "/home/user/.claude/CLAUDE.md", tokens: 111 }]);
  expect(items["MCP tools"]).toEqual([{ name: "mcp__echo__echo", tokens: 120 }]);
  expect(items["MCP tools (deferred)"]).toEqual([{ name: "mcp__docs__search", tokens: 165 }]);
  expect(items.Skills).toEqual([{ name: "dataviz", tokens: 482 }, { name: "frontend-design", tokens: 74 }]);
  // No list, or an empty one (no custom agents), leaves the category without items.
  expect(items.Messages).toBeUndefined();
});

test("with one MCP category, every MCP tool goes under it whatever isLoaded says", () => {
  // claude 2.1.292 with tool search off: only MCP tools (used), its tool `isLoaded: false`.
  const mcpOnly = ANSWER.categories.filter((category) => category.name !== "MCP tools (deferred)");
  const items = Object.fromEntries(claudeContextBreakdown({ ...ANSWER, categories: mcpOnly }).categories.map((category) => [category.name, category.items]));
  expect(items["MCP tools"]).toEqual([{ name: "mcp__echo__echo", tokens: 120 }, { name: "mcp__docs__search", tokens: 165 }]);
  // Tool search on: only the deferred category.
  const deferredOnly = ANSWER.categories.filter((category) => category.name !== "MCP tools");
  const deferred = Object.fromEntries(claudeContextBreakdown({ ...ANSWER, categories: deferredOnly }).categories.map((category) => [category.name, category.items]));
  expect(deferred["MCP tools (deferred)"]).toEqual([{ name: "mcp__echo__echo", tokens: 120 }, { name: "mcp__docs__search", tokens: 165 }]);
});

test("an answer without totals is an error, not an empty breakdown", () => {
  expect(() => claudeContextBreakdown({ categories: [] })).toThrow(/totalTokens or maxTokens/u);
});

/** A claude that answers get_context_usage with `answer`, or with an error when it is a string. */
function scripted(answer: Record<string, unknown> | string): FakeLineProcess {
  const child = fakeLineProcess((line, process) => {
    const request = asRecord(JSON.parse(line));
    if (asRecord(request?.request)?.subtype !== "get_context_usage") { return; }
    queueMicrotask(() => {
      process.emit(`${JSON.stringify({ type: "control_response", response: typeof answer === "string"
        ? { subtype: "error", request_id: request?.request_id, error: answer }
        : { subtype: "success", request_id: request?.request_id, response: answer } })}\n`);
    });
  });
  spawnLineProcess.mockReturnValue(child);
  return child;
}

function asked(child: FakeLineProcess): unknown[] {
  return child.written.map((line) => asRecord(asRecord(JSON.parse(line))?.request)).filter((request) => request?.subtype === "get_context_usage");
}

test("asks claude for the full answer, shares a read in flight, and records nothing of it", async () => {
  const child = scripted(ANSWER);
  const session = await claudeSession(installation, { cwd: "/work" });
  const before = session.records().length;
  const [first, second] = await Promise.all([session.contextBreakdown?.(), session.contextBreakdown?.()]);
  expect(first?.categories).toHaveLength(ANSWER.categories.length);
  expect(second).toBe(first);
  expect(asked(child)).toEqual([{ subtype: "get_context_usage", detail: "full" }]);
  expect(session.records()).toHaveLength(before);
  expect(JSON.stringify(session.records())).not.toContain("CLAUDE.md");
  await session.dispose();
});

test("claude's refusal rejects with its words", async () => {
  scripted("get_context_usage is not supported in this context");
  const session = await claudeSession(installation, { cwd: "/work" });
  await expect(session.contextBreakdown?.()).rejects.toThrow(/not supported in this context/u);
  await session.dispose();
});

/** As a real claude: kill() ends stdin at once, and the exit comes later. */
function slowToExit(child: FakeLineProcess): FakeLineProcess {
  let stdinEnded = false;
  const write = child.write.bind(child);
  child.write = (text) => { if (stdinEnded) { throw new Error("write after end"); } write(text); };
  child.kill = () => { stdinEnded = true; };
  return child;
}

test("null from the moment dispose begins, without writing to the ended stdin", async () => {
  const child = slowToExit(scripted(ANSWER));
  const session = await claudeSession(installation, { cwd: "/work" });
  const disposing = session.dispose();
  expect(await session.contextBreakdown?.()).toBeNull();
  expect(asked(child)).toEqual([]);
  child.end(null);
  await disposing;
});

test("null once the process has exited, for a read in flight and every later one", async () => {
  const child = fakeLineProcess();
  spawnLineProcess.mockReturnValue(child);
  const session = await claudeSession(installation, { cwd: "/work" });
  const reading = session.contextBreakdown?.();
  child.end(1);
  expect(await reading).toBeNull();
  expect(await session.contextBreakdown?.()).toBeNull();
  await session.dispose();
});
