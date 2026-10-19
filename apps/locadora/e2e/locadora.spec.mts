import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type BrowserContext, type Frame, type Page } from "@playwright/test";
import { GBA_GREEN, NES_GREEN, gbaPattern, nesPattern } from "./patterns.ts";
import { startRig, type Rig } from "./rig.ts";

/*
 * Locadora in a real sandboxed frame (`sandbox="allow-scripts"`, an opaque origin) under the CSP the packager
 * writes for it, with a canary server on another port. The images are generated test patterns, not games:
 * written to a temp folder for the test and removed after (e2e/patterns.ts). The file gets a random hex name,
 * and one test checks that name never crosses into the frame or onto the network.
 */

test.describe.configure({ mode: "serial" });

let rig: Rig;
let scratch: string;

test.beforeAll(async () => {
  rig = await startRig();
  scratch = mkdtempSync(join(tmpdir(), "pqp-locadora-patterns-"));
});

test.afterAll(async () => {
  await rig.close();
  rmSync(scratch, { recursive: true, force: true });
});

interface Opened {
  context: BrowserContext;
  page: Page;
  frame: Frame;
  requests: string[];
  problems: string[];
  /** The Content-Security-Policy header the frame document came with. */
  csp: () => string;
  /** The frame's policy violations as they stood before the first screenshot. */
  beforeShots?: Array<{ directive: string; blocked: string }>;
}

async function open(browser: Browser, query = ""): Promise<Opened> {
  const context = await browser.newContext({ viewport: { width: 900, height: 760 } });
  await rig.allowHostAsAncestor(context);
  // every document records its CSP violations, so a "blocked" is something we can count
  await context.addInitScript(() => {
    const w = window as unknown as { __csp: Array<{ directive: string; blocked: string }> };
    w.__csp = [];
    document.addEventListener("securitypolicyviolation", (event) => {
      w.__csp.push({ directive: event.effectiveDirective, blocked: String(event.blockedURI).slice(0, 80) });
    });
  });
  const page = await context.newPage();
  const requests: string[] = [];
  const problems: string[] = [];
  const holder: { opened?: Opened } = {};
  let csp = "";
  page.on("request", (request) => requests.push(request.url()));
  page.on("response", (response) => {
    if (response.url() === rig.frameUrl) csp = response.headers()["content-security-policy"] ?? "";
  });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  // the frame's permissions policy refuses the screen wake lock the core asks for; `shim.ts` answers it, so
  // neither a console error nor a page error is expected from it
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // WebKit reports the <style> Playwright injects for a screenshot as a refused stylesheet: the test's own doing
    if (holder.opened?.beforeShots && /Refused to apply a stylesheet/.test(message.text())) return;
    problems.push(`console error: ${message.text()}`);
  });
  await page.goto(`${rig.hostOrigin}/?src=${encodeURIComponent(rig.frameUrl)}${query}`);
  const handle = await page.waitForSelector("iframe#app");
  const frame = (await handle.contentFrame())!;
  await frame.locator("#loc:not([data-view=connecting])").waitFor();
  holder.opened = { context, page, frame, requests, problems, csp: () => csp };
  return holder.opened;
}

/** Picks a file through the host's picker (a file input standing in for it), by name and bytes. */
async function pickFile(opened: Opened, name: string, buffer: Buffer) {
  const path = join(scratch, name);
  writeFileSync(path, buffer);
  await opened.frame.locator("#choose, #choose-another").filter({ visible: true }).click();
  await opened.page.waitForFunction(() => (window as unknown as { __pickWaiting?: boolean }).__pickWaiting === true);
  await opened.page.setInputFiles("#pick", path);
}

/** The click on the emulator's own Start button: the user gesture that lets the audio run. */
async function startGame(frame: Frame) {
  const start = frame.locator(".ejs_start_button");
  await start.waitFor({ state: "visible", timeout: 30_000 });
  await start.click();
}

async function centerPixel(opened: Opened): Promise<[number, number, number]> {
  // Playwright's screenshot injects a <style> into the frame (WebKit reports it as an inline style violation of
  // the frame's own policy), so what the APP did is read once the game is up and BEFORE the first screenshot.
  if (!opened.beforeShots) {
    await opened.page.waitForTimeout(700);
    opened.beforeShots = await cspViolations(opened.frame);
  }
  const png = await opened.frame
    .locator("canvas.ejs_canvas")
    .screenshot({ caret: "initial", animations: "allow", timeout: 15_000 });
  return opened.page.evaluate(async (base64) => {
    const image = new Image();
    image.src = `data:image/png;base64,${base64}`;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = image.width;
    canvas.height = image.height;
    const context = canvas.getContext("2d")!;
    context.drawImage(image, 0, 0);
    const d = context.getImageData(image.width >> 1, image.height >> 1, 1, 1).data;
    return [d[0]!, d[1]!, d[2]!] as [number, number, number];
  }, png.toString("base64"));
}

function near(actual: number[], expected: { r: number; g: number; b: number }, tolerance = 10): boolean {
  return (
    Math.abs(actual[0]! - expected.r) <= tolerance &&
    Math.abs(actual[1]! - expected.g) <= tolerance &&
    Math.abs(actual[2]! - expected.b) <= tolerance
  );
}

async function expectPaints(opened: Opened, color: { r: number; g: number; b: number }) {
  await expect
    .poll(async () => near(await centerPixel(opened), color), { timeout: 30_000, intervals: [400] })
    .toBe(true);
}

type Violation = { directive: string; blocked: string };

async function cspViolations(frame: Frame): Promise<Violation[]> {
  return frame.evaluate(() => (window as unknown as { __csp: Violation[] }).__csp);
}

/** The policy violations the app itself caused: those seen before the test's own screenshots. */
async function appViolations(opened: Opened): Promise<Violation[]> {
  return opened.beforeShots ?? cspViolations(opened.frame);
}

const randomName = (extension: string) => `${Math.random().toString(16).slice(2, 10)}${extension}`;

test("the frame runs under the S0 spike's Tier B policy, exactly: no eval, no blob scripts, no workers, no network", async ({ browser }) => {
  const opened = await open(browser);
  const directives = Object.fromEntries(
    opened
      .csp()
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean)
      .map((part) => {
        const [name, ...values] = part.split(/\s+/);
        return [name!, values.join(" ")];
      }),
  );
  delete directives["frame-ancestors"]; // the one thing the rig rewrites, to let its own host page embed the frame
  expect(directives).toEqual({
    "default-src": "'none'",
    "script-src": "'self' 'wasm-unsafe-eval'",
    "style-src": "'self'",
    "img-src": "'self' data: blob:",
    "font-src": "'self'",
    "media-src": "blob:",
    "connect-src": "blob:",
    "base-uri": "'none'",
    "form-action": "'none'",
  });
  // and the iframe is the sandbox of D5: scripts only, no same-origin, no permissions
  const iframe = opened.page.locator("iframe#app");
  await expect(iframe).toHaveAttribute("sandbox", "allow-scripts");
  await expect(iframe).toHaveAttribute("allow", "");
  await opened.context.close();
});

test("the shelf says what it is, in pt-BR, and offers one thing", async ({ browser }) => {
  const opened = await open(browser);
  const { frame } = opened;
  await expect(frame.locator("#choose")).toHaveText("Escolher jogo");
  await expect(frame.locator("#intro")).toContainText("não fornece jogo nenhum");
  await expect(frame.locator("#rights")).toContainText("tem direito de jogar");
  await expect(frame.locator("#privacy")).toContainText("nunca é enviado");
  const text = await frame.locator("main").innerText();
  expect(text).not.toMatch(/voc[eê]/i);
  expect(text).not.toContain("—");
  // the controls help opens and closes, and the toggle says which
  await frame.locator("#controls-toggle").click();
  await expect(frame.locator("#controls")).toBeVisible();
  await expect(frame.locator("#controls-toggle")).toHaveAttribute("aria-expanded", "true");
  await frame.locator("#controls-toggle").click();
  await expect(frame.locator("#controls")).toBeHidden();
  expect(opened.problems).toEqual([]);
  await opened.context.close();
});

test("the licenses are in the app: the third-party notices open from the bundle, with the source links", async ({ browser }) => {
  const opened = await open(browser);
  const { frame, page } = opened;
  await expect(frame.locator("#notices")).toBeHidden();
  await frame.locator("#notices-toggle").click();
  await expect(frame.locator("#notices")).toBeVisible();
  await expect(frame.locator("#notices-toggle")).toHaveAttribute("aria-expanded", "true");
  const text = frame.locator("#notices-text");
  await expect(text).toContainText("EmulatorJS 4.2.3");
  for (const needle of [
    "GPL-3.0-only",
    "GPL-2.0-or-later",
    "MPL-2.0",
    "https://github.com/EmulatorJS/EmulatorJS",
    "https://github.com/libretro/libretro-fceumm",
    "https://github.com/mgba-emu/mgba",
  ]) {
    await expect(text).toContainText(needle);
  }
  expect(await page.evaluate(() => (window as unknown as { __h: { assetsServed: string[] } }).__h.assetsServed)).toEqual(["notices.txt"]);
  await frame.locator("#notices-toggle").click();
  await expect(frame.locator("#notices")).toBeHidden();
  expect(opened.problems).toEqual([]);
  await opened.context.close();
});

test("a Game Boy Advance pattern runs: it paints, the sound starts after the click, nothing leaves", async ({ browser }) => {
  const opened = await open(browser);
  const { frame, page } = opened;
  const secret = randomName(".gba");

  await pickFile(opened, secret, gbaPattern());
  await expect(frame.locator("#v-play")).toBeVisible();
  await expect(frame.locator("#start-hint")).toContainText("Iniciar jogo");
  await startGame(frame);
  await expectPaints(opened, GBA_GREEN);
  await expect(frame.locator("#start-hint")).toBeHidden();

  // the audio context is running because the click on the emulator's own Start button was a user gesture
  const audio = await frame.evaluate(() => {
    type Context = { state?: string };
    type Module = { SDL2?: { audioContext?: Context }; AL?: { currentCtx?: { audioCtx?: Context } } };
    const module = (window as unknown as { EJS_emulator?: { Module?: Module } }).EJS_emulator?.Module;
    return { sdl: module?.SDL2?.audioContext?.state, al: module?.AL?.currentCtx?.audioCtx?.state };
  });
  expect([audio.sdl, audio.al]).toContain("running");

  // the emulator's own fullscreen button is gone (the host fullscreens the frame); ours asks the host
  await expect(frame.locator("[title='Enter Fullscreen'], [title='Tela cheia']").filter({ hasNot: frame.locator("#fullscreen") })).toHaveCount(0);
  await frame.locator("#fullscreen").click();
  await expect(frame.locator("#fullscreen")).toHaveText("Sair da tela cheia");
  expect(await page.evaluate(() => (window as unknown as { __h: { fullscreen: boolean[] } }).__h.fullscreen)).toEqual([true]);

  // no request left the two allowed origins, and the canary saw nothing
  const foreign = opened.requests.filter(
    (url) => !url.startsWith(rig.hostOrigin) && !url.startsWith(rig.appsOrigin) && !url.startsWith("blob:") && !url.startsWith("data:"),
  );
  expect(foreign).toEqual([]);
  expect(rig.canaryHits).toEqual([]);

  // the file's name never crossed: not over the port, not on the network
  const sent = await page.evaluate(() => (window as unknown as { __h: { requests: string[] } }).__h.requests.join("\n"));
  expect(sent).not.toContain(secret);
  expect(sent).not.toContain(secret.replace(".gba", ""));
  expect(opened.requests.join("\n")).not.toContain(secret.replace(".gba", ""));
  expect(await page.evaluate(() => (window as unknown as { __h: { sentToFrame: unknown } }).__h.sentToFrame)).toEqual({
    keys: ["bytes", "ext"],
    ext: ".gba",
    size: gbaPattern().length,
  });

  // the bytes came from the host, hash checked, the two files the core needs and nothing else
  expect(await page.evaluate(() => (window as unknown as { __h: { assetsServed: string[] } }).__h.assetsServed.sort())).toEqual([
    "mgba-core.pqpc",
    "mgba.json",
  ]);

  // the permissions policy refuses the screen wake lock and nothing is allowed to show it as an error
  expect(await appViolations(opened)).toEqual([]);
  expect(opened.problems).toEqual([]);
  await opened.context.close();
});

test("an NES pattern runs too, on the other core", async ({ browser }) => {
  const opened = await open(browser);
  const { frame, page } = opened;
  await pickFile(opened, randomName(".nes"), nesPattern());
  await startGame(frame);
  await expectPaints(opened, NES_GREEN);
  expect(await page.evaluate(() => (window as unknown as { __h: { assetsServed: string[] } }).__h.assetsServed.sort())).toEqual([
    "fceumm-core.pqpc",
    "fceumm.json",
  ]);
  expect(await appViolations(opened)).toEqual([]);
  expect(rig.canaryHits).toEqual([]);
  expect(opened.problems).toEqual([]);
  await opened.context.close();
});

test("another game can be picked in the same frame", async ({ browser }) => {
  const opened = await open(browser);
  const { frame } = opened;
  await pickFile(opened, randomName(".nes"), nesPattern());
  await startGame(frame);
  await expectPaints(opened, NES_GREEN);

  await pickFile(opened, randomName(".gba"), gbaPattern());
  await startGame(frame);
  await expectPaints(opened, GBA_GREEN);
  expect(await appViolations(opened)).toEqual([]);
  expect(rig.canaryHits).toEqual([]);
  await opened.context.close();
});

/*
 * Sharing the pane and watching it are built DARK (D14, Legal Gate L1b): the host stand-in answers `share.request`
 * with `not-allowed` unless the test says `?share=on`, the way the real host does while `locadora_share` is off.
 * The platform side (the flag, `shareAllowed` on the config, the spectator refusal) is tested with the platform's
 * own PRs; these are the app's two states.
 */
test("sharing, flag off: no control, one refused probe, and no share is ever asked for", async ({ browser }) => {
  const opened = await open(browser);
  const { frame, page } = opened;
  await pickFile(opened, randomName(".nes"), nesPattern());
  await startGame(frame);
  await expectPaints(opened, NES_GREEN);
  await expect(frame.locator("#share")).toBeHidden();
  await expect(frame.locator("#sharing")).toBeHidden();
  const shares = await page.evaluate(() => (window as unknown as { __h: { shares: unknown[] } }).__h.shares);
  // the only call is the probe, a request to STOP sharing, and it was refused
  expect(shares).toEqual([{ on: false, allowed: false }]);
  await opened.context.close();
});

test("sharing, flag on: the control shares the pane and stops it", async ({ browser }) => {
  const opened = await open(browser, "&share=on");
  const { frame, page } = opened;
  // no control before there is a game on screen
  await expect(frame.locator("#share")).toBeHidden();
  await pickFile(opened, randomName(".gba"), gbaPattern());
  await startGame(frame);
  await expectPaints(opened, GBA_GREEN);
  const share = frame.locator("#share");
  await expect(share).toBeVisible();
  await expect(share).toHaveText("Compartilhar");
  await expect(share).toHaveAttribute("aria-pressed", "false");
  await share.click();
  await expect(share).toHaveText("Parar de compartilhar");
  await expect(share).toHaveAttribute("aria-pressed", "true");
  await expect(frame.locator("#sharing")).toContainText("compartilhada");
  await share.click();
  await expect(share).toHaveText("Compartilhar");
  await expect(frame.locator("#sharing")).toBeHidden();
  const shares = await page.evaluate(() => (window as unknown as { __h: { shares: Array<{ on: boolean }> } }).__h.shares);
  expect(shares.map((s) => s.on)).toEqual([false, true, false]);
  expect(await appViolations(opened)).toEqual([]);
  expect(opened.problems).toEqual([]);
  await opened.context.close();
});

test("a watcher sees whose game is on screen and has nothing to pick", async ({ browser }) => {
  const opened = await open(browser, "&role=spectator&share=on");
  const { frame, page } = opened;
  await expect(frame.locator("#v-watch")).toBeVisible();
  await expect(frame.locator("#watching-title")).toHaveText("Tu tá assistindo");
  await expect(frame.locator("#watching-line")).toHaveText("Aparece a tela do jogo de Ana, Bia.");
  await expect(frame.locator("#watching-how")).toContainText("O pqp só passa a imagem");
  await expect(frame.locator("#v-shelf")).toBeHidden();
  await expect(frame.locator("#choose")).toBeHidden();
  await expect(frame.locator("#share")).toBeHidden();
  // a watcher never asks to share
  expect(await page.evaluate(() => (window as unknown as { __h: { shares: unknown[] } }).__h.shares)).toEqual([]);
  const text = await frame.locator("main").innerText();
  expect(text).not.toMatch(/voc[eê]/i);
  expect(opened.problems).toEqual([]);
  await opened.context.close();
});

test("a file with another extension is refused by the host and the shelf says so", async ({ browser }) => {
  const opened = await open(browser);
  const { frame } = opened;
  await pickFile(opened, randomName(".zip"), Buffer.from("not a game"));
  await expect(frame.locator("#problem")).toContainText("Escolhe um .nes, .gb, .gbc ou .gba");
  await expect(frame.locator("#v-shelf")).toBeVisible();
  await opened.context.close();
});

test("the end of the session stops the game and says so", async ({ browser }) => {
  const opened = await open(browser);
  const { frame, page } = opened;
  await pickFile(opened, randomName(".nes"), nesPattern());
  await startGame(frame);
  await expectPaints(opened, NES_GREEN);
  await page.evaluate(() => (window as unknown as { __h: { end(): void } }).__h.end());
  await expect(frame.locator("#ended")).toHaveText("A sessão acabou.");
  await expect(frame.locator("#v-play")).toBeHidden();
  await opened.context.close();
});

/**
 * The spike's negative checks, run INSIDE the real frame with the real CSP (S0 spike, "Negative checks"). Each
 * probe tries a way out; a probe that is allowed is reported as ALLOWED. The three that cannot say so
 * themselves (a form submit and a beacon are silent, and a top navigation is only refused in the console) are
 * proved by the canary instead. The two `preconnect` and `dns-prefetch` probes of the spike are left out:
 * WebKit opens a bare TCP connection for `preconnect` whatever the CSP says (host name only, no body, an accepted
 * residual of the plan), and Locadora creates no such element.
 */
async function runEscapeProbes(frame: Frame, canaryPort: number): Promise<Record<string, string>> {
  return frame.evaluate(async (port) => {
    const out: Record<string, string> = {};
    const jobs: Array<Promise<void>> = [];
    const canary = `http://localhost:${port}`;
    const rec = (name: string, p: Promise<unknown>) =>
      jobs.push(
        p.then(
          (v) => {
            out[name] = `ALLOWED ${String(v).slice(0, 60)}`;
          },
          (e) => {
            out[name] = `blocked: ${(e && (e as Error).name) || e}`;
          },
        ),
      );
    const sync = (name: string, f: () => unknown) => {
      try {
        out[name] = `ALLOWED ${String(f()).slice(0, 60)}`;
      } catch (e) {
        out[name] = `blocked: ${(e as Error).name}`;
      }
    };
    rec("fetch https://example.com", fetch("https://example.com/", { mode: "no-cors" }).then((r) => r.type));
    rec("fetch canary", fetch(`${canary}/fetch`, { mode: "no-cors" }).then((r) => r.type));
    rec("fetch own index.js", fetch("./index.js").then((r) => r.status));
    rec("fetch own origin /", fetch("/").then((r) => r.status));
    rec("fetch data:", fetch("data:text/plain,hi").then((r) => r.text()));
    rec("XHR canary", new Promise((resolve, reject) => {
      const x = new XMLHttpRequest();
      x.open("GET", `${canary}/xhr`);
      x.onload = () => resolve(x.status);
      x.onerror = () => reject(new Error("xhr error"));
      x.send();
    }));
    rec("WebSocket canary", new Promise((resolve, reject) => {
      try {
        const w = new WebSocket(`ws://localhost:${port}/ws`);
        w.onopen = () => resolve("open");
        w.onerror = () => reject(new Error("ws error"));
      } catch (e) {
        reject(e);
      }
    }));
    rec("EventSource canary", new Promise((resolve, reject) => {
      try {
        const w = new EventSource(`${canary}/es`);
        w.onopen = () => resolve("open");
        w.onerror = () => {
          w.close();
          reject(new Error("es error"));
        };
      } catch (e) {
        reject(e);
      }
    }));
    sync("sessionStorage", () => window.sessionStorage.length);
    sync("document.cookie read", () => document.cookie);
    sync("document.cookie write", () => {
      document.cookie = "a=b";
    });
    sync("indexedDB.open", () => indexedDB.open("x"));
    sync("parent.document", () => (parent as Window).document.title);
    sync("top.location read", () => (top as Window).location.href);
    sync("window.open", () => {
      const w = window.open(`${canary}/open`);
      if (!w) throw new Error("null");
      return "opened";
    });
    // `eval` and `new Function` are not probed here: Playwright's own evaluate is exempt from the eval rule, so
    // they would answer ALLOWED for the wrong reason. The header test below pins that `script-src` has no
    // 'unsafe-eval' and the spike (docs/APPS.md) ran them from the frame's own script: both EvalError.
    sync("inline script", () => {
      const s = document.createElement("script");
      s.textContent = "window.__inl=1";
      document.head.appendChild(s);
      if ((window as unknown as { __inl?: number }).__inl !== 1) throw new Error("did not run");
      return "ran";
    });
    // silent ones: no throw whether they work or not, the canary is the judge
    sync("sendBeacon canary", () => navigator.sendBeacon(`${canary}/beacon`, "x"));
    sync("top.location assign", () => {
      (top as Window).location.href = `${canary}/top`;
    });
    sync("form submit", () => {
      const f = document.createElement("form");
      f.method = "POST";
      f.action = `${canary}/form`;
      document.body.appendChild(f);
      f.submit();
    });
    const element = (name: string, tag: string, attrs: Record<string, string>) =>
      jobs.push(
        new Promise<void>((resolve) => {
          const e = document.createElement(tag);
          for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
          e.onload = () => {
            out[name] = "ALLOWED (loaded)";
            resolve();
          };
          e.onerror = () => {
            out[name] = "blocked (error event)";
            resolve();
          };
          document.body.appendChild(e);
          setTimeout(() => {
            if (!(name in out)) out[name] = "no event in 2s";
            resolve();
          }, 2000);
        }),
      );
    element("img https://example.com", "img", { src: "https://example.com/x.png" });
    element("img canary", "img", { src: `${canary}/img.png` });
    element("script canary", "script", { src: `${canary}/s.js` });
    element("link css canary", "link", { rel: "stylesheet", href: `${canary}/c.css` });
    element("iframe canary", "iframe", { src: `${canary}/frame` });
    element("audio canary", "audio", { src: `${canary}/a.mp3` });
    element("link prefetch canary", "link", { rel: "prefetch", href: `${canary}/prefetch` });
    await Promise.all(jobs);
    // the storage shim: localStorage is null, not an object that works
    out["localStorage"] = `value ${String((window as unknown as { localStorage: unknown }).localStorage)}`;
    return out;
  }, canaryPort);
}

test("the sandbox has no way out: every probe fails inside the frame and the canary sees nothing", async ({ browser }) => {
  const opened = await open(browser);
  const before = rig.canaryHits.length;
  const results = await runEscapeProbes(opened.frame, rig.canaryPort);
  // let any late request reach the canary before it is read
  await opened.page.waitForTimeout(1500);

  // These do not throw or fire an error event whether they work or not (a beacon returns true even when the
  // send is refused, a refused iframe still fires `load` with the browser's error page, a form submit and a top
  // navigation are refused in the console only), so the canary and the top page's URL are their judge.
  const SILENT = ["sendBeacon canary", "form submit", "iframe canary", "top.location assign"];
  const allowed = Object.entries(results).filter(([name, verdict]) => !SILENT.includes(name) && verdict.startsWith("ALLOWED"));
  expect(allowed, JSON.stringify(results, null, 1)).toEqual([]);
  expect(results["localStorage"]).toBe("value null");
  expect(Object.keys(results).length).toBeGreaterThan(20);
  expect(rig.canaryHits.length - before, JSON.stringify(rig.canaryHits.slice(before))).toBe(0);
  // the top page is still the host: a top navigation was refused
  expect(opened.page.url().startsWith(rig.hostOrigin)).toBe(true);
  expect((await cspViolations(opened.frame)).length).toBeGreaterThan(5);
  await opened.context.close();
});
