import type { ProviderLoginEvent, ProviderLoginInteraction, ProviderLoginPrompt } from "../../packages/oar/src/contracts/provider-auth.js";

/** A login interaction that records what the driver showed and answers prompts from a script. */
export interface RecordedInteraction extends ProviderLoginInteraction {
  readonly events: ProviderLoginEvent[];
  readonly prompts: ProviderLoginPrompt[];
}

/**
 * Each prompt takes the next answer: a string resolves it, `"never"` leaves
 * it open (the person never answers), an Error rejects it. `onPrompt` runs
 * as each prompt opens.
 */
export function recordedInteraction(
  answers: readonly (string | Error)[],
  options: { readonly signal?: AbortSignal; readonly onPrompt?: (prompt: ProviderLoginPrompt) => void } = {},
): RecordedInteraction {
  const events: ProviderLoginEvent[] = [];
  const prompts: ProviderLoginPrompt[] = [];
  return {
    events,
    prompts,
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    onEvent(event) {
      events.push(event);
    },
    async prompt(prompt) {
      prompts.push(prompt);
      options.onPrompt?.(prompt);
      const answer = answers[prompts.length - 1] ?? "never";
      if (answer instanceof Error) {
        throw answer;
      }
      if (answer === "never") {
        await Promise.withResolvers<never>().promise;
      }
      return answer;
    },
  };
}
