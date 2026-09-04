import { mkdir, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { app, BrowserWindow } from "electron";
import { AgentHost } from "./agent.js";
import { registerIpc } from "./ipc.js";

const WINDOW_BACKGROUND = "#0b0e0d";
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;
const SHOWCASE_FRAME_COUNT = 12;
const SHOWCASE_FRAME_INTERVAL_MS = 250;
const SMOKE_FIXTURE = "regatta-usage-smoke-v1";

const SMOKE_SEMANTIC_ASSERTION_SCRIPT = `(() => {
  const bodyText = document.body.textContent ?? "";
  const resetWindow = document.querySelector('[data-usage-reset="true"]');
  const errorState = document.querySelector('[data-usage-status="error"]');
  const checks = {
    usageDelta: bodyText.includes("+4.0%"),
    burnRate: bodyText.includes("%/min"),
    projection: bodyText.includes("estimated limit ~"),
    reset: resetWindow !== null && (resetWindow.textContent ?? "").includes("reset"),
    error: errorState !== null && (errorState.textContent ?? "").includes("fixture quota probe failed"),
  };
  return {
    checks,
    missing: Object.entries(checks)
      .filter(([, passed]) => !passed)
      .map(([name]) => name),
  };
})()`;

interface SmokeSemanticResult {
  readonly checks: Readonly<Record<string, boolean>>;
  readonly missing: readonly string[];
}

interface SmokeBrowserFacts {
  readonly devicePixelRatio: number;
  readonly locale: string;
  readonly timeZone: string;
}

const SMOKE_BROWSER_FACTS_SCRIPT = `(() => ({
  devicePixelRatio: window.devicePixelRatio,
  locale: Intl.DateTimeFormat().resolvedOptions().locale,
  timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
}))()`;

let mainWindow: BrowserWindow | null = null;
let host: AgentHost | null = null;
let unregisterIpc: (() => void) | null = null;
let smokeCaptured = false;

function objectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null
    ? Object.fromEntries(Object.entries(value))
    : null;
}

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

function parseSmokeSemanticResult(value: unknown): SmokeSemanticResult {
  const record = objectRecord(value);
  if (record === null) {
    throw new Error("Smoke semantic assertion returned an invalid result");
  }
  if (!Array.isArray(record.missing) || !record.missing.every((name) => typeof name === "string")) {
    throw new Error("Smoke semantic assertion returned invalid missing checks");
  }
  const checksRecord = objectRecord(record.checks);
  if (checksRecord === null) {
    throw new Error("Smoke semantic assertion returned invalid checks");
  }
  const checks: Record<string, boolean> = {};
  for (const [name, passed] of Object.entries(checksRecord)) {
    if (typeof passed !== "boolean") {
      throw new TypeError("Smoke semantic assertion returned non-boolean checks");
    }
    checks[name] = passed;
  }
  return { checks, missing: record.missing };
}

async function collectSmokeSemantics(window: BrowserWindow): Promise<SmokeSemanticResult> {
  const rawResult: unknown = await window.webContents.executeJavaScript(
    SMOKE_SEMANTIC_ASSERTION_SCRIPT,
    true,
  );
  return parseSmokeSemanticResult(rawResult);
}

function fallbackBrowserFacts(): SmokeBrowserFacts {
  return {
    devicePixelRatio: 1,
    locale: "unknown",
    timeZone: "unknown",
  };
}

function parseSmokeBrowserFacts(value: unknown): SmokeBrowserFacts {
  const record = objectRecord(value);
  if (record === null) {
    throw new Error("Smoke browser facts returned an invalid result");
  }
  if (typeof record.devicePixelRatio !== "number"
    || !Number.isFinite(record.devicePixelRatio)
    || record.devicePixelRatio <= 0
    || typeof record.locale !== "string"
    || record.locale.length === 0
    || typeof record.timeZone !== "string"
    || record.timeZone.length === 0) {
    throw new Error("Smoke browser facts returned invalid values");
  }
  return {
    devicePixelRatio: record.devicePixelRatio,
    locale: record.locale,
    timeZone: record.timeZone,
  };
}

async function browserFacts(window: BrowserWindow): Promise<SmokeBrowserFacts> {
  try {
    const rawFacts: unknown = await window.webContents.executeJavaScript(
      SMOKE_BROWSER_FACTS_SCRIPT,
      true,
    );
    return parseSmokeBrowserFacts(rawFacts);
  } catch {
    return fallbackBrowserFacts();
  }
}

async function collectSmokeSemanticsOrFailure(window: BrowserWindow): Promise<SmokeSemanticResult> {
  try {
    return await collectSmokeSemantics(window);
  } catch (error) {
    return {
      checks: { semantic_probe: false },
      missing: [error instanceof Error ? error.message : "semantic probe failed"],
    };
  }
}

function smokeAssertionList(result: SmokeSemanticResult): readonly {
  readonly name: string;
  readonly passed: boolean;
}[] {
  return Object.entries(result.checks).map(([name, passed]) => ({ name, passed }));
}

async function writeCaptureManifest(options: {
  readonly window: BrowserWindow;
  readonly path: string;
  readonly mode: "smoke" | "demo";
  readonly semantic: SmokeSemanticResult;
  readonly artifacts: Readonly<Record<string, string>>;
}): Promise<void> {
  const [width, height] = options.window.getContentSize();
  const facts = await browserFacts(options.window);
  const assertions = smokeAssertionList(options.semantic);
  const manifest = {
    format: "coxswain-capture/1",
    mode: options.mode,
    fixture: SMOKE_FIXTURE,
    status: options.semantic.missing.length === 0 ? "passed" : "failed",
    commit: process.env.COXSWAIN_COMMIT ?? process.env.GITHUB_SHA ?? "unknown",
    viewport: { width, height },
    devicePixelRatio: facts.devicePixelRatio,
    locale: facts.locale,
    timeZone: facts.timeZone,
    checkpoints: [
      { name: "renderer-ready", passed: true },
      { name: "usage-motion-visible", passed: options.semantic.missing.length === 0 },
    ],
    assertions,
    artifacts: options.artifacts,
    tools: {
      node: process.version,
      electron: process.versions.electron,
    },
  };
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function captureSmokeScreenshot(
  window: BrowserWindow,
  outputPath: string,
  manifestPath: string,
): Promise<void> {
  if (smokeCaptured) {
    return;
  }
  smokeCaptured = true;
  await delay(250);
  const semantic = await collectSmokeSemanticsOrFailure(window);
  await writeCaptureManifest({
    window,
    path: manifestPath,
    mode: "smoke",
    semantic,
    artifacts: { screenshot: basename(outputPath) },
  });
  process.stdout.write(`coxswain smoke semantic assertions: ${Object.keys(semantic.checks).join(", ")}\n`);
  const image = await window.webContents.capturePage();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, image.toPNG());
  process.stdout.write(`coxswain smoke screenshot: ${outputPath}\n`);
  if (semantic.missing.length > 0) {
    throw new Error(`Smoke semantic assertions failed: ${semantic.missing.join(", ")}`);
  }
  await host?.dispose();
  app.quit();
}

/**
 * Capture the same deterministic `#smoke` fixture as a short frame sequence.
 * This path is deliberately opt-in and fixture-only; it is never enabled by
 * a normal launch and therefore cannot capture a real account or credential.
 */
async function captureShowcase(
  window: BrowserWindow,
  outputDirectory: string,
  manifestPath: string,
): Promise<void> {
  if (smokeCaptured) {
    return;
  }
  smokeCaptured = true;
  await mkdir(outputDirectory, { recursive: true });
  await delay(250);
  const semantic = await collectSmokeSemanticsOrFailure(window);
  await writeCaptureManifest({
    window,
    path: manifestPath,
    mode: "demo",
    semantic,
    artifacts: {
      frames: basename(outputDirectory),
      ...(process.env.COXSWAIN_SHOWCASE_SCREENSHOT === undefined
        ? {}
        : { screenshot: basename(process.env.COXSWAIN_SHOWCASE_SCREENSHOT) }),
      ...(process.env.COXSWAIN_SHOWCASE_VIDEO === undefined
        ? {}
        : { video: basename(process.env.COXSWAIN_SHOWCASE_VIDEO) }),
    },
  });
  process.stdout.write(`coxswain showcase semantic assertions: ${Object.keys(semantic.checks).join(", ")}\n`);
  for (let index = 0; index < SHOWCASE_FRAME_COUNT; index += 1) {
    const image = await window.webContents.capturePage();
    const filename = `frame-${String(index).padStart(3, "0")}.png`;
    await writeFile(join(outputDirectory, filename), image.toPNG());
    if (index + 1 < SHOWCASE_FRAME_COUNT) {
      await delay(SHOWCASE_FRAME_INTERVAL_MS);
    }
  }
  process.stdout.write(`coxswain showcase frames: ${outputDirectory}\n`);
  if (semantic.missing.length > 0) {
    throw new Error(`Showcase semantic assertions failed: ${semantic.missing.join(", ")}`);
  }
  await host?.dispose();
  app.quit();
}

async function loadRenderer(window: BrowserWindow, smoke: boolean): Promise<void> {
  const developmentUrl = process.env.ELECTRON_RENDERER_URL;
  if (developmentUrl === undefined) {
    await window.loadFile(join(__dirname, "../renderer/index.html"), smoke ? { hash: "smoke" } : undefined);
  } else {
    await window.loadURL(developmentUrl);
  }
}

function createWindow(): void {
  const smokeOutput = process.env.COXSWAIN_SMOKE_SCREENSHOT;
  const smokeManifest = process.env.COXSWAIN_SMOKE_MANIFEST
    ?? (smokeOutput === undefined ? undefined : `${smokeOutput}.manifest.json`);
  const showcaseOutput = process.env.COXSWAIN_SHOWCASE_DIR;
  const showcaseManifest = process.env.COXSWAIN_SHOWCASE_MANIFEST
    ?? (showcaseOutput === undefined ? undefined : join(showcaseOutput, "manifest.json"));
  const smokeMode = smokeOutput !== undefined || showcaseOutput !== undefined;
  const nextHost = new AgentHost({ smoke: smokeMode });
  const window = new BrowserWindow({
    backgroundColor: WINDOW_BACKGROUND,
    height: WINDOW_HEIGHT,
    minHeight: 640,
    minWidth: 960,
    show: false,
    title: "coxswain",
    useContentSize: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: join(__dirname, "../preload/index.cjs"),
      sandbox: true,
    },
    width: WINDOW_WIDTH,
  });
  mainWindow = window;
  host = nextHost;
  unregisterIpc = registerIpc({
    host: nextHost,
    webContents: window.webContents,
    onRendererReady: () => {
      if (showcaseOutput !== undefined) {
        if (showcaseManifest === undefined) {
          throw new Error("Showcase manifest path is missing");
        }
        void captureShowcase(window, showcaseOutput, showcaseManifest).catch((error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : "Showcase capture failed"}\n`);
          app.exit(1);
        });
      } else if (smokeOutput !== undefined) {
        if (smokeManifest === undefined) {
          throw new Error("Smoke manifest path is missing");
        }
        void captureSmokeScreenshot(window, smokeOutput, smokeManifest).catch((error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : "Screenshot failed"}\n`);
          app.exit(1);
        });
      }
    },
  });

  window.once("ready-to-show", () => {
    if (!smokeMode) {
      window.show();
    }
  });
  window.once("closed", () => {
    unregisterIpc?.();
    unregisterIpc = null;
    mainWindow = null;
    void nextHost.dispose();
    if (host === nextHost) {
      host = null;
    }
  });
  void loadRenderer(window, smokeMode).catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "Renderer failed to load"}\n`);
    app.exit(1);
  });
}

app.on("window-all-closed", () => {
  app.quit();
});

app.on("activate", () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on("before-quit", () => {
  void host?.dispose();
});

void app.whenReady().then(() => {
  createWindow();
});
