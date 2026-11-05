import type { AgentSession, PromptOptions } from "@earendil-works/pi-coding-agent";
import type { ResponseBody } from "../../contracts/session.js";

/** Native settlement callbacks cannot admit a new run until Pi leaves its emitter. */
export async function admitPiPrompt(
  session: Pick<AgentSession, "prompt">, input: string, options: PromptOptions,
  waiters: Set<() => void>, unavailable: () => ResponseBody | null,
): Promise<{ run: Promise<void>; response: ResponseBody; started: boolean }> {
  // Pi resolves prompt() immediately while emitting agent_settled, then runs
  // it later on the old prompt's promise. Leave that native deferred path.
  await Promise.resolve();
  const blocked = unavailable();
  if (blocked !== null) { return { run: Promise.resolve(), response: blocked, started: false }; }
  let started = false;
  let handled = false;
  const admission = Promise.withResolvers<ResponseBody>();
  const onStarted = (): void => { started = true; admission.resolve({ kind: "accepted" }); };
  waiters.add(onStarted);
  const run = session.prompt(input, { ...options, preflightResult: disposition => { handled = disposition === "handled"; } });
  const response = await Promise.race([
    admission.promise,
    run.then<ResponseBody, ResponseBody>(
      () => started || handled ? { kind: "accepted" }
        : { kind: "rejected", code: "runtime_refused", reason: "Pi completed prompt dispatch without reporting a started or handled input" },
      (error: unknown) => ({ kind: "rejected", code: "runtime_refused", reason: error instanceof Error ? error.message : "pi prompt failed" }),
    ),
  ]);
  waiters.delete(onStarted);
  return { run, response, started };
}
