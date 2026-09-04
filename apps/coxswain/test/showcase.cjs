// Fixture-only Coxswain showcase capture.
//
// This intentionally runs the renderer's #smoke path. It never launches a
// runtime, reads account state, or touches a credential. The Electron main
// process writes a deterministic PNG frame sequence; ffmpeg packages those
// frames as a broadly viewable MP4 for sharing in Raft.
const {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  copyFileSync,
} = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const appDirectory = path.resolve(__dirname, "..");
const repositoryDirectory = path.resolve(appDirectory, "..", "..");
const defaultOutputDirectory = path.join(appDirectory, "artifacts", "showcase");
const outputDirectory = path.resolve(process.env.COXSWAIN_SHOWCASE_OUTPUT ?? defaultOutputDirectory);
const frameDirectory = path.join(outputDirectory, "frames");
const screenshotPath = path.join(outputDirectory, "coxswain-usage-helm.png");
const videoPath = path.join(outputDirectory, "coxswain-usage-helm.mp4");
const manifestPath = path.join(outputDirectory, "manifest.json");

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

function run(command, args, env = process.env) {
  const result = spawnSync(command, args, {
    cwd: repositoryDirectory,
    env,
    stdio: "inherit",
  });
  if (result.error !== undefined) {
    fail(`${command} could not be started: ${result.error.message}`);
  }
  if (result.status !== 0) {
    fail(`${command} exited with status ${result.status ?? "unknown"}`);
  }
}

function repositoryCommit() {
  const result = spawnSync("git", ["rev-parse", "HEAD"], {
    cwd: repositoryDirectory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.status === 0 && typeof result.stdout === "string") {
    const commit = result.stdout.trim();
    if (commit.length > 0) {
      return commit;
    }
  }
  return process.env.COXSWAIN_COMMIT ?? process.env.GITHUB_SHA ?? "unknown";
}

if (!existsSync(path.join(appDirectory, "out", "main", "index.cjs"))) {
  fail("Coxswain build output is missing; run `pnpm --filter @botiverse/coxswain build` first");
}
if (!existsSync(path.join(appDirectory, "out", "renderer", "index.html"))) {
  fail("Coxswain renderer output is missing; run `pnpm --filter @botiverse/coxswain build` first");
}

const rootPath = path.parse(outputDirectory).root;
if (outputDirectory === rootPath
  || outputDirectory === repositoryDirectory
  || outputDirectory === appDirectory) {
  fail("Refusing to clear a repository or filesystem root; choose a dedicated showcase directory");
}

mkdirSync(outputDirectory, { recursive: true });
rmSync(screenshotPath, { force: true });
rmSync(videoPath, { force: true });
rmSync(manifestPath, { force: true });
for (let index = 0; index < 12; index += 1) {
  rmSync(path.join(frameDirectory, `frame-${String(index).padStart(3, "0")}.png`), { force: true });
}
mkdirSync(frameDirectory, { recursive: true });

const smokeEnvironment = {
  ...process.env,
  COXSWAIN_COMMIT: repositoryCommit(),
  COXSWAIN_SHOWCASE_DIR: frameDirectory,
  COXSWAIN_SHOWCASE_MANIFEST: manifestPath,
  COXSWAIN_SHOWCASE_SCREENSHOT: screenshotPath,
  COXSWAIN_SHOWCASE_VIDEO: videoPath,
  LANG: process.env.LANG ?? "en_US.UTF-8",
  TZ: process.env.TZ ?? "UTC",
};
const smokeCommand = process.env.DISPLAY === undefined ? "xvfb-run" : "pnpm";
const smokeArgs = process.env.DISPLAY === undefined
  ? ["-a", "pnpm", "--filter", "@botiverse/coxswain", "smoke"]
  : ["--filter", "@botiverse/coxswain", "smoke"];
run(smokeCommand, smokeArgs, smokeEnvironment);

const frames = readdirSync(frameDirectory)
  .filter((name) => /^frame-\d{3}\.png$/u.test(name))
  .toSorted();
if (frames.length === 0) {
  fail(`No showcase frames were written to ${frameDirectory}`);
}
copyFileSync(path.join(frameDirectory, frames[0]), screenshotPath);

run("ffmpeg", [
  "-hide_banner",
  "-loglevel", "error",
  "-y",
  "-framerate", "4",
  "-i", path.join(frameDirectory, "frame-%03d.png"),
  "-vf", "format=yuv420p",
  "-frames:v", "12",
  "-c:v", "libx264",
  "-preset", "veryfast",
  "-crf", "23",
  "-movflags", "+faststart",
  videoPath,
]);

if (!statSync(screenshotPath).isFile() || !statSync(videoPath).isFile()) {
  fail("Showcase capture did not produce both image and video artifacts");
}
if (!statSync(manifestPath).isFile()) {
  fail("Showcase capture did not produce its manifest");
}

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`Showcase manifest is not valid JSON: ${error.message}`);
}
if (manifest.format !== "coxswain-capture/1"
  || manifest.mode !== "demo"
  || manifest.fixture !== "regatta-usage-smoke-v1"
  || manifest.status !== "passed"
  || !Array.isArray(manifest.assertions)
  || manifest.assertions.some((assertion) => assertion.passed !== true)) {
  fail("Showcase manifest does not report a passed deterministic fixture");
}
if (manifest.viewport?.width !== 1280
  || manifest.viewport?.height !== 800
  || typeof manifest.devicePixelRatio !== "number"
  || typeof manifest.locale !== "string"
  || typeof manifest.timeZone !== "string") {
  fail("Showcase manifest is missing viewport or environment facts");
}

function pngDimensions(filePath) {
  const bytes = readFileSync(filePath);
  if (bytes.length < 24
    || bytes.readUInt32BE(0) !== 0x89504e47
    || bytes.readUInt32BE(4) !== 0x0d0a1a0a) {
    fail(`Not a PNG: ${filePath}`);
  }
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

const dimensions = pngDimensions(screenshotPath);
if (dimensions.width !== manifest.viewport.width || dimensions.height !== manifest.viewport.height) {
  fail("Showcase screenshot dimensions do not match the manifest viewport");
}
for (const frame of frames) {
  const frameDimensions = pngDimensions(path.join(frameDirectory, frame));
  if (frameDimensions.width !== dimensions.width || frameDimensions.height !== dimensions.height) {
    fail(`Showcase frame dimensions differ: ${frame}`);
  }
}
process.stdout.write(`coxswain showcase screenshot: ${screenshotPath}\n`);
process.stdout.write(`coxswain showcase video: ${videoPath}\n`);
process.stdout.write(`coxswain showcase manifest: ${manifestPath}\n`);
