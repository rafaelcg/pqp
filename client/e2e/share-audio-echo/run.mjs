#!/usr/bin/env node
/**
 * Headed Chrome, real getDisplayMedia, no fake device.
 *
 * Does not run in CI. SHARE_AUDIO_ECHO=1 on a Windows 11 box with speakers up.
 * Fake UI accepts the picker; a fake device would replace WASAPI with
 * "Fake audio" and every row would be a lie.
 */

import { chromium } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const toneHtml = readFileSync(
  path.join(here, "../../public/share-audio-tone.html"),
  "utf8",
);

if (process.env.SHARE_AUDIO_ECHO !== "1") {
  console.log(
    "share-audio-echo: skipped (set SHARE_AUDIO_ECHO=1 on a Windows 11 box with speakers up)",
  );
  process.exit(0);
}

const probeSource = readFileSync(
  path.join(here, "../../src/lib/share-audio-probe.ts"),
  "utf8",
);

function serveTone() {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(toneHtml);
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({ server, url: `http://127.0.0.1:${port}/` });
    });
  });
}

const { server, url } = await serveTone();
let browser;
try {
  browser = await chromium.launch({
    headless: false,
    args: [
      "--use-fake-ui-for-media-stream",
      "--autoplay-policy=no-user-gesture-required",
    ],
  });
  const game = await browser.newPage();
  await game.goto(url);

  const page = await browser.newPage();
  await page.goto(url);
  const row = await page.evaluate(async () => {
    const context = new AudioContext();
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = "sine";
    oscillator.frequency.value = 440;
    gain.gain.value = 0.2;
    oscillator.connect(gain);
    gain.connect(context.destination);
    oscillator.start();
    const stream = await navigator.mediaDevices.getDisplayMedia({
      video: true,
      audio: true,
      systemAudio: "include",
    });
    const audio = stream.getAudioTracks()[0];
    const surface =
      stream.getVideoTracks()[0]?.getSettings()?.displaySurface ?? "unknown";
    oscillator.stop();
    await context.close();
    for (const track of stream.getTracks()) {
      track.stop();
    }
    return {
      hasTrack: Boolean(audio),
      surface,
      restrictOwnAudio: audio
        ? audio.getSettings().restrictOwnAudio
        : undefined,
    };
  });
  console.log("share-audio-echo control (no restrictOwnAudio on this page):");
  console.log(JSON.stringify(row, null, 2));
  console.log(
    "Paste this plus pqpShareAudioProbe rows from the app in the PR.",
  );
  console.log(
    "This script does not load share-audio-probe.ts in the page; it only proves getDisplayMedia returned an audio track.",
  );
  void probeSource;
} finally {
  await browser?.close();
  server.close();
}
