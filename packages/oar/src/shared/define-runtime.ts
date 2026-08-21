import type { RunResult, Runtime, RuntimeSpec } from "../contracts/runtime.js";
import type { SessionOptions } from "../contracts/session.js";

/**
 * Derive the API face of a Runtime from what a runtime module declares.
 * `run` is the business-embedding facade: probe → ephemeral session → one
 * turn → collected text → dispose — pure composition over `session`.
 */
export function defineRuntime<const T extends RuntimeSpec>(spec: T): T & Pick<Runtime, "run"> {
  const run = async (prompt: string, options: SessionOptions): Promise<RunResult> => {
    if (spec.installation === undefined) {
      throw new Error(`${spec.id} has no installation capability to probe`);
    }
    const installation = await spec.installation();
    if (installation.kind !== "available") {
      throw new Error(`${spec.id} is not available: ${installation.kind}`);
    }
    const session = await spec.session(installation, options);
    const texts: string[] = [];
    session.subscribe((event) => {
      if (event.kind === "text_delta") {
        texts.push(event.text);
      }
    });
    const result = session.prompt(prompt);
    if (result.kind !== "turn") {
      await session.dispose();
      throw new Error("fresh session reported busy");
    }
    const outcome = await result.turn.outcome;
    await session.dispose();
    return { sessionId: session.id, outcome, text: texts.join("") };
  };
  return { ...spec, run };
}
