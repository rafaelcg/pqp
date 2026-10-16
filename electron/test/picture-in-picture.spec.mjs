import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test, expect, _electron as electron } from "@playwright/test";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The share tile's PiP control calls `requestPictureInPicture` on a <video>
 * playing a MediaStream (PQP-5). This pins that the desktop shell, with its
 * real `main.js`, permission handler and window options, lets that through,
 * and that the floating window keeps playing when the app is minimised.
 */
const PAGE = `<!doctype html><html><body style="margin:0;background:#111;color:#eee;font:16px system-ui">
<canvas id="c" width="640" height="360" style="display:none"></canvas>
<video id="v" autoplay muted playsinline style="width:640px;height:360px;background:#000"></video>
<button id="b">PiP</button>
<script>
const c = document.getElementById("c"); const g = c.getContext("2d"); let n = 0;
setInterval(() => { n++; g.fillStyle = "#1a7f37"; g.fillRect(0,0,640,360); g.fillStyle = "#fff";
  g.font = "48px sans-serif"; g.fillText("pqp share " + n, 140, 200); }, 50);
const v = document.getElementById("v"); v.srcObject = c.captureStream(20);
document.getElementById("b").onclick = () => v.requestPictureInPicture().catch(e => { window.pipError = String(e); });
</script></body></html>`;

test("the desktop shell lets a MediaStream video enter picture-in-picture", async () => {
  const server = createServer((_q, r) => {
    r.writeHead(200, { "content-type": "text/html" });
    r.end(PAGE);
  });
  await new Promise((res) => server.listen(0, "127.0.0.1", res));
  const url = `http://127.0.0.1:${server.address().port}/app`;
  let app;
  try {
    app = await electron.launch({
      args: [root],
      env: { ...process.env, PQP_APP_URL: url, NODE_ENV: "test" },
    });
    const win = await app.firstWindow();
    await win.waitForLoadState("domcontentloaded");
    await expect
      .poll(() => win.evaluate(() => document.getElementById("v").videoWidth))
      .toBeGreaterThan(0);
    expect(await win.evaluate(() => document.pictureInPictureEnabled)).toBe(true);
    await win.click("#b");
    await expect
      .poll(() => win.evaluate(() => window.pipError ?? document.pictureInPictureElement?.id ?? null))
      .toBe("v");
    // Minimise the main window: the PiP window must stay up and keep playing.
    await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].minimize());
    await win.waitForTimeout(4000);
    if (process.env.PIP_SCREENSHOT) {
      // A picture of the OS window for a PR, which the page cannot take itself.
      execFileSync("scrot", ["-o", process.env.PIP_SCREENSHOT]);
    }
    const state = await win.evaluate(() => {
      const v = document.pictureInPictureElement;
      return v ? { paused: v.paused, t: v.currentTime } : null;
    });
    expect(state?.paused).toBe(false);
  } finally {
    try {
      await app?.close();
    } finally {
      server.close();
    }
  }
});
