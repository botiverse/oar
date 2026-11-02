/* oxlint-disable import/max-dependencies -- Runtime composition imports one module per capability and shared validation. */
import { refuseReaderEnvironment } from "../../shared/refuse-environment.js";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/models";
import type { Harness, HarnessOptions } from "@earendil-works/pi-durable";
import type { SessionOpenContext } from "../../contracts/placement.js";
import type { AvailableInstallation } from "../../contracts/installation.js";
import type { SessionOptions } from "../../contracts/session.js";
import { defineRuntime, type Runtime } from "../../contracts/runtime.js";
import { runtimeBrands } from "../../brands.js";
import { projectPiModels } from "../pi/model-projection.js";
import { piDurableRefusedSessionOptions, type DurableModels } from "./options.js";
import { piDurableSession } from "./session.js";

export interface PiDurableRuntimeOptions {
  /** An already-open host-owned Harness. OAR never closes it or its storage. */
  readonly harness: Harness;
  /** The same catalog or supplier passed to Harness.open. Resolved at each listing and session open, including resume; native Harness exposes no getter, so OAR cannot verify identity. */
  readonly models: HarnessOptions["models"];
}

/** Pi Durable conversations over host-owned storage, providers, extensions and execution environment. */
export function createPiDurableRuntime({ harness, models }: PiDurableRuntimeOptions): Runtime {
  const currentModels = typeof models === "function" ? models : (): DurableModels => models;
  const runtime = defineRuntime({
    id: "pi-durable",
    brand: runtimeBrands["pi-durable"],
    refusedSessionOptions: piDurableRefusedSessionOptions,
    resumedSessionOptions: {
      appendSystemPrompt: { provided: "immediate", omitted: "saved" },
    },
    installation: async (options = {}) => { refuseReaderEnvironment(options.env, "Pi Durable uses the host environment"); await Promise.resolve(); return { kind: "available", via: "bundled" }; },
    listModels: async (_installation, options = {}) => { refuseReaderEnvironment(options.env, "Pi Durable uses the host environment"); await Promise.resolve(); return { kind: "ok", models: projectPiModels(currentModels().getModels(), getSupportedThinkingLevels) }; },
    session: async (installation: AvailableInstallation, options: SessionOptions, context?: SessionOpenContext) => {
      if (installation.via !== "bundled") { throw new Error("pi-durable requires the host's bundled Harness"); }
      const session = await piDurableSession(harness, currentModels(), options, context);
      return session;
    },
  }, { execution: "in_process" });
  return runtime;
}
