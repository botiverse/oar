import { userQuestionOf } from "../user-question-prompt.js";
import type { NativeReply, UserQuestions } from "../user-questions.js";
import type { StreamJsonSessionProfile } from "./profile.js";
import type { LineProcess } from "../executable/index.js";
import { asRecord, type JsonRecord } from "../json.js";
import type { SessionKernel } from "../session-kernel.js";

/** Record a native app request and, where supported, the dialect's automatic response; a question the host answers stays open instead. */
export function streamJsonAppRequest(
  kernel: SessionKernel,
  child: Pick<LineProcess, "write">,
  id: string,
  type: string,
  message: JsonRecord,
  profile: Pick<StreamJsonSessionProfile<never>, "appRequestResponse" | "questionReply">,
  questions?: UserQuestions,
): void {
  kernel.request("toApp", { kind: "native", type, native: message }, { id });
  const request = asRecord(message.request);
  const { appRequestResponse, questionReply } = profile;
  const prompt = questions === undefined || questionReply === undefined || request === null || typeof message.request_id !== "string" ? null : userQuestionOf(type, message);
  if (prompt !== null && questions !== undefined && questionReply !== undefined && request !== null) {
    questions.hold(id, prompt, (answer): NativeReply => {
      const reply = questionReply(id, request, answer);
      return { send: () => { child.write(`${JSON.stringify(reply)}\n`); }, recorded: reply };
    });
    return;
  }
  const reply = typeof message.request_id === "string" && request !== null
    ? appRequestResponse?.(type, message.request_id, request)
    : undefined;
  if (reply !== undefined && reply !== null) {
    child.write(`${JSON.stringify(reply)}\n`);
    kernel.respond(id, { kind: "answered", native: reply });
  }
}
