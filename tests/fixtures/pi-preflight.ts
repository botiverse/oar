/* oxlint-disable max-statements, max-lines-per-function -- The fixture holds native preflight, settlement and replies independently. */
import type { PromptOptions, RpcCommand, RpcResponse } from "@earendil-works/pi-coding-agent";
import { fakeLineProcess } from "./fake-line-process.js";

const noop = (): void => {};

type Dispatch = "start" | "handled" | "refused";
/** Pi's preflight can await extensions, and prompt during settlement resolves before its deferred work. */
export default function piPreflightFixture() {
  const prompts: string[] = [];
  const commandTypes: string[] = [];
  const gates = new Map<string, PromiseWithResolvers<Dispatch>>();
  const runs: PromiseWithResolvers<void>[] = [];
  const deferred: (() => Promise<void>)[] = [];
  const child = fakeLineProcess();
  let emit: (event: Record<string, unknown>) => void = noop;
  let settling = false;
  let aborts = 0;
  let deferrals = 0;
  let idle = Promise.withResolvers<void>();
  const statsEntered = Promise.withResolvers<void>();
  let stats: PromiseWithResolvers<RpcResponse> | undefined = undefined;
  const begin = (): void => { sdk.isStreaming = true; emit({ type: "agent_start" }); };
  const settled = (aborted = false): void => {
    settling = true;
    try { emit({ type: "agent_settled", aborted }); }
    finally { settling = false; }
  };
  const end = (finishPrompt = true): void => {
    sdk.isStreaming = false;
    emit({ type: "agent_end", messages: [] });
    settled();
    const run = runs.at(-1);
    // A native prompt includes the deferred settlement actions, not only the
    // emitted boundary. Resolve its promise only after those actions finish.
    void (async () => {
      try {
        for (const action of deferred.splice(0)) {
          // oxlint-disable-next-line no-await-in-loop -- Pi awaits deferred actions sequentially.
          await action();
        }
        if (finishPrompt) { run?.resolve(); }
      }
      catch (error) { run?.reject(error); }
      finally { if (!sdk.isStreaming) { idle.resolve(); idle = Promise.withResolvers<void>(); } }
    })();
  };
  const sdk = {
    sessionId: "preflight", thinkingLevel: "off", model: undefined, isStreaming: false,
    extensionRunner: { emit: async (): Promise<void> => {} }, getContextUsage: () => undefined,
    subscribe(listener: typeof emit) { emit = listener; return () => {}; },
    async prompt(input: string, options?: PromptOptions) {
      if (settling) { deferrals += 1; deferred.push(async () => sdk.prompt(input, options)); return; }
      prompts.push(input);
      const outcome = await (gates.get(input)?.promise ?? Promise.resolve("start"));
      if (outcome === "refused") { throw new Error(`native preflight refused ${input}`); }
      if (outcome === "handled") { options?.preflightResult?.("handled"); return; }
      const run = Promise.withResolvers<void>(); runs.push(run);
      options?.preflightResult?.("started"); begin(); await run.promise;
    },
    async waitForIdle() { if (sdk.isStreaming) { await idle.promise; } },
    async abort() { aborts += 1; sdk.isStreaming = false; settled(true); runs.at(-1)?.resolve(); idle.resolve(); idle = Promise.withResolvers<void>(); },
    dispose() {},
  };
  const rpc = (receive: typeof emit) => {
    emit = receive;
    const state = { sessionId: "preflight", thinkingLevel: "off", isStreaming: false, isCompacting: false,
      steeringMode: "all", followUpMode: "all", autoCompactionEnabled: true, messageCount: 0, pendingMessageCount: 0 } as const;
    let sequence = 0;
    const respond = async (command: RpcCommand): Promise<RpcResponse> => {
        if (command.type === "get_state") { return { type: "response", command: "get_state", success: true, data: { ...state, isStreaming: sdk.isStreaming } }; }
        if (command.type === "get_session_stats" && stats !== undefined) { statsEntered.resolve(); return stats.promise; }
        if (command.type === "abort") { return { type: "response", command: "abort", success: true }; }
        if (command.type !== "prompt") { return { type: "response", command: command.type, success: false, error: "fixture has no stats" }; }
        prompts.push(command.message);
        const outcome = await (gates.get(command.message)?.promise ?? Promise.resolve("start"));
        if (outcome === "refused") { return { type: "response", command: "prompt", success: false, error: `native preflight refused ${command.message}` }; }
        return { type: "response", command: "prompt", success: true, data: { disposition: outcome === "start" ? "started" : "handled" } };
    };
    return {
      child, directory: { path: "/fixture", remove() {} }, state,
      control: { request: async (command: RpcCommand, issued?: (id: string) => void): Promise<RpcResponse> => {
        commandTypes.push(command.type);
        const id = `fixture-${sequence++}`;
        issued?.(id);
        const response = { ...await respond(command), id };
        receive(response);
        if (response.success && response.command === "prompt" && response.data.disposition === "started") { begin(); }
        return response;
      } },
    };
  };
  return { sdk, rpc, prompts, commandTypes, runs, child, begin, end, settled, emit: (event: Record<string, unknown>) => { emit(event); },
    aborts: () => aborts, deferrals: () => deferrals,
    hold(input: string) { const gate = Promise.withResolvers<Dispatch>(); gates.set(input, gate); return gate; },
    holdStats() { stats = Promise.withResolvers<RpcResponse>(); return { reply: stats, entered: statsEntered.promise }; },
    release() { for (const run of runs) { run.resolve(); } child.end(0); },
  };
}
