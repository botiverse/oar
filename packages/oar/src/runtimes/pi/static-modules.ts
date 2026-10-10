import { configurePiHttp, type PiHttpSettings } from "./http.js";

/*
 * pi's provider modules for a bundled host (#328). pi-ai loads its sign-in
 * flows (`auth/oauth/load.js`) and Bedrock (`bedrock-converse-stream.lazy.js`)
 * through a computed path, so that a browser bundler does not follow them
 * into Node-only code. A host bundled into one file (a Node single
 * executable) has no such files beside it, and every pi sign-in, OAuth turn
 * and Bedrock call failed with "Cannot find module". pi's own standalone
 * binary hands pi-ai the modules instead
 * (`pi-coding-agent/dist/bun/runtime-setup.js`); OAR makes the same two
 * calls. OAR runs pi in-process on Node only, so the browser reason does not
 * apply. The imports are literal, so a bundler follows them, and dynamic, so
 * a host that never uses pi does not load them (Bedrock's AWS SDK alone takes
 * about 60 to 140 ms).
 */
let provided: Promise<void> | null = null;

async function provide(): Promise<void> {
  const [{ registerBunOAuthFlows }, { bedrockProviderModule }, { setBedrockProviderModule }] = await Promise.all([
    import("@earendil-works/pi-ai/bun-oauth"),
    import("@earendil-works/pi-ai/bedrock-provider"),
    import("@earendil-works/pi-ai/compat"),
  ]);
  registerBunOAuthFlows();
  setBedrockProviderModule(bedrockProviderModule);
}

/** Hand pi-ai its sign-in flows and Bedrock module, once per process. */
export async function providePiModules(): Promise<void> {
  provided ??= provide();
  await provided;
}

/** pi's process-wide setup before it first reaches a provider: the proxy plane (http.ts) and pi-ai's provider modules. */
export async function preparePi(settings: PiHttpSettings): Promise<void> {
  await Promise.all([configurePiHttp(settings), providePiModules()]);
}
