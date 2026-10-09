import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ModelThinkingLevel, Models } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import { AgentDoc, LiveDoc, configure, type AgentChange, type AgentState, type Conversation, type ConversationId, type Harness } from "@earendil-works/pi-durable";
import { RuntimeFailureError } from "../../contracts/runtime-failure-error.js";
import type { RefusedSessionOptions } from "../../contracts/runtime.js";
import type { SessionOptions } from "../../contracts/session.js";
import { refuseSessionOptions } from "../../shared/session-options.js";

export const piDurableRefusedSessionOptions: RefusedSessionOptions = {
  systemPrompt: "pi-durable instructions append to extension sections; there is no system-prompt replacement channel",
  env: "The host owns the Harness execution environment",
  launchArgs: "pi-durable has no child process to configure",
  serviceTier: "pi-durable exposes no per-conversation service tier",
  mcpServers: "pi-durable has no verified per-conversation MCP attachment channel",
  disallowedTools: "pi-durable tool filtering has not been verified through this adapter",
};

function conversationId(value: number): value is ConversationId {
  return Number.isSafeInteger(value) && value > 0;
}

function thinkingLevel(value: string): value is ModelThinkingLevel {
  return ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function agentChange(options: SessionOptions, models: Models): AgentChange {
  const slash = options.model?.indexOf("/") ?? -1;
  const model = options.model === undefined ? undefined : models.getModel(options.model.slice(0, slash), options.model.slice(slash + 1));
  if (options.model !== undefined && (slash < 1 || model === undefined)) {
    throw new RuntimeFailureError("model_unavailable", `pi-durable model ${options.model} is not registered; use provider/model from listModels`);
  }
  if (options.effort !== undefined && !thinkingLevel(options.effort)) {
    throw new Error(`pi-durable does not support effort ${options.effort}`);
  }
  return {
    cwd: options.cwd,
    ...(model === undefined ? {} : { model: { provider: model.provider, modelId: model.id } }),
    ...(options.effort === undefined ? {} : { thinkingLevel: options.effort }),
    ...(options.appendSystemPrompt === undefined ? {} : { instructions: options.appendSystemPrompt }),
  };
}

async function resumeConversation(harness: Harness, id: string): Promise<Conversation> {
  const number = Number(id);
  const found = conversationId(number) && String(number) === id ? await harness.conversation(number, BACKGROUND_CONTEXT) : undefined;
  if (found === undefined) { throw new Error(`pi-durable conversation ${id} does not exist`); }
  return found;
}

function validateEffort(agent: AgentState, models: Models, options: SessionOptions): void {
  if (options.effort === undefined) { return; }
  const model = agent.model === undefined ? undefined : models.getModel(agent.model.provider, agent.model.modelId);
  if (model === undefined || !getSupportedThinkingLevels(model).some((level) => level === options.effort)) {
    throw new Error(`pi-durable model ${options.model ?? agent.model?.modelId ?? "(unset)"} does not support effort ${options.effort}`);
  }
}

function changedOptions(before: AgentState, change: AgentChange): boolean {
  const keys: readonly ("model" | "thinkingLevel" | "instructions" | "cwd")[] = ["model", "thinkingLevel", "instructions", "cwd"];
  return keys.some((key) => change[key] !== undefined && JSON.stringify(before[key]) !== JSON.stringify(change[key]));
}

async function configureResume(conversation: Conversation, change: AgentChange, models: Models, options: SessionOptions): Promise<void> {
  await conversation.commit(async (tx) => {
    const before = await tx.doc(AgentDoc, conversation.id);
    const live = await tx.doc(LiveDoc, conversation.id);
    // Only scalar/model fields are supplied by agentChange. Use the native
    // configure operation and validate within its transaction, so a refusal
    // cannot leave shared conversation settings half changed.
    if (live.run !== undefined && changedOptions(before, change)) {
      throw new Error("pi-durable cannot change options while adopting an active run; reopen with its saved settings");
    }
    await configure(tx, conversation.id, change);
    validateEffort(await tx.doc(AgentDoc, conversation.id), models, options);
  }, BACKGROUND_CONTEXT);
}

export async function openConversation(harness: Harness, models: Models, options: SessionOptions): Promise<Conversation> {
  refuseSessionOptions(piDurableRefusedSessionOptions, options);
  const change = agentChange(options, models);
  const conversation = options.resume === undefined
    ? await harness.createConversation({ ownership: { kind: "ownerless" }, agent: change,
      init: async (tx, id) => { validateEffort(await tx.doc(AgentDoc, id), models, options); } }, BACKGROUND_CONTEXT)
    : await resumeConversation(harness, options.resume);
  if (options.resume !== undefined) { await configureResume(conversation, change, models, options); }
  const agent = await conversation.agent(BACKGROUND_CONTEXT);
  if (options.effort !== undefined && agent.thinkingLevel !== options.effort) { throw new Error(`pi-durable reported effort ${agent.thinkingLevel}, requested ${options.effort}`); }
  if (options.model !== undefined && `${agent.model?.provider}/${agent.model?.modelId}` !== options.model) { throw new Error(`pi-durable did not select model ${options.model}`); }
  return conversation;
}
