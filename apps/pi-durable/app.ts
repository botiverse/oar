import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";
import { phaseLabel, viewOf, type Session } from "../../packages/oar/src/browser.js";
import { createPiDurableRuntime } from "../../packages/oar/src/pi-durable.js";
import { renderView } from "./render.js";

function element<T extends Element>(id: string, type: new () => T): T {
  const found = document.querySelector(`#${id}`);
  if (!(found instanceof type)) { throw new Error(`Missing element: ${id}`); }
  return found;
}
const ui = {
  setup: element("setup", HTMLFormElement), settings: element("settings", HTMLFieldSetElement),
  key: element("key", HTMLInputElement), model: element("model", HTMLSelectElement),
  composer: element("composer", HTMLFormElement), controls: element("controls", HTMLFieldSetElement),
  prompt: element("prompt", HTMLTextAreaElement), send: element("send", HTMLButtonElement),
  stop: element("stop", HTMLButtonElement), end: element("end", HTMLButtonElement),
  status: element("status", HTMLSpanElement), error: element("error", HTMLDivElement),
  conversation: element("conversation", HTMLDivElement),
};
const provider = anthropicProvider();
for (const model of provider.getModels()) {
  const option = document.createElement("option");
  option.value = `${model.provider}/${model.id}`;
  option.textContent = model.name;
  ui.model.append(option);
}
let active: { readonly harness: Harness; readonly session: Session } | null = null;

function render(): void {
  if (active === null) { return; }
  const view = viewOf(active.session.records());
  renderView(view, ui.conversation);
  const running = view.status.kind === "running";
  ui.status.dataset.state = view.status.kind;
  ui.status.textContent = running ? phaseLabel(view.status.phase) : "Ready";
  ui.send.disabled = running;
  ui.stop.disabled = !running;
}

async function connect(): Promise<void> {
  ui.settings.disabled = true;
  try {
    const key = ui.key.value.trim();
    if (key.length === 0) { throw new Error("Enter your Anthropic API key."); }
    const models = createModels();
    models.setProvider({ ...provider, auth: { apiKey: { name: "API key", resolve: async () => {
      await Promise.resolve();
      return { auth: { apiKey: key }, source: "demo form" };
    } } } });
    const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
    try {
      const runtime = createPiDurableRuntime({ harness, models });
      const session = await runtime.session({ kind: "available", via: "bundled" }, { cwd: "/", model: ui.model.value });
      active = { harness, session };
      session.rawEvents(render);
    } catch (error) { await harness.close(BACKGROUND_CONTEXT); throw error; }
    ui.key.value = "";
    ui.controls.disabled = false;
    render();
    ui.prompt.focus();
  } catch (error) { ui.settings.disabled = false; throw error; }
}

async function send(): Promise<void> {
  if (active === null) { return; }
  const response = await active.session.prompt(ui.prompt.value, { inputId: crypto.randomUUID() });
  if (response.kind === "rejected") { throw new Error(response.reason); }
  ui.prompt.value = "";
}

async function stop(): Promise<void> {
  if (active === null) { return; }
  const response = await active.session.abort();
  if (response.kind === "rejected") { throw new Error(response.reason); }
}

async function close(): Promise<void> {
  const closing = active;
  if (closing === null) { return; }
  ui.controls.disabled = true;
  try {
    await closing.session.abort();
    await closing.session.dispose();
  } finally {
    await closing.harness.close(BACKGROUND_CONTEXT);
    active = null;
    ui.controls.disabled = true;
    ui.settings.disabled = false;
    ui.status.dataset.state = "disconnected";
    ui.status.textContent = "Not connected";
  }
}

function act(action: () => Promise<void>): void {
  ui.error.textContent = "";
  void (async (): Promise<void> => {
    try { await action(); } catch (error) { ui.error.textContent = error instanceof Error ? error.message : String(error); }
  })();
}
ui.setup.addEventListener("submit", (event) => { event.preventDefault(); act(connect); });
ui.composer.addEventListener("submit", (event) => { event.preventDefault(); act(send); });
ui.stop.addEventListener("click", () => { act(stop); });
ui.end.addEventListener("click", () => { act(close); });
window.addEventListener("pagehide", () => { act(close); });
