/* oxlint-disable import/max-dependencies -- Claude composes launch, stream-json, model-request, settings and question machinery. */
import { openClaudeModelRequests } from "./model-requests.js";
import { claudeCompaction, CLAUDE_COMPACTION_BUSY } from "./compaction.js";
import type { StartSession } from "../../contracts/session.js";
import type { JsonRecord } from "../../shared/json.js";
import { withSessionCredentials } from "../../shared/session-credentials.js";
import { refuseSessionOptions } from "../../shared/session-options.js";
import { streamJsonSession } from "../../shared/stream-json/session.js";
import { claudeOpenSettings } from "./open-settings.js";
import { claudeQuestionReply as claudeLegacyQuestionReply, claudeUserQuestionRefusal } from "./user-questions.js";
import { closeLineProcess } from "../../shared/executable/close.js";
import { claudeContextBreakdownReader } from "./context-breakdown.js";
import { launchClaude } from "./launch.js";
import { claudeProjectionProfile, claudeUsageBaselined, initialClaudeProjection, resumedClaudeProjection } from "./projection.js";
import { createQuestionAnswers, type QuestionAnswers } from "../../shared/app-request-questions.js";
import type { AnswerOptions, HostQuestionAnswer, QuestionAnswerOutcome } from "../../contracts/answer.js";
import { questionRefusal } from "../../shared/app-request-outcome.js";
import { asAppQuestionAnswers } from "../../shared/host-question-answer.js";
import { claudeApprovalDeny, claudeQuestion, claudeQuestionReply as claudeHostQuestionReply } from "./questions.js";

/**
 * Either answer dialect through the "ask" channel. This channel writes answers,
 * never a decline: the release dialect's "no" has no reply here, so it is
 * refused with a reason instead of being written as an answer nobody gave.
 */
// oxlint-disable-next-line typescript/require-await -- One settled answer: a refusal is already settled, the store's answer is a promise, and the contract is asynchronous like every control.
async function answerAskChannel(store: QuestionAnswers, requestId: string, answer: HostQuestionAnswer, options?: AnswerOptions): Promise<QuestionAnswerOutcome> {
  const normalized = asAppQuestionAnswers(answer);
  return typeof normalized === "string" ? questionRefusal(requestId, "unsupported", normalized) : store.answer(requestId, normalized, options);
}

/** Decline unattended MCP elicitations as Claude's Agent SDK does when no handler is set; leave other control requests unanswered. */
export function claudeAppRequestResponse(type: string, requestId: string): {
  readonly type: "control_response";
  readonly response: { readonly subtype: "success"; readonly request_id: string; readonly response: { readonly action: "decline" } };
} | null {
  return type === "elicitation"
    ? { type: "control_response", response: { subtype: "success", request_id: requestId, response: { action: "decline" } } }
    : null;
}

/** Claude owns launch flags, private account/settings readbacks and usage baselines. */
export const claudeSession: StartSession = withSessionCredentials(async (installation, options, credentials) => {
  if (installation.via !== "executable") {
    throw new Error("The claude session adapter needs an executable installation");
  }
  refuseSessionOptions(claudeUserQuestionRefusal(installation.version), options);
  // A fork (SessionOptions.fork) runs under a new id OAR assigns, like a new session.
  const sessionId = options.fork === undefined ? options.resume ?? globalThis.crypto.randomUUID() : globalThis.crypto.randomUUID();
  const requests = await openClaudeModelRequests(sessionId, options, installation.version);
  const child = await launchClaude(installation.command, sessionId, options, requests?.setting).catch((error: unknown) => { requests?.remove(); throw error; });
  if (requests !== undefined) { child.onExit(requests.remove); }
  const readback = claudeOpenSettings(child);
  const contextBreakdown = claudeContextBreakdownReader(child);
  const compaction = claudeCompaction(child);
  const kernel = credentials.kernel(sessionId);
  // `questions: "ask"` turns claude's own gate on for its question tool. OAR
  // grants NO tool approval through it: a non-question `can_use_tool` is denied
  // natively and recorded, so a host answer here can never widen permission.
  const questionAnswers = options.questions === "ask" ? createQuestionAnswers({
    kernel,
    deliver: (request, answers) => {
      const question = request.body.kind === "native" ? claudeQuestion(request.body.native) : null;
      if (question === null) { throw new Error("the recorded request is not a claude question"); }
      const reply = claudeHostQuestionReply(request.id, question, answers);
      child.write(`${JSON.stringify(reply)}\n`);
      return { reply };
    },
  }) : undefined;
  const session = await streamJsonSession(child, sessionId, credentials, {
    projection: claudeProjectionProfile,
    initial: options.resume === undefined ? initialClaudeProjection : resumedClaudeProjection,
    kernel,
    ...(questionAnswers === undefined ? {} : {
      appRequest: (id: string, type: string, native: unknown): boolean => {
        if (type !== "can_use_tool") { return false; }
        if (claudeQuestion(native) !== null) { questionAnswers.request(id, type, native); return true; }
        const reply = claudeApprovalDeny(id);
        kernel.request("toApp", { kind: "native", type, native }, { id });
        child.write(`${JSON.stringify(reply)}\n`);
        kernel.respond(id, { kind: "answered", native: reply });
        return true;
      },
      answerQuestion: answerAskChannel.bind(null, questionAnswers),
    }),
    capabilities: { queue: { durable: false }, attribution: "attributed", images: true, ...(questionAnswers === undefined ? {} : { appRequests: questionAnswers.capability }) },
    steer: true,
    stopTask: (taskId) => ({ subtype: "stop_task", task_id: taskId }),
    compaction: { busyReason: CLAUDE_COMPACTION_BUSY, create: compaction.create },
    cancelQueuedCapability: "interrupt_cancel_queued_v1",
    consume: (message) => {
      requests?.observe(message);
      return readback.consume(message) || contextBreakdown.consume(message) || compaction.consume(message);
    },
    ...(requests === undefined ? {} : { lastModelRequest: requests.read }),
    open: async (projection) => {
      await readback.confirm(options, requests);
      // Both a plain resume (which Claude can otherwise resolve by --name title
      // to a different session's UUID) and a fork must run under sessionId.
      if (options.resume !== undefined) { await readback.confirmSessionId(sessionId, options); }
      if (options.resume !== undefined) {
        projection.replace(claudeUsageBaselined(projection.current(), await readback.usageBaseline()));
      }
    },
    exited: (code) => { readback.exited(code); contextBreakdown.exited(); compaction.close(); },
    disposing: () => { requests?.close(); contextBreakdown.exited(); compaction.close(); questionAnswers?.close("disposed"); },
    contextBreakdown: contextBreakdown.read,
    close: async (active) => { if (active) { child.kill(); await child.exited; } else { await closeLineProcess(child); } },
    // Unattended MCP elicitations are declined as claude's own SDK does when no
    // handler is set (v0.132). With `userQuestions: "host"` bypass permissions
    // stay on, so a tool that still asks (its own hook's "ask") is denied here:
    // nobody in this session approves anything.
    appRequestResponse: options.userQuestions === "host"
      ? (type: string, requestId: string): JsonRecord | null => type === "can_use_tool" ? claudeApprovalDeny(requestId) : claudeAppRequestResponse(type, requestId)
      : claudeAppRequestResponse,
    ...(options.userQuestions === "host" ? { questionReply: claudeLegacyQuestionReply } : {}),
  });
  if (requests !== undefined) {
    session.events((event) => { if (event.agentPath.length === 0 && event.kind === "turn_ended") { requests.ended(event.outcome); } });
  }
  return session;
});
