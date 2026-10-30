import type { SessionOpenContext, SessionPlacement } from "../contracts/placement.js";
import type { AvailableInstallation } from "../contracts/installation.js";
import type { AdapterSession, Session, SessionOptions, StartSession } from "../contracts/session.js";
import { sessionCredentialRedactor, type CredentialRedactor } from "./credential-redactor.js";
import { sealSession } from "./seal-session.js";
import { createSessionKernel, type SessionKernel } from "./session-kernel.js";

export interface SessionCredentials extends CredentialRedactor {
  kernel(id: string, extraRedact?: <T>(value: T) => T): SessionKernel;
  seal(adapter: AdapterSession, extraRedact?: <T>(value: T) => T): Session;
}

function guard<Args extends unknown[], Result>(method: (...args: Args) => Promise<Result>, clean: <T>(value: T) => T): (...args: Args) => Promise<Result> {
  return async (...args) => {
    try { return await method(...args); } catch (error) { throw clean(error); }
  };
}

/** Credentials supplied for this session, plus native keys the adapter resolves. No inherited environment or credential-file scan. */
function sessionCredentials(options: SessionOptions, context: SessionOpenContext): SessionCredentials {
  const { add, redact, redactValue, values } = sessionCredentialRedactor(options);
  return {
    add,
    values,
    redact,
    redactValue,
    kernel: (id, extraRedact) => { const kernel = createSessionKernel(id, extraRedact ?? redactValue); kernel.opened(context); return kernel; },
    seal: (adapter, clean = redactValue) => sealSession({
      ...adapter,
      ...(adapter.goal === undefined ? {} : { goal: {
        set: guard(adapter.goal.set.bind(adapter.goal), clean),
        read: guard(adapter.goal.read.bind(adapter.goal), clean),
        clear: guard(adapter.goal.clear.bind(adapter.goal), clean),
      } }),
      prompt: guard(adapter.prompt.bind(adapter), clean),
      queue: guard(adapter.queue.bind(adapter), clean),
      ...(adapter.steer === undefined ? {} : { steer: guard(adapter.steer.bind(adapter), clean) }),
      ...(adapter.withdraw === undefined ? {} : { withdraw: guard(adapter.withdraw.bind(adapter), clean) }),
      abort: guard(adapter.abort.bind(adapter), clean),
      dispose: guard(adapter.dispose.bind(adapter), clean),
      ...(adapter.contextBreakdown === undefined ? {} : { contextBreakdown: guard(adapter.contextBreakdown.bind(adapter), clean) }),
      ...(adapter.resources === undefined ? {} : { resources: guard(adapter.resources.bind(adapter), clean) }),
    }),
  };
}

/** Keep opening failures and later adapter errors under the same session credential rules as the record stream. */
export function withSessionCredentials(open: (installation: AvailableInstallation, options: SessionOptions, credentials: SessionCredentials, context: SessionOpenContext) => Promise<Session>, placement: SessionPlacement = "isolated"): StartSession {
  return async (installation, options, context) => {
    const selected = context ?? { requested: "auto", placement };
    const credentials = sessionCredentials(options, selected);
    try { return await open(installation, options, credentials, selected); }
    catch (error) { throw credentials.redactValue(error); }
  };
}
