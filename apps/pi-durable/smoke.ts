import assert from "node:assert/strict";
import { chromium } from "playwright";
import { LLMock } from "@copilotkit/aimock";
import { startDemo } from "./host.js";
import { verifyRequestRendering } from "./smoke-requests.js";

const mock = new LLMock({ port: 0 });
mock.onMessage(/slow/u, { content: "late reply" }, { latency: 1200 });
mock.onMessage(/hello/u, { content: "Hello from the browser <b>literal</b>" });
await mock.start();
const demo = await startDemo();
const browser = await chromium.launch({ headless: true });
const page = await browser.newPage();
try {
  const errors: string[] = [];
  page.on("pageerror", (error) => { errors.push(error.message); });
  // Use the native fetch provider, but route its HTTP requests to the local
  // scripted server. Only this test key is supplied; no real account is used.
  await page.route("https://api.anthropic.com/**", async (route) => {
    const request = route.request();
    assert.equal(request.headers()["x-api-key"], "browser-test-key");
    const response = await route.fetch({ url: `${mock.url}${new URL(request.url()).pathname}` });
    await route.fulfill({ response });
  });
  await page.goto(demo.url);
  await page.locator("#model option").nth(1).waitFor({ state: "attached" });
  await page.getByLabel("Anthropic API key").fill("browser-test-key");
  await page.getByLabel("Model", { exact: true }).selectOption({ index: 1 });
  await page.getByRole("button", { name: "Start conversation" }).click();
  await page.locator('#status[data-state="idle"]').waitFor();
  await page.getByLabel("Your message").fill("hello");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Hello from the browser <b>literal</b>", { exact: true }).waitFor();
  await page.locator('#status[data-state="idle"]').waitFor();
  assert.equal(await page.locator("#conversation b").count(), 0);
  assert.equal(await page.locator("#conversation article").count(), 2);
  await page.getByLabel("Your message").fill("slow");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.locator('#status[data-state="running"]').waitFor();
  await page.getByRole("button", { name: "Stop", exact: true }).click();
  await page.getByText("aborted", { exact: true }).waitFor();
  await page.getByRole("button", { name: "End session" }).click();
  await page.locator('#status[data-state="disconnected"]').waitFor();
  assert.equal(await page.getByLabel("Anthropic API key").inputValue(), "");
  assert.deepEqual(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 });
  await verifyRequestRendering(page);
  assert.deepEqual(errors, []);
  process.stdout.write("browser smoke passed: native fetch provider, SessionView, request states, abort, cleanup and no stored key\n");
} finally {
  // Aborting the browser request does not cancel route.fetch's Node request.
  // Let that local response finish before disposing its request context.
  await page.unrouteAll({ behavior: "wait" });
  await browser.close(); await demo.close(); await mock.stop();
}
