import type { RuntimeDefinition, RuntimeInstallDefinition } from "./definition.js";
import { commandAttempts } from "../discovery/install/attempts.js";

export interface CommandRuntimeDefinitionInput {
  readonly id: string;
  readonly commands: readonly string[];
  readonly compatibility?: RuntimeInstallDefinition["compatibility"];
  readonly createDriver: RuntimeDefinition["createDriver"];
}

/** Define one command-backed runtime without repeating install plumbing. */
export function defineCommandRuntime(
  input: CommandRuntimeDefinitionInput,
): RuntimeDefinition {
  return {
    id: input.id,
    install: {
      attempts: commandAttempts(input.commands),
      ...(input.compatibility ? { compatibility: input.compatibility } : {}),
    },
    createDriver: input.createDriver,
  };
}
