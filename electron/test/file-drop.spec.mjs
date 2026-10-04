import { test, expect, _electron as electron } from "@playwright/test";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/**
 * A FILE DROPPED ON THE DESKTOP WINDOW.
 *
 * The failure this exists for: let go of a file from Finder or Explorer over a
 * Chromium page that does not handle the drop, and Chromium navigates to the
 * file, so the window that was the app is now a bare `file://` document (and a
 * call in progress with it). In Electron that navigation is reported as
 * `will-navigate`, which main.js turns into `preventDefault()` for anything the
 * nav policy calls "block" (`lib/nav-policy.js`).
 *
 * The drop is a real one, not a synthetic event: `Input.dispatchDragEvent` is
 * the DevTools protocol command that hands the renderer an OS file drag, with a
 * real path, going through the same drag-and-drop pipeline as Finder. The two
 * tests are the two layers that stop the navigation, and each is asserted on
 * its own so one cannot hide the other:
 *
 *  1. THE SHELL's `will-navigate` handler, asked about a `file://` target
 *     (see the note in the test for why that is asked directly).
 *  2. THE PAGE, with the client's own `installFileDropGuard`, compiled from
 *     `client/src/lib/file-drop.ts`, taking real injected drops of a file, a
 *     folder and both. No `will-navigate` at all, and the window stays put.
 *
 * What this cannot cover is the OS half: that Finder / Explorer hand Chromium a
 * file through the same pipeline. That is the same on all three platforms in
 * Chromium, but it was only run on macOS (see the PR).
 */

const requireFromClient = createRequire(
  path.join(root, "..", "client", "package.json"),
);

/** `client/src/lib/file-drop.ts` as the browser would run it. It has no imports. */
function compiledGuard() {
  const ts = requireFromClient("typescript");
  const source = readFileSync(
    path.join(root, "..", "client", "src", "lib", "file-drop.ts"),
    "utf8",
  );
  return ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
  }).outputText;
}

const BARE = `<!doctype html><html><head><meta charset="utf-8"><title>bare</title></head>
<body style="margin:0"><main id="app" style="width:600px;height:400px;background:#222;color:#fff">bare page</main></body></html>`;

const GUARDED = `<!doctype html><html><head><meta charset="utf-8"><title>guarded</title></head>
<body style="margin:0"><main id="app" style="width:600px;height:400px;background:#222;color:#fff">guarded page</main>
<script type="module">
  import { installFileDropGuard } from "/file-drop.js";
  installFileDropGuard();
  window.__guarded = true;
</script></body></html>`;

async function startServer(guardJs) {
  const server = createServer((req, res) => {
    if (req.url === "/file-drop.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(guardJs);
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(req.url?.startsWith("/guarded") ? GUARDED : BARE);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return { server, base: `http://127.0.0.1:${port}` };
}

/** A real file on disk, to be handed to the window the way the OS would. */
function makeDroppable() {
  const dir = mkdtempSync(path.join(tmpdir(), "pqp-drop-"));
  const file = path.join(dir, "screenshot.png");
  writeFileSync(file, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64"));
  const folder = path.join(dir, "a folder");
  mkdirSync(folder);
  return { file, folder };
}

/**
 * Enter, hover, drop: an OS file drag onto the middle of the window, through
 * the main process's own debugger so the renderer cannot tell it from Finder.
 */
async function osDrop(app, paths) {
  await app.evaluate(async ({ BrowserWindow }, files) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    if (!wc.debugger.isAttached()) wc.debugger.attach("1.3");
    const data = { items: [], files, dragOperationsMask: 1 };
    for (const type of ["dragEnter", "dragOver", "drop"]) {
      await wc.debugger.sendCommand("Input.dispatchDragEvent", {
        type,
        x: 200,
        y: 200,
        data,
      });
    }
  }, paths);
}

/** From the main process: every `will-navigate` this window raised, and whether it was stopped. */
async function watchNavigation(app) {
  await app.evaluate(({ BrowserWindow }) => {
    const wc = BrowserWindow.getAllWindows()[0].webContents;
    globalThis.__pqpNav = [];
    // Registered AFTER main.js's handler, so `defaultPrevented` is its verdict.
    wc.on("will-navigate", (event, url) => {
      globalThis.__pqpNav.push({ url, prevented: event.defaultPrevented });
    });
  });
}

const navigations = (app) => app.evaluate(() => globalThis.__pqpNav);
const windowUrl = (app) =>
  app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0].webContents.getURL());

async function launch(url) {
  return electron.launch({
    args: [root],
    env: { ...process.env, PQP_APP_URL: url, NODE_ENV: "test" },
  });
}

test("the shell's navigation handler refuses a local file, which is what an unhandled drop asks for", async () => {
  const { server, base } = await startServer(compiledGuard());
  const url = `${base}/bare`;
  const { file } = makeDroppable();
  let app;
  try {
    app = await launch(url);
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.locator("#app")).toHaveText("bare page");

    // The event an unclaimed OS drop raises is a browser-initiated navigation
    // to `file://`, and nothing a test can inject starts one: the DevTools
    // drag has no OS drop target behind it, and a page asking for `file://`
    // itself is refused by the renderer before the shell is ever told. So the
    // handler main.js registered is asked directly, through the real
    // `webContents`, with the event shape Electron gives it. What this pins is
    // the wiring (the handler exists on THIS window, uses the real allowed
    // origin, and prevents); the decision table is `lib/nav-policy.test.mjs`.
    const verdicts = await app.evaluate(({ BrowserWindow }, targets) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      return targets.map((target) => {
        let prevented = false;
        wc.emit("will-navigate", { preventDefault: () => (prevented = true) }, target);
        return { target, prevented };
      });
    }, [
      "file://" + file,
      "file:///C:/Users/someone/Desktop/screenshot.png",
      "file:///etc/hosts",
    ]);
    for (const verdict of verdicts) {
      expect(verdict.prevented, `${verdict.target} was left to navigate`).toBe(true);
    }

    // And the same handler still lets the app's own navigations through.
    const own = await app.evaluate(({ BrowserWindow }, target) => {
      const wc = BrowserWindow.getAllWindows()[0].webContents;
      let prevented = false;
      wc.emit("will-navigate", { preventDefault: () => (prevented = true) }, target);
      return prevented;
    }, url + "/somewhere");
    expect(own).toBe(false);
    expect(await windowUrl(app)).toBe(url);
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
});

test("with the client's drop guard in the page, a dropped file never even tries to navigate", async () => {
  const { server, base } = await startServer(compiledGuard());
  const url = `${base}/guarded`;
  const { file, folder } = makeDroppable();
  let app;
  try {
    app = await launch(url);
    const window = await app.firstWindow();
    await window.waitForLoadState("domcontentloaded");
    await expect(window.locator("#app")).toHaveText("guarded page");
    await window.waitForFunction(() => window.__guarded === true);
    await watchNavigation(app);
    // What makes this test able to fail: a recorder that runs AFTER the guard
    // on `window`, noting whether each file drag was claimed. An unclaimed
    // dragover or drop is the one a browser answers by opening the file, and
    // it is what a page with no guard would show here.
    await window.evaluate(() => {
      window.__drags = [];
      for (const type of ["dragover", "drop"]) {
        window.addEventListener(type, (event) => {
          if ([...event.dataTransfer.types].includes("Files")) {
            window.__drags.push({ type, claimed: event.defaultPrevented });
          }
        });
      }
    });

    await osDrop(app, [file]);
    await osDrop(app, [folder]);
    await osDrop(app, [file, folder]);
    await window.waitForTimeout(1500);

    const drags = await window.evaluate(() => window.__drags);
    // Three drops, each hovered at least once. The guard answers the hover
    // "none", so Chromium delivers no `drop` at all (and if one did arrive it
    // would be in this list and have to be claimed too).
    expect(drags.filter((d) => d.type === "dragover").length, "no file drag reached the page").toBeGreaterThanOrEqual(3);
    expect(drags.every((d) => d.claimed), "a file drag was left to the browser").toBe(true);
    expect(await navigations(app)).toEqual([]);
    expect(await windowUrl(app)).toBe(url);
    await expect(window.locator("#app")).toHaveText("guarded page");
  } finally {
    if (app) await app.close();
    await new Promise((resolve) => server.close(resolve));
  }
});
