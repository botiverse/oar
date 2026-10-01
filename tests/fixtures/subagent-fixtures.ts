import assert from "node:assert/strict";
import { createSubagents, type Subagent, type Subagents, type SubagentsOptions } from "../../packages/oar/src/agents/index.js";
import type { Runtime } from "../../packages/oar/src/contracts/runtime.js";
import type { Session } from "../../packages/oar/src/contracts/session.js";
import { scriptedRuntime, type ScriptedTurn } from "../../packages/oar/src/testing/index.js";

export type Script = (turn: ScriptedTurn) => void | Promise<void>;

export function registryOf(runtime: Runtime): NonNullable<SubagentsOptions["runtimes"]> {
  return { get: (id) => (id === runtime.id ? runtime : undefined) };
}

export function crewOf(script: Script, options: Omit<SubagentsOptions, "runtimes"> = {}): Subagents {
  return createSubagents({ runtimes: registryOf(scriptedRuntime({ id: "fake", turn: script })), ...options });
}

export const echo: Script = (turn) => {
  turn.say(`did: ${turn.input}`);
};
/** A script whose turns stay open until the test releases them; a release before a turn waits counts for it. */
export class Gate {
  readonly #waiting: (() => void)[] = [];
  #permits = 0;
  started = 0;

  readonly script: Script = async (turn) => {
    this.started += 1;
    turn.say(`working on ${turn.input}`);
    await this.#pass();
    turn.say(` steered: ${turn.steered.join("|")}`);
  };

  release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) {
      this.#permits += 1;
    } else {
      next();
    }
  }

  async #pass(): Promise<void> {
    if (this.#permits > 0) {
      this.#permits -= 1;
      return;
    }
    const { promise, resolve } = Promise.withResolvers<undefined>();
    this.#waiting.push(() => {
      resolve(undefined);
    });
    await promise;
  }
}

export async function spawned(crew: Subagents, task: string, name?: string): Promise<Subagent> {
  const result = await crew.spawn({ runtime: "fake", task, ...(name === undefined ? {} : { name }) });
  assert.ok(result.kind === "spawned");
  return result.agent;
}


/**
 * The scripted runtime ends a disposed turn `aborted`; claude's and codex's
 * adapters report no end at all. This wraps a runtime so its sessions
 * behave like theirs: after dispose, no `turn_ended` reaches observers.
 */
export function silentOnDispose(runtime: Runtime): Runtime {
  return {
    ...runtime,
    session: async (installation, options) => {
      const real = await runtime.session(installation, options);
      let disposed = false;
      const wrapped: Session = new Proxy(real, {
        get: (target, property, receiver): unknown => {
          if (property === "dispose") {
            return async (): Promise<void> => {
              disposed = true;
              await target.dispose();
            };
          }
          if (property === "events") {
            const events: Session["events"] = (observer, eventOptions) => target.events((event) => {
              if (!(disposed && event.kind === "turn_ended")) {
                observer(event);
              }
            }, eventOptions);
            return events;
          }
          const value: unknown = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      return wrapped;
    },
  };
}
