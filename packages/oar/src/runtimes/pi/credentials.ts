import type { ExtensionFactory, ModelRegistry } from "@earendil-works/pi-coding-agent";

/** Resolve only the selected model through the SDK's auth API. OAR never opens credential files. */
export async function rememberPiKey(registry: ModelRegistry, model: Parameters<ModelRegistry["getApiKeyAndHeaders"]>[0] | undefined, add: (key: string | undefined) => void): Promise<void> {
  if (model === undefined) { return; }
  const auth = await registry.getApiKeyAndHeaders(model);
  if (auth.ok) { add(auth.apiKey); }
}

/** Pi awaits model_select before returning from a model change, before its next provider request. */
export function piCredentialExtension(add: (key: string | undefined) => void): ExtensionFactory {
  return (pi) => {
    pi.on("model_select", async (event, context) => { await rememberPiKey(context.modelRegistry, event.model, add); });
  };
}
