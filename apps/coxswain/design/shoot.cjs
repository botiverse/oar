// Screenshot the design sheet's artboards headlessly (CJS: electron's bare
// .mjs entrypoints hang before main on this box).
const { app, BrowserWindow } = require("electron");
const path = require("node:path");
const { writeFile } = require("node:fs/promises");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

app.disableHardwareAcceleration();
(async () => {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1450, height: 1200, show: false });
  await win.loadFile(path.join(__dirname, "design-sheet.html"));
  await sleep(3000); // tailwind-play compiles at runtime
  const total = await win.webContents.executeJavaScript("document.body.scrollHeight");
  win.setContentSize(1450, total); // viewport = whole sheet, rects become absolute
  await sleep(800);
  const sections = await win.webContents.executeJavaScript(
    "[...document.querySelectorAll('section')].map((el) => { const r = el.getBoundingClientRect(); return { y: Math.floor(r.top + window.scrollY), h: Math.ceil(r.height) }; })",
  );
  let index = 1;
  for (const section of sections) {
    const image = await win.webContents.capturePage({ x: 0, y: Math.max(section.y - 8, 0), width: 1450, height: section.h + 16 });
    await writeFile(path.join(__dirname, `artboard-${index}.png`), image.toPNG());
    index += 1;
  }
  console.log(`captured ${index - 1} artboards`);
  app.quit();
})().catch((error) => { console.error(error); app.exit(1); });
