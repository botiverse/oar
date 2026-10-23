import type { Models } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Harness } from "@earendil-works/pi-durable";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { runtimeBrands } from "../../brands.js";
import { projectPiModels } from "../pi/model-projection.js";
import { piDurableRefusedSessionOptions } from "./options.js";
import { piDurableSession } from "./session.js";

export interface PiDurableRuntimeOptions {
  /** An already-open host-owned Harness. OAR never closes it or its storage. */
  readonly harness: Harness;
  /** The same catalog or supplier passed to Harness.open. Resolved at each listing and session open, including resume; native Harness exposes no getter, so OAR cannot verify identity. */
  readonly models: Models | (() => Models);
}

/** Pi Durable conversations over host-owned storage, providers, extensions and execution environment. */
export function createPiDurableRuntime({ harness, models }: PiDurableRuntimeOptions): Runtime {
  const currentModels = typeof models === "function" ? models : (): Models => models;
  const runtime = defineRuntime({
    id: "pi-durable",
    brand: runtimeBrands["pi-durable"],
    refusedSessionOptions: piDurableRefusedSessionOptions,
    installation: async () => { await Promise.resolve(); return { kind: "available", via: "bundled" }; },
    listModels: async () => { await Promise.resolve(); return { kind: "ok", models: projectPiModels(currentModels().getModels(), getSupportedThinkingLevels) }; },
    session: async (installation: AvailableInstallation, options: SessionOptions) => {
      if (installation.via !== "bundled") { throw new Error("pi-durable requires the host's bundled Harness"); }
      const session = await piDurableSession(harness, currentModels(), options);
      return session;
    },
  });
  return runtime;
}
