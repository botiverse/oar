// Screenshot the design sheet's artboards headlessly (xvfb).
import { app, BrowserWindow } from "electron";
import path from "node:path";
import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
app.disableHardwareAcceleration();
await app.whenReady();
const win = new BrowserWindow({ width: 1450, height: 1000, show: false });
await win.loadFile(path.join(here, "design-sheet.html"));
await new Promise((resolve) => setTimeout(resolve, 2500)); // let tailwind-play compile
const height = await win.webContents.executeJavaScript("document.body.scrollHeight");
win.setContentSize(1450, Math.min(height, 4000));
await new Promise((resolve) => setTimeout(resolve, 600));
// full sheet in slices to keep files reviewable
const sections = await win.webContents.executeJavaScript(
  "[...document.querySelectorAll('section, header')].map(el => { const r = el.getBoundingClientRect(); return { y: Math.floor(r.top + window.scrollY), h: Math.ceil(r.height) }; })",
);
let index = 0;
for (const section of sections) {
  const image = await win.webContents.capturePage({ x: 0, y: section.y, width: 1450, height: Math.min(section.h + 24, 1400) });
  await writeFile(path.join(here, `shot-${index}.png`), image.toPNG());
  index += 1;
}
app.quit();
