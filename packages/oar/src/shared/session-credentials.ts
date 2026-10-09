import type { AvailableInstallation } from "../contracts/installation.js";
import type { AdapterSession, Session, SessionOptions, StartSession } from "../contracts/session.js";
import { sessionCredentialRedactor, type CredentialRedactor } from "./credential-redactor.js";
import { sealSession } from "./seal-session.js";
import { createSessionKernel, type SessionKernel } from "./session-kernel.js";

export interface SessionCredentials extends CredentialRedactor {
  kernel(id: string): SessionKernel;
  seal(adapter: AdapterSession): Session;
}

/** Credentials supplied for this session, plus native keys the adapter resolves. No inherited environment or credential-file scan. */
function sessionCredentials(options: SessionOptions): SessionCredentials {
  const { add, redact, redactValue } = sessionCredentialRedactor(options);
  const guard = <Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>): ((...args: Args) => Promise<Result>) =>
    async (...args) => {
      try { return await method(...args); } catch (error) { throw redactValue(error); }
    };
  return {
    add,
    redact,
    redactValue,
    kernel: (id) => createSessionKernel(id, redactValue),
    seal: (adapter) => sealSession({
      ...adapter,
      prompt: guard(adapter.prompt.bind(adapter)),
      queue: guard(adapter.queue.bind(adapter)),
      ...(adapter.steer === undefined ? {} : { steer: guard(adapter.steer.bind(adapter)) }),
      ...(adapter.withdraw === undefined ? {} : { withdraw: guard(adapter.withdraw.bind(adapter)) }),
      abort: guard(adapter.abort.bind(adapter)),
      dispose: guard(adapter.dispose.bind(adapter)),
      ...(adapter.contextBreakdown === undefined ? {} : { contextBreakdown: guard(adapter.contextBreakdown.bind(adapter)) }),
      ...(adapter.resources === undefined ? {} : { resources: guard(adapter.resources.bind(adapter)) }),
    }),
  };
}

/** Keep opening failures and later adapter errors under the same session credential rules as the record stream. */
export function withSessionCredentials(open: (installation: AvailableInstallation, options: SessionOptions, credentials: SessionCredentials) => Promise<Session>): StartSession {
  return async (installation, options) => {
    const credentials = sessionCredentials(options);
    try { return await open(installation, options, credentials); }
    catch (error) { throw credentials.redactValue(error); }
  };
}
