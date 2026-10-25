// Renders index.html frame by frame into an MP4: seek(t) for every frame, screenshot, pipe into ffmpeg.
// Usage (from demo/): npm install && node render.mjs [out.mp4] [fps]
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ffmpegPath from "ffmpeg-static";
import { chromium } from "playwright-core";

const here = dirname(fileURLToPath(import.meta.url));
const out = resolve(process.argv[2] || resolve(here, "../dist/finance-demo.mp4"));
const fps = Number(process.argv[3] || 60);
mkdirSync(dirname(out), { recursive: true });

// Uses the installed Microsoft Edge, so no browser download is needed.
const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 540, height: 960 }, deviceScaleFactor: 2 });
await page.goto(`${pathToFileURL(resolve(here, "index.html"))}?render=1`);
await page.evaluate(() => window.ready);
const duration = await page.evaluate(() => DURATION);
const frames = Math.round(duration * fps);

const ffmpeg = spawn(ffmpegPath, [
  "-y", "-loglevel", "error",
  "-f", "image2pipe", "-framerate", String(fps), "-i", "-",
  "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p", "-movflags", "+faststart",
  out,
], { stdio: ["pipe", "inherit", "inherit"] });
const finished = new Promise((ok, fail) => ffmpeg.on("close", (code) => (code === 0 ? ok() : fail(new Error(`ffmpeg exited with ${code}`)))));

const started = Date.now();
for (let f = 0; f < frames; f++) {
  await page.evaluate((t) => seek(t), f / fps);
  const shot = await page.screenshot({ type: "jpeg", quality: 95 });
  if (!ffmpeg.stdin.write(shot)) await new Promise((ok) => ffmpeg.stdin.once("drain", ok));
  if (f % fps === 0) process.stdout.write(`\r${Math.round((f / frames) * 100)}%  (${Math.round((Date.now() - started) / 1000)} s)`);
}
ffmpeg.stdin.end();
await finished;
await browser.close();
console.log(`\rDone: ${out} (${frames} frames, ${Math.round((Date.now() - started) / 1000)} s)`);
