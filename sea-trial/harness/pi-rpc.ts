import type { PiRuntimeOptions } from "../../packages/oar/src/runtimes/pi/options.js";

/** Let daily/native controls exercise an explicit CLI without replacing OAR's bundled SDK. */
export function piRpcTestOptions(): PiRuntimeOptions & { readonly execution: "subprocess" } {
  const command = process.env.OAR_PI_RPC_COMMAND;
  if (command === undefined) { return { execution: "subprocess" }; }
  const args: unknown = JSON.parse(process.env.OAR_PI_RPC_ARGS ?? "[]");
  if (!Array.isArray(args) || !args.every((value: unknown) => typeof value === "string")) { throw new TypeError("OAR_PI_RPC_ARGS must be a JSON string array"); }
  return { execution: "subprocess", command, args };
}
