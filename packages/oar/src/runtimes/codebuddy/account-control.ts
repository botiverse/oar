import { randomUUID } from "node:crypto";
import { asRecord, parseJson, type JsonRecord } from "../../shared/json.js";
import { LoginSecrets, spawnLoginProcess, type LoginProcess } from "../../shared/login.js";

/** Initialize and authentication replies carry access tokens. This process has no record or log sink. */
export interface CodebuddyAccountControl {
  readonly process: LoginProcess;
  readonly secrets: LoginSecrets;
  request(request: JsonRecord): Promise<JsonRecord>;
}

export class CodebuddyAccountRefusalError extends Error {
  constructor(message: string) { super(message); this.name = "CodebuddyAccountRefusalError"; }
}

function exitedError(): Error { return new Error("CodeBuddy exited before answering its account query"); }

function rememberSecrets(value: unknown, secrets: LoginSecrets): void {
  if (Array.isArray(value)) { for (const item of value) { rememberSecrets(item, secrets); } return; }
  const record = asRecord(value);
  if (record === null) { return; }
  for (const [key, item] of Object.entries(record)) {
    if (typeof item === "string" && /token|secret|password|api.?key|authUrl|^state$|email|^uid$|^userId$|nickname|enterpriseName|enterpriseId|^username$|^displayName$/iu.test(key)) { secrets.add(item); }
    else if (typeof item === "object") { rememberSecrets(item, secrets); }
  }
}

export function codebuddyAccountControl(
  command: string,
  env: NodeJS.ProcessEnv,
  callback: (request: JsonRecord) => void = () => {},
): CodebuddyAccountControl {
  const secrets = new LoginSecrets();
  const pending = new Map<string, ReturnType<typeof Promise.withResolvers<JsonRecord>>>();
  const child = spawnLoginProcess(command, ["--print", "--input-format", "stream-json", "--output-format", "stream-json"], env, {
    onLine(line, stream) {
      if (stream !== "stdout") { return; }
      const frame = asRecord(parseJson(line));
      if (frame === null) { return; }
      rememberSecrets(frame, secrets);
      const response = asRecord(frame.response);
      if (frame.type === "control_response" && typeof response?.request_id === "string") {
        const waiting = pending.get(response.request_id);
        if (waiting === undefined) { return; }
        pending.delete(response.request_id);
        if (response.subtype === "success") { waiting.resolve(asRecord(response.response) ?? {}); }
        else { waiting.reject(new CodebuddyAccountRefusalError(typeof response.error === "string" ? secrets.line(response.error) : "CodeBuddy refused the control request")); }
      } else if (frame.type === "control_request") {
        const request = asRecord(frame.request);
        if (request !== null) { callback(request); }
      }
    },
  });
  let exited = false;
  // oxlint-disable-next-line promise/prefer-await-to-then -- exit notification rejects all pending calls
  void child.exited.then(() => {
    exited = true;
    for (const waiting of pending.values()) { waiting.reject(exitedError()); }
    pending.clear();
    return null;
  });
  return {
    process: child, secrets,
    async request(request) {
      if (exited) { throw exitedError(); }
      const id = `oar-account-${randomUUID()}`;
      const waiting = Promise.withResolvers<JsonRecord>();
      pending.set(id, waiting);
      child.write(`${JSON.stringify({ type: "control_request", request_id: id, request })}\n`);
      const response = await waiting.promise;
      return response;
    },
  };
}
