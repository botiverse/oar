import type { RuntimeLogin } from "../../contracts/login.js";

/** The 0.26.0 auth command only prints its removal notice; no login process can be driven. */
export const qwenLogin: RuntimeLogin = async () => {
  await Promise.resolve();
  return { kind: "unsupported", reason: "transport_unavailable",
    detail: "qwen auth has been removed. Configure a provider with OPENAI_API_KEY, OPENAI_BASE_URL and OPENAI_MODEL, or run qwen interactively and use /auth." };
};
