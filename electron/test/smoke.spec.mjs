import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/**
 * DOES THE DESKTOP APP ACTUALLY OPEN.
 *
 * Everything else in this package is a unit test of a helper. None of them
 * launch Electron, so none of them can see the failure that matters most and
 * is the easiest one to ship: the app starts and shows a white window. A bad
 * `require` in main.js, a preload that throws, a window created before the
 * app is ready, a nav policy that blocks its own origin. All of those pass
 * every test in `lib/` and are obvious within a second of opening the binary.
 *
 * This launches the real main.js against a fixture page on a local server, so
 * it needs no API, no Clerk, no network and no built client. It is one process
 * for a few seconds.
 *
 * The bridge assertion is the other half. `lib/desktop-contract.test.mjs`
 * compares the two files as text, which is free but cannot see a member that
 * contextBridge refused to clone at runtime. This reads what the renderer
 * genuinely received.
 */

/** Members of `PqpDesktop` the renderer is allowed to call. */
function contractMembers() {
  const source = readFileSync(
    path.join(root, "..", "client", "src", "lib", "desktop.ts"),
    "utf8",
  );
  const start = source.indexOf("export interface PqpDesktop {");
  const body = source.slice(start, source.indexOf("\n}", start));
  return [...body.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*)\??[(:]/gm)].map((m) => m[1]);
}

const FIXTURE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>pqp smoke</title></head>
<body><main id="app">carregou</main></body></html>`;

async function startFixtureServer() {
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(FIXTURE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, url: `http://127.0.0.1:${port}/app` };
}

test("the desktop shell opens its window and hands the page a working bridge", async () => {
  const { server, url } = await startFixtureServer();
  const consoleErrors = [];
  let app;
  try {
    app = await electron.launch({
      args: [root],
      env: { ...process.env, PQP_APP_URL: url, NODE_ENV: "test" },
    });
    const window = await app.firstWindow();
    window.on("console", (message) => {
      if (message.type() === "error") consoleErrors.push(message.text());
    });
    window.on("pageerror", (error) => consoleErrors.push(String(error)));

    // It reached the page we gave it, rather than an error page or about:blank.
    await window.waitForLoadState("domcontentloaded");
    expect(window.url()).toBe(url);
    await expect(window.locator("#app")).toHaveText("carregou");

    // The window is real and visible, not a zero-sized ghost.
    const size = await window.evaluate(() => ({
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    expect(size.width).toBeGreaterThan(200);
    expect(size.height).toBeGreaterThan(200);

    // The bridge arrived, and carries every member the client may call.
    const bridge = await window.evaluate(() => {
      const desktop = window.pqpDesktop;
      if (!desktop) return null;
      const shape = {};
      for (const key of Object.keys(desktop)) shape[key] = typeof desktop[key];
      return { shape, isElectron: desktop.isElectron, platform: desktop.platform };
    });
    expect(bridge, "preload did not expose pqpDesktop to the renderer").not.toBeNull();
    expect(bridge.isElectron).toBe(true);
    expect(typeof bridge.platform).toBe("string");

    const wanted = contractMembers();
    expect(wanted.length, "parsed no members, so this assertion proves nothing").toBeGreaterThan(10);
    const missing = wanted.filter((name) => !(name in bridge.shape));
    expect(missing, "the renderer cannot call these, so those features do nothing").toEqual([]);

    expect(consoleErrors, "the renderer logged errors on a blank page").toEqual([]);
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
