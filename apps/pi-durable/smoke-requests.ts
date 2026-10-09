import assert from "node:assert/strict";
import { build } from "esbuild";
import type { Page } from "playwright";
import type { initialSessionView, ViewPart } from "../../packages/oar/src/browser.js";
import type { renderView } from "./render.js";

/** Exercise request states that a host can receive from other OAR runtimes. */
export async function verifyRequestRendering(page: Page): Promise<void> {
  const bundle = await build({
    stdin: { contents: 'export { renderView } from "./render.js"; export { initialSessionView } from "../../packages/oar/src/browser.js";', resolveDir: import.meta.dirname },
    bundle: true, platform: "browser", format: "esm", write: false,
  });
  const url = `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0]?.text ?? "").toString("base64")}`;
  const rendered = await page.evaluate(async (moduleUrl) => {
    // oxlint-disable-next-line typescript/consistent-type-assertions, typescript/no-unsafe-type-assertion -- the data URL bundles these exact source exports above.
    const renderer = await import(moduleUrl) as { readonly renderView: typeof renderView; readonly initialSessionView: typeof initialSessionView };
    const parts: ViewPart[] = [
      { kind: "app_request", requestId: "pending", type: "elicitation/create", answered: false, body: { message: "Keep <b>this</b>?" } },
      { kind: "app_request", requestId: "answered", type: "elicitation/create", answered: true, body: { message: "Ship now?" } },
      { kind: "app_request", requestId: "cancelled", type: "elicitation/create", answered: false, cancelled: true, body: { message: "Pick a color" } },
      { kind: "app_request", requestId: "unknown", type: "unknown/request", answered: false },
    ];
    const container = document.createElement("div");
    renderer.renderView({ ...renderer.initialSessionView(), messages: [{ kind: "turn", id: "requests", sections: [{ sessionId: "demo", agentPath: [], parts }] }] }, container);
    return { notices: Array.from(container.querySelectorAll(".notice"), (element) => element.textContent), htmlElements: container.querySelectorAll("b").length };
  }, url);
  assert.deepEqual(rendered, {
    notices: ["Keep <b>this</b>?: awaiting answer", "Ship now?: answered", "Pick a color: withdrawn by the runtime", "unknown/request: awaiting answer"],
    htmlElements: 0,
  });
}
