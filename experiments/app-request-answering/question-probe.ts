/**
 * Native Claude question round-trip against a scripted provider, no account.
 *
 *   OAR_CLAUDE_BIN=/absolute/path/to/claude pnpm tsx experiments/app-request-answering/question-probe.ts
 *   OAR_QUESTION_CASE=roundtrip pnpm tsx ... (filters by label)
 *
 * Claude's AskUserQuestion is a `can_use_tool` control request: the host must
 * reply with `behavior: "allow"` and the tool input augmented by `answers`.
 * This probe checks what OAR would need to rely on — correlation by
 * request id, cancellation, a child agent's request, no implicit approval —
 * before any adapter opts in. It never contacts a real model or account.
 */
/* oxlint-disable eslint/no-await-in-loop, eslint/max-lines-per-function, eslint/max-statements, eslint/max-params, import/no-nodejs-modules -- a probe script: scenarios run one at a time against a local scripted provider. */
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";
import { asRecord, asRecordList, parseJson, type JsonRecord } from "../../packages/oar/src/shared/json.js";
import { startClaudeAimock, type LLMock } from "../../sea-trial/harness/aimock.js";

const command = process.env.OAR_CLAUDE_BIN ?? "claude";
const caseFilter = process.env.OAR_QUESTION_CASE;
const output = path.resolve("oar-trial-run/claude-questions");
await mkdir(output, { recursive: true });

interface Child {
  readonly seen: JsonRecord[];
  send(message: JsonRecord): void;
  next(from: number, accepts: (message: JsonRecord) => boolean, ms?: number): Promise<JsonRecord | null>;
  stop(): Promise<number | null>;
}

function jsonLines(args: readonly string[], cwd: string, env: NodeJS.ProcessEnv): Child {
  const proc = spawn(command, [...args], { cwd, env, stdio: ["pipe", "pipe", "ignore"] });
  const seen: JsonRecord[] = [];
  const waiters: { readonly accepts: (message: JsonRecord) => boolean; readonly resolve: (message: JsonRecord | null) => void }[] = [];
  createInterface({ input: proc.stdout }).on("line", (line) => {
    const message = asRecord(parseJson(line));
    if (message === null) {
      return;
    }
    seen.push(message);
    for (const waiter of waiters.filter((candidate) => candidate.accepts(message))) {
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const exited = Promise.withResolvers<number | null>();
  proc.on("exit", (code) => {
    exited.resolve(code);
  });
  return {
    seen,
    send(message) {
      proc.stdin.write(`${JSON.stringify(message)}\n`);
    },
    async next(from, accepts, ms = 30_000) {
      const already = seen.slice(from).find((message) => accepts(message));
      if (already !== undefined) {
        return already;
      }
      const settlement = Promise.withResolvers<JsonRecord | null>();
      waiters.push({ accepts, resolve: settlement.resolve });
      const timer = setTimeout(() => {
        settlement.resolve(null);
      }, ms);
      try {
        const message = await settlement.promise;
        return message;
      } finally {
        clearTimeout(timer);
      }
    },
    async stop() {
      proc.stdin.end();
      proc.kill();
      const code = await exited.promise;
      return code;
    },
  };
}

function canUseTool(message: JsonRecord | null): JsonRecord | null {
  return message !== null && message.type === "control_request" && asRecord(message.request)?.subtype === "can_use_tool" ? message : null;
}

function questionRequest(message: JsonRecord): { readonly input: JsonRecord; readonly questions: readonly JsonRecord[]; readonly agentId: unknown; readonly requiresUserInteraction: unknown } {
  const request = asRecord(message.request) ?? {};
  return { input: asRecord(request.input) ?? {}, questions: asRecordList(asRecord(request.input)?.questions), agentId: request.agent_id, requiresUserInteraction: request.requires_user_interaction };
}

/** Every `tool_result` text in the frames a native session printed. */
function toolResultTexts(frames: readonly JsonRecord[]): readonly string[] {
  return frames.flatMap((frame) => {
    if (frame.type !== "user") {
      return [];
    }
    const content: unknown = asRecord(frame.message)?.content;
    return Array.isArray(content)
      ? content.flatMap((block): string[] => {
          const item = asRecord(block);
          return item?.type === "tool_result" ? [typeof item.content === "string" ? item.content : JSON.stringify(item.content)] : [];
        })
      : [];
  });
}

/** aimock hands handlers a chat-completion request: a tool result is a `tool`-role message. */
function toolResultCount(messages: unknown): number {
  return Array.isArray(messages) ? messages.filter((message) => asRecord(message)?.role === "tool").length : 0;
}

function askedQuestions(questions: readonly JsonRecord[]): readonly { readonly id: string; readonly multiSelect: boolean }[] {
  return questions.map((question) => ({ id: String(question.question), multiSelect: question.multiSelect === true }));
}

function answer(question: JsonRecord, answers: Readonly<Record<string, string>>): JsonRecord {
  const request = asRecord(question.request) ?? {};
  return { type: "control_response", response: { subtype: "success", request_id: question.request_id,
    response: { behavior: "allow", updatedInput: { ...asRecord(request.input), answers } } } };
}

interface ScenarioReport {
  readonly label: string;
  readonly asked: boolean;
  readonly questions: readonly { readonly id: string; readonly multiSelect: boolean }[];
  readonly requiresUserInteraction: unknown;
  readonly agentId: string | null;
  readonly answerSent: boolean;
  readonly sameTurnAnswer: boolean;
  readonly resultSubtype: unknown;
  readonly isError: unknown;
  readonly permissionDenials: unknown;
  readonly wrongRequestIdIgnored: boolean | null;
  readonly cancelFrame: boolean | null;
  readonly lateAnswerIgnored: boolean | null;
  readonly secondApprovalAsked: boolean | null;
  readonly markerExists: boolean | null;
  readonly childAnswered: boolean | null;
  readonly childQuestionUnavailable: boolean | null;
  readonly parentCompleted: boolean | null;
  readonly elapsedMs: number;
}

const reports: ScenarioReport[] = [];

/** One isolated session; the caller scripts its provider and drives one prompt. */
async function scenario(label: string, options: {
  readonly configure: (mock: LLMock, nonce: string) => void;
  readonly drive: (child: Child, nonce: string, from: number, work: string) => Promise<Partial<ScenarioReport>>;
}): Promise<void> {
  if (caseFilter !== undefined && !label.includes(caseFilter)) {
    return;
  }
  const nonce = randomUUID();
  const work = await mkdtemp(path.join(tmpdir(), "oar-question-"));
  const home = path.join(work, "home");
  await mkdir(home, { recursive: true });
  const provider = await startClaudeAimock((mock) => { options.configure(mock, nonce); }, { captureRaw: true });
  const started = Date.now();
  const child = jsonLines([
    "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--replay-user-messages",
    "--model", "haiku", "--session-id", randomUUID(), "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--settings", JSON.stringify({ disableAllHooks: true }),
    "--permission-mode", "default", "--permission-prompt-tool", "stdio",
  ], work, { PATH: process.env.PATH, LANG: "C.UTF-8", HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    CLAUDECODE: undefined, CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1", ...provider.env });
  const from = child.seen.length;
  let outcome: Partial<ScenarioReport> = {};
  try {
    child.send({ type: "user", message: { role: "user", content: [{ type: "text", text: `${label} ${nonce}` }] } });
    outcome = await options.drive(child, nonce, from, work);
  } finally {
    await child.stop();
    await provider.stop();
    await rm(work, { recursive: true, force: true });
  }
  const report: ScenarioReport = { label, asked: false, questions: [], requiresUserInteraction: null, agentId: null, answerSent: false,
    sameTurnAnswer: false, resultSubtype: null, isError: null, permissionDenials: null, wrongRequestIdIgnored: null,
    cancelFrame: null, lateAnswerIgnored: null, secondApprovalAsked: null, markerExists: null, childAnswered: null,
    childQuestionUnavailable: null, parentCompleted: null, ...outcome, elapsedMs: Date.now() - started };
  reports.push(report);
  console.log(JSON.stringify(report));
  await writeFile(path.join(output, `${label}.json`), `${JSON.stringify({ report, frames: child.seen, requests: provider.raw.slice(0, 4) }, null, 2)}\n`);
}

await scenario("question-roundtrip", {
  configure(mock, nonce) {
    let asked = false;
    mock.onMessage(/question-roundtrip/u, () => {
      if (asked) {
        return { content: "QUESTION_OK" };
      }
      asked = true;
      return { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [
        { question: `Which synthetic colour ${nonce}?`, header: "Colour", multiSelect: false, options: [{ label: "Red", description: "warm" }, { label: "Blue", description: "cool" }] },
        { question: `Which sizes ${nonce}?`, header: "Sizes", multiSelect: true, options: [{ label: "Small", description: "compact" }, { label: "Large", description: "roomy" }] },
      ] }) }] };
    });
  },
  async drive(child, nonce, from) {
    const question = await child.next(from, (message) => canUseTool(message) !== null);
    const asked = canUseTool(question);
    if (asked === null) {
      return { asked: false };
    }
    const { questions, requiresUserInteraction } = questionRequest(asked);
    const ids = askedQuestions(questions);
    child.send(answer(asked, { [ids[0]?.id ?? ""]: "Blue", [ids[1]?.id ?? ""]: "Small, Large" }));
    const result = await child.next(from, (message) => message.type === "result");
    const text = toolResultTexts(child.seen.slice(from)).join("\n");
    return { asked: true, questions: ids, requiresUserInteraction, answerSent: true,
      sameTurnAnswer: text.includes(`"Which synthetic colour ${nonce}?"="Blue"`) && text.includes(`"Which sizes ${nonce}?"="Small, Large"`),
      resultSubtype: result?.subtype, isError: result?.is_error, permissionDenials: result?.permission_denials };
  },
});

await scenario("question-wrong-request-id", {
  configure(mock) {
    let asked = false;
    mock.onMessage(/question-wrong-request-id/u, () => {
      if (asked) {
        return { content: "WRONG_ID_DONE" };
      }
      asked = true;
      return { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [
        { question: "Which synthetic shape?", header: "Shape", multiSelect: false, options: [{ label: "Circle", description: "round" }, { label: "Square", description: "boxy" }] },
      ] }) }] };
    });
  },
  async drive(child, _nonce, from) {
    const question = await child.next(from, (message) => canUseTool(message) !== null);
    const asked = canUseTool(question);
    if (asked === null) {
      return { asked: false };
    }
    const { questions } = questionRequest(asked);
    const id = String(asked.request_id);
    child.send({ type: "control_response", response: { subtype: "success", request_id: `${id}-stale`, response: { behavior: "allow", updatedInput: { ...asRecord(asRecord(asked.request)?.input), answers: { "Which synthetic shape?": "Circle" } } } } });
    const leaked = await child.next(from, (message) => message.type === "result", 1500);
    const ignored = leaked === null;
    child.send(answer(asked, { [askedQuestions(questions)[0]?.id ?? ""]: "Square" }));
    const result = await child.next(from, (message) => message.type === "result");
    const answered = toolResultTexts(child.seen.slice(from)).join("\n").includes(`"Which synthetic shape?"="Square"`);
    return { asked: true, questions: askedQuestions(questions), answerSent: true, wrongRequestIdIgnored: ignored,
      sameTurnAnswer: ignored && answered, resultSubtype: result?.subtype, isError: result?.is_error };
  },
});

await scenario("question-cancel", {
  configure(mock) {
    let asked = false;
    mock.onMessage(/question-cancel/u, () => {
      if (asked) {
        return { content: "CANCEL_DONE" };
      }
      asked = true;
      return { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [
        { question: "Which synthetic animal?", header: "Animal", multiSelect: false, options: [{ label: "Cat", description: "feline" }, { label: "Dog", description: "canine" }] },
      ] }) }] };
    });
  },
  async drive(child, _nonce, from) {
    const question = await child.next(from, (message) => canUseTool(message) !== null);
    const asked = canUseTool(question);
    if (asked === null) {
      return { asked: false };
    }
    child.send({ type: "control_request", request_id: `interrupt-${randomUUID()}`, request: { subtype: "interrupt" } });
    const result = await child.next(from, (message) => message.type === "result");
    const cancelled = child.seen.slice(from).find((message) => message.type === "control_cancel_request" && message.request_id === asked.request_id);
    const late = child.seen.length;
    child.send(answer(asked, { "Which synthetic animal?": "Dog" }));
    await delay(1000);
    const lateIgnored = !child.seen.slice(late).some((message) => message.type === "result" || (message.type === "assistant"));
    return { asked: true, questions: askedQuestions(questionRequest(asked).questions), answerSent: false, cancelFrame: cancelled !== undefined,
      lateAnswerIgnored: lateIgnored, resultSubtype: result?.subtype, isError: result?.is_error };
  },
});

await scenario("question-no-implicit-approval", {
  configure(mock) {
    mock.onMessage(/question-no-implicit-approval/u, (request: JsonRecord) => {
      const results = toolResultCount(request.messages);
      if (results === 0) {
        return { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [
          { question: "Which synthetic plan?", header: "Plan", multiSelect: false, options: [{ label: "A", description: "first" }, { label: "B", description: "second" }] },
        ] }) }] };
      }
      return results === 1 ? { toolCalls: [{ name: "Bash", arguments: JSON.stringify({ command: "touch synthetic-write" }) }] } : { content: "APPROVAL_DONE" };
    });
  },
  async drive(child, _nonce, from, work) {
    const existed = async (): Promise<boolean> => {
      try {
        await readFile(path.join(work, "synthetic-write"), "utf8");
        return true;
      } catch {
        return false;
      }
    };
    const first = await child.next(from, (message) => canUseTool(message) !== null);
    const asked = canUseTool(first);
    if (asked === null) {
      return { asked: false };
    }
    child.send(answer(asked, { "Which synthetic plan?": "B" }));
    const second = await child.next(from, (message) => canUseTool(message) !== null && message.request_id !== asked.request_id);
    const bash = canUseTool(second);
    await delay(1500);
    if (bash !== null) {
      child.send({ type: "control_response", response: { subtype: "success", request_id: bash.request_id, response: { behavior: "deny", message: "the probe does not approve this" } } });
    }
    const result = await child.next(from, (message) => message.type === "result");
    return { asked: true, questions: askedQuestions(questionRequest(asked).questions), answerSent: true,
      secondApprovalAsked: bash !== null, markerExists: await existed(),
      resultSubtype: result?.subtype, isError: result?.is_error };
  },
});

await scenario("question-child", {
  configure(mock) {
    // A subagent prompt is its own user turn, so match it before the parent's.
    mock.on({ userMessage: /CHILD_QUESTION_PROBE/u, hasToolResult: false }, { toolCalls: [{ name: "AskUserQuestion", arguments: JSON.stringify({ questions: [
      { question: "Which synthetic child answer?", header: "Child", multiSelect: false, options: [{ label: "Alpha", description: "first" }, { label: "Beta", description: "second" }] },
    ] }) }] });
    mock.on({ userMessage: /CHILD_QUESTION_PROBE/u, hasToolResult: true }, { content: "CHILD_DONE" });
    mock.on({ userMessage: /question-child/u, hasToolResult: false }, { toolCalls: [{ name: "Task", arguments: JSON.stringify({ description: "child question", prompt: "CHILD_QUESTION_PROBE ask one question", subagent_type: "general-purpose" }) }] });
    mock.on({ userMessage: /question-child/u, hasToolResult: true }, { content: "PARENT_DONE" });
    mock.onMessage(/[\s\S]*/u, { content: "PARENT_DONE" });
  },
  async drive(child, _nonce, from) {
    const observed = await child.next(from, (message) => {
      if (canUseTool(message) !== null) {
        return true;
      }
      if (message.type !== "user") {
        return false;
      }
      const content: unknown = asRecord(message.message)?.content;
      return Array.isArray(content) && content.some((block) => asRecord(block)?.type === "tool_result" && String(asRecord(block)?.content).includes("not available inside subagents"));
    }, 15_000);
    const asked = canUseTool(observed);
    if (asked !== null) {
      // A child question the host can answer would carry the child's native id.
      const request = questionRequest(asked);
      child.send(answer(asked, { "Which synthetic child answer?": "Beta" }));
      const result = await child.next(from, (message) => message.type === "result", 15_000);
      return { asked: true, questions: askedQuestions(request.questions), agentId: typeof request.agentId === "string" ? request.agentId : null,
        answerSent: true, childAnswered: true, childQuestionUnavailable: false, parentCompleted: result?.subtype === "success",
        resultSubtype: result?.subtype, isError: result?.is_error };
    }
    const unavailable = observed !== null;
    const result = await child.next(from, (message) => message.type === "result", 15_000);
    return { asked: false, childAnswered: false, childQuestionUnavailable: unavailable,
      parentCompleted: result?.subtype === "success", resultSubtype: result?.subtype, isError: result?.is_error };
  },
});

await writeFile(path.join(output, "report.json"), `${JSON.stringify({ command: path.basename(command), reports }, null, 2)}\n`);
console.log(`report: ${path.join(output, "report.json")}`);
