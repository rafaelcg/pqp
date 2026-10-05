#!/usr/bin/env node
/**
 * Does `applyConstraints({ height: { max } })` on a display capture rescale
 * the frames the capture delivers? The screen plan (`constrainScreenCapture`
 * in `livekit-session.ts`) relies on it to hold a large room's top layer at
 * 720p, and it lays the new height over the capture's own constraints
 * (`getConstraints()`, which include the frame rate the share asked for).
 *
 *   node e2e/share-fast-start/constraint-probe.mjs
 *
 * Chrome's fake display device, headless, a fresh capture per variant asked
 * with the product's own options (`screenCaptureOptions`: frameRate ideal and
 * max 30, width max 1920, height max 1080). Prints the settings and the size
 * of the frames a `<video>` receives 3 s after each applyConstraints.
 */
import { chromium } from "@playwright/test";

const base = process.env.BASE ?? "http://localhost:5299";
const browser = await chromium.launch({
  channel: "chrome",
  headless: true,
  args: [
    "--use-fake-device-for-media-stream",
    "--use-fake-ui-for-media-stream",
    "--auto-select-desktop-capture-source=Entire screen",
  ],
});
try {
  const page = await browser.newPage();
  await page.goto(`${base}/e2e/share-fast-start/harness.html?role=none`);
  const out = await page.evaluate(async () => {
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const variants = {
      "what constrainScreenCapture sends: getConstraints() + height max 720": (c) => ({
        ...c,
        height: { ...(typeof c.height === "object" ? c.height : {}), max: 720 },
      }),
      "same without frameRate": (c) => {
        const rest = { ...c };
        delete rest.frameRate;
        return { ...rest, height: { max: 720 } };
      },
      "frameRate max only + height max 720": () => ({ frameRate: { max: 30 }, height: { max: 720 } }),
      "frameRate ideal only + height max 720": () => ({ frameRate: { ideal: 30 }, height: { max: 720 } }),
      "height max 720 alone": () => ({ height: { max: 720 } }),
      "getConstraints() with width scaled to the height (1280) + height max 720": (c) => ({
        ...c,
        width: { max: 1280 },
        height: { max: 720 },
      }),
    };
    const results = [];
    for (const [name, build] of Object.entries(variants)) {
      const stream = await navigator.mediaDevices.getDisplayMedia({
        video: { frameRate: { ideal: 30, max: 30 }, width: { max: 1920 }, height: { max: 1080 } },
      });
      const [track] = stream.getVideoTracks();
      const video = document.createElement("video");
      video.muted = true;
      video.srcObject = stream;
      document.body.append(video);
      await video.play();
      await wait(1000);
      const asked = build({ ...track.getConstraints() });
      let error = null;
      try {
        await track.applyConstraints(asked);
      } catch (err) {
        error = String(err);
      }
      await wait(3000);
      const s = track.getSettings();
      results.push({
        name,
        asked: JSON.stringify(asked),
        error,
        settings: `${s.width}x${s.height}@${s.frameRate}`,
        frames: `${video.videoWidth}x${video.videoHeight}`,
      });
      track.stop();
      video.remove();
    }
    return results;
  });
  for (const r of out) console.log(JSON.stringify(r));
} finally {
  await browser.close();
}
