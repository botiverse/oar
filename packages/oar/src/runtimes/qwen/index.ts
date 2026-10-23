import { runtimeBrands } from "../../brands.js";
import { defineRuntime } from "../../contracts/runtime.js";
import { onFirstCall } from "../../shared/lazy.js";
import { qwenInstallation } from "./installation.js";
import { qwenLogin } from "./login.js";
import { qwenRefusedSessionOptions } from "./options.js";

export const qwenRuntime = defineRuntime({
  id: "qwen", brand: runtimeBrands.qwen,
  refusedSessionOptions: qwenRefusedSessionOptions,
  installation: qwenInstallation,
  login: qwenLogin,
  listModels: onFirstCall(async () => {
    const { qwenListModels } = await import("./list-models.js");
    return qwenListModels;
  }),
  session: onFirstCall(async () => {
    const { qwenSession } = await import("./session.js");
    return qwenSession;
  }),
});
