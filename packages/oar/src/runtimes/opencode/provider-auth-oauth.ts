import type { ProviderLoginInteraction } from "../../contracts/provider-auth.js";
import { asNumber, asRecord } from "../../shared/json.js";
import type { LoginSecrets } from "../../shared/login.js";
import { OpencodeProviderAuthError } from "./provider-auth-error.js";
import { ask, askForm, eitherSignal } from "./provider-auth-prompts.js";
import { deviceCodeOf, type OpencodeIntegration } from "./provider-auth-registry.js";
import { nativeDetail, type ApiCall } from "./provider-auth-server.js";

export interface OauthFlow {
  readonly call: ApiCall;
  readonly integration: OpencodeIntegration;
  readonly interaction: ProviderLoginInteraction;
  readonly secrets: LoginSecrets;
  readonly timeoutMs: number;
  readonly pollMs: number;
}

/** `Integration.AttemptEncoded`, reduced to what the flow reads. */
interface Attempt {
  readonly attemptID: string;
  readonly url: string;
  readonly instructions: string;
  /** `code`: the person pastes a code back; `paste`: an `auto` attempt that also accepts one. */
  readonly takesCode: boolean;
  readonly expiresInSeconds?: number;
}

function attemptOf(body: unknown): Attempt | undefined {
  const data = asRecord(asRecord(body)?.data);
  const time = asRecord(data?.time);
  const created = asNumber(time?.created);
  const expires = asNumber(time?.expires);
  if (data === null || typeof data.attemptID !== "string" || typeof data.url !== "string") {
    return undefined;
  }
  return {
    attemptID: data.attemptID,
    url: data.url,
    instructions: typeof data.instructions === "string" ? data.instructions : "",
    takesCode: data.mode === "code" || data.paste === true,
    ...(created === null || expires === null ? {} : { expiresInSeconds: Math.round((expires - created) / 1000) }),
  };
}

async function chooseMethod(flow: OauthFlow): Promise<{ readonly id: string; readonly form: Parameters<typeof askForm>[1] }> {
  const { integration, interaction } = flow;
  const methods = integration.methods.flatMap((entry) => (entry.type === "oauth" ? [entry] : []));
  const [only] = methods;
  if (only === undefined) {
    throw new OpencodeProviderAuthError("method_unavailable", `OpenCode offers no OAuth sign-in for ${integration.id}`);
  }
  if (methods.length === 1) {
    return only;
  }
  const choice = await ask(interaction, {
    ...(interaction.signal === undefined ? {} : { signal: interaction.signal }),
    kind: "select",
    message: `Sign in to ${integration.name}`,
    options: methods.map((entry) => ({ id: entry.id, label: entry.label ?? entry.id })),
  });
  const chosen = methods.find((entry) => entry.id === choice);
  if (chosen === undefined) {
    throw new OpencodeProviderAuthError("method_unavailable", `${integration.id} has no OAuth method ${JSON.stringify(choice)}`);
  }
  return chosen;
}

/** Tell the host what to open: a device code when the instructions carry one, else the URL. */
function announce(flow: OauthFlow, attempt: Attempt): void {
  const userCode = deviceCodeOf(attempt.instructions);
  const expiry = attempt.expiresInSeconds === undefined ? {} : { expiresInSeconds: attempt.expiresInSeconds };
  flow.interaction.onEvent(userCode === undefined
    ? { kind: "auth_url", url: attempt.url, ...(attempt.instructions === "" ? {} : { instructions: attempt.instructions }) }
    : { kind: "device_code", userCode, verificationUri: attempt.url, ...expiry });
}

/** One status read: true once complete; throws on failed, expired or a vanished attempt. */
async function finished(flow: OauthFlow, path: string): Promise<boolean> {
  const response = await flow.call("GET", path);
  const data = asRecord(asRecord(response.body)?.data);
  if (response.status !== 200 || data === null) {
    throw new OpencodeProviderAuthError("rejected", `OpenCode lost the sign-in attempt (${nativeDetail(response, flow.secrets)})`, response.status);
  }
  switch (data.status) {
    case "complete":
      return true;
    case "failed":
      throw new OpencodeProviderAuthError("rejected", `OpenCode reports the sign-in failed${typeof data.message === "string" ? `: ${flow.secrets.line(data.message)}` : ""}`);
    case "expired":
      throw new OpencodeProviderAuthError("expired", `the ${flow.integration.id} sign-in attempt expired`);
    default:
      return false;
  }
}

/** Relay the pasted code to `integration.oauth.complete`; the code is a secret from here on. */
async function pasteCode(flow: OauthFlow, attempt: Attempt, path: string, signal: AbortSignal | undefined): Promise<void> {
  const code = await ask(flow.interaction, {
    ...(signal === undefined ? {} : { signal }),
    kind: "manual_code",
    message: attempt.instructions === "" ? "Paste the authorization code" : attempt.instructions,
  });
  const pasted = code.trim();
  flow.secrets.add(pasted);
  const response = await flow.call("POST", `${path}/complete`, { code: pasted });
  if (response.status >= 300) {
    throw new OpencodeProviderAuthError("rejected", `OpenCode refused the pasted code (${nativeDetail(response, flow.secrets)})`, response.status);
  }
}

/**
 * Wait for the attempt: poll its status, and, when it takes a pasted code,
 * prompt for one alongside. Ends at completion, failure, expiry, the deadline
 * or the caller's abort (which rejects with the signal's reason).
 */
async function wait(flow: OauthFlow, attempt: Attempt, path: string): Promise<void> {
  const { interaction, timeoutMs, pollMs } = flow;
  const outcome = Promise.withResolvers<void>();
  const stop = new AbortController();
  const fail = (error: unknown): void => { if (!stop.signal.aborted) { outcome.reject(error); } };
  const timer = setTimeout(() => { fail(new OpencodeProviderAuthError("timed_out", `no ${flow.integration.id} sign-in within ${String(timeoutMs)} ms`)); }, timeoutMs);
  const onAbort = (): void => { fail(interaction.signal?.reason); };
  interaction.signal?.addEventListener("abort", onAbort, { once: true });
  if (attempt.takesCode) {
    void (async (): Promise<void> => {
      try {
        await pasteCode(flow, attempt, path, eitherSignal(interaction.signal, stop.signal));
      } catch (error) {
        fail(error);
      }
    })();
  }
  void (async (): Promise<void> => {
    try {
      while (!stop.signal.aborted) {
        if (await finished(flow, path)) {
          outcome.resolve();
          return;
        }
        await new Promise((resolve) => { setTimeout(resolve, pollMs); });
      }
    } catch (error) {
      fail(error);
    }
  })();
  try {
    interaction.signal?.throwIfAborted();
    await outcome.promise;
  } finally {
    stop.abort();
    clearTimeout(timer);
    interaction.signal?.removeEventListener("abort", onAbort);
  }
}

/** Run one OAuth sign-in through OpenCode's own attempt; any unfinished attempt is cancelled. */
export async function runOauth(flow: OauthFlow): Promise<void> {
  const { call, integration, interaction, secrets } = flow;
  const method = await chooseMethod(flow);
  const answer = await askForm(interaction, method.form, interaction.signal);
  interaction.signal?.throwIfAborted();
  const base = `/api/integration/${encodeURIComponent(integration.id)}/connect/oauth`;
  const response = await call("POST", base, { methodID: method.id, ...(Object.keys(answer).length === 0 ? {} : { answer }) });
  const attempt = response.status === 200 ? attemptOf(response.body) : undefined;
  if (attempt === undefined) {
    throw new OpencodeProviderAuthError("rejected", `OpenCode did not start the ${integration.id} sign-in (${nativeDetail(response, secrets)})`, response.status);
  }
  const path = `${base}/${encodeURIComponent(attempt.attemptID)}`;
  let complete = false;
  try {
    announce(flow, attempt);
    await wait(flow, attempt, path);
    complete = true;
  } finally {
    if (!complete) {
      // integration.oauth.cancel answers 204 even for an attempt it no longer has.
      try {
        await call("DELETE", path);
      } catch {
        // The flow's own error is the one to report.
      }
    }
  }
}
