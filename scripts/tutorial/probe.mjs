// Tutorial videos — the playback check: every MP4 of a folder is played in Edge (H.264 decode) → size, duration, that the picture
// really advances and that the music track decodes.   PLAYWRIGHT_CORE=<…/playwright-core/index.mjs> node probe.mjs <folder>
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
const { chromium } = process.env.PLAYWRIGHT_CORE ? await import(pathToFileURL(process.env.PLAYWRIGHT_CORE).href) : await import("playwright-core");
const dir = process.argv[2];
const files = readdirSync(dir).filter((f) => f.endsWith(".mp4")).sort();
const browser = await chromium.launch({ channel: "msedge", headless: true, args: ["--autoplay-policy=no-user-gesture-required"] });
const page = await browser.newPage();
let total = 0, bytes = 0;
for (const f of files) {
  const url = pathToFileURL(join(dir, f)).href;
  await page.goto(url); // Edge's own player page for the file (same origin as the file → no blocked load)
  const r = await page.evaluate(async () => {
    const v = document.querySelector("video");
    v.muted = true;
    if (v.readyState < 1) await new Promise((ok, no) => { v.onloadedmetadata = ok; v.onerror = () => no(new Error("cannot decode")); setTimeout(() => no(new Error("timeout")), 15000); });
    v.currentTime = Math.min(5, v.duration / 2); await new Promise((ok) => (v.onseeked = ok));
    await v.play(); const t0 = v.currentTime; await new Promise((ok) => setTimeout(ok, 800)); const moved = v.currentTime - t0; v.pause();
    const q = v.getVideoPlaybackQuality();
    return { d: v.duration, w: v.videoWidth, h: v.videoHeight, moved, frames: q.totalVideoFrames, audio: v.webkitAudioDecodedByteCount > 0 };
  });
  const mb = statSync(join(dir, f)).size / 1e6; total += r.d; bytes += mb;
  console.log(`${f}  ${r.w}×${r.h}  ${r.d.toFixed(1)} s  ${mb.toFixed(2)} MB  plays:${r.moved > 0.3 ? "yes" : "NO"} (${r.frames} frames)  music:${r.audio ? "yes" : "NO"}`);
}
console.log(`${files.length} files · ${total.toFixed(1)} s · ${bytes.toFixed(2)} MB`);
await browser.close();
