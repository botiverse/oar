import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { app, BrowserWindow } from "electron";
import { AgentHost } from "./agent.js";
import { registerIpc } from "./ipc.js";

const WINDOW_BACKGROUND = "#0b0e0d";
const WINDOW_WIDTH = 1280;
const WINDOW_HEIGHT = 800;

let mainWindow: BrowserWindow | null = null;
let host: AgentHost | null = null;
let unregisterIpc: (() => void) | null = null;
let smokeCaptured = false;

async function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}

async function captureSmokeScreenshot(window: BrowserWindow, outputPath: string): Promise<void> {
  if (smokeCaptured) {
    return;
  }
  smokeCaptured = true;
  await delay(250);
  const image = await window.webContents.capturePage();
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, image.toPNG());
  process.stdout.write(`coxswain smoke screenshot: ${outputPath}\n`);
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
  const nextHost = new AgentHost({ smoke: smokeOutput !== undefined });
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
      if (smokeOutput !== undefined) {
        void captureSmokeScreenshot(window, smokeOutput).catch((error: unknown) => {
          process.stderr.write(`${error instanceof Error ? error.message : "Screenshot failed"}\n`);
          app.exit(1);
        });
      }
    },
  });

  window.once("ready-to-show", () => {
    if (smokeOutput === undefined) {
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
  void loadRenderer(window, smokeOutput !== undefined).catch((error: unknown) => {
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
