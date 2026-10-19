import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { buildAppFrameFixtures } from "./build";
import { startServers, type Servers } from "./servers";

/**
 * The frame, the policy and the bridge, in a real browser. See
 * `playwright.app-frame.config.ts` for what is real here (the controller, the
 * bridge host, the SDK, the sandbox, the CSP header) and what stands in (the
 * session transport, the apps origin).
 *
 * The attack frames (`frames/hostile.js`) try to get something out. The canary
 * server counts every request that reaches it: zero is the pass.
 */

let dir: string;
let servers: Servers;

test.beforeAll(async () => {
  dir = mkdtempSync(path.join(tmpdir(), "pqp-app-frame-"));
  await buildAppFrameFixtures(dir);
  servers = await startServers(dir);
});
test.afterAll(async () => {
  await servers?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});
test.beforeEach(() => {
  servers.hits.length = 0;
});

const entry = (app: "coop" | "hostile", query = "") => `${servers.apps}/${app}/1.0.0/index.html${query}`;
const hostile = (attack: string) => entry("hostile", `?a=${attack}&c=${encodeURIComponent(servers.canary)}`);

async function openHost(page: Page) {
  await page.goto(servers.host);
  await page.waitForFunction(() => Boolean(window.__e2e));
}

const settle = (page: Page, ms = 1500) => page.waitForTimeout(ms);

test.describe("a cooperative app", () => {
  test("runs end to end in the sandbox under the real CSP, through the real handshake", async ({ page }) => {
    const problems: string[] = [];
    page.on("console", (m) => {
      if (m.type() === "error") problems.push(m.text());
    });
    await openHost(page);
    await page.evaluate((url) => window.__e2e.mount({ entry: url, appsOrigin: new URL(url).origin }), entry("coop"));

    const frame = page.frameLocator("iframe[data-app-frame]");
    await expect(frame.locator("#hello")).toHaveText("coop@1.0.0 pt-BR seat-selfselfselfself");
    await expect(frame.locator("#people")).toHaveText("Raf,Bia");
    await page.waitForFunction(() => window.__e2e.statuses.some((s) => s.kind === "ready"));

    // the frame is the sandbox it should be
    const attrs = await page.locator("iframe[data-app-frame]").evaluate((el) => ({
      sandbox: el.getAttribute("sandbox"),
      allow: el.getAttribute("allow"),
      referrerpolicy: el.getAttribute("referrerpolicy"),
    }));
    expect(attrs).toEqual({ sandbox: "allow-scripts", allow: "", referrerpolicy: "no-referrer" });
    // and it loaded one document, once
    expect(await page.evaluate(() => window.__e2e.loads[0])).toBe(1);

    // state: the app writes through the bridge, the transport sees it; a push reaches the app
    await frame.locator("#patch").click();
    await expect(frame.locator("#patched")).toHaveText("rev:1");
    expect(await page.evaluate(() => window.__e2e.transport.patches)).toEqual([{ patch: { n: 1 }, baseRev: undefined }]);
    await page.evaluate(() => window.__e2e.transport.handlers!.onState(7, { n: 7 }));
    await expect(frame.locator("#state")).toHaveText('rev:7:{"n":7}');

    // events
    await frame.locator("#ping").click();
    await expect(frame.locator("#pinged")).toHaveText("ok");
    expect(await page.evaluate(() => window.__e2e.transport.events)).toEqual([{ name: "ping", data: { a: 1 } }]);

    // the session ending reaches the app
    await page.evaluate(() => window.__e2e.transport.handlers!.onEnded("host"));
    await expect(frame.locator("#ended")).toHaveText("host");
    await page.waitForFunction(() => window.__e2e.statuses.some((s) => s.kind === "ended"));

    // the page's frame-src policy is in the head exactly once
    expect(await page.locator("head meta[http-equiv='Content-Security-Policy']").count()).toBe(1);
    expect(problems.filter((p) => !/favicon/i.test(p))).toEqual([]);
  });

  test("files.pickLocal opens the page's own picker; the app gets bytes and an extension, never the name", async ({ page }) => {
    await openHost(page);
    await page.evaluate((url) => window.__e2e.mount({ entry: url, appsOrigin: new URL(url).origin, localFiles: true }), entry("coop"));
    const frame = page.frameLocator("iframe[data-app-frame]");
    await expect(frame.locator("#hello")).toContainText("coop@1.0.0");

    const chooser = page.waitForEvent("filechooser");
    await frame.locator("#pick").click();
    const picker = await chooser;
    await picker.setFiles({ name: "My Private Title.GBA", mimeType: "application/octet-stream", buffer: Buffer.from([1, 2, 3, 4]) });
    await expect(frame.locator("#picked")).toHaveText("ext=.gba,len=4,keys=bytes+ext");
    const text = await frame.locator("body").innerText();
    expect(text).not.toMatch(/private|title/i);
  });
});

test.describe("no request leaves the frame", () => {
  test("fetch, XHR, WebSocket, EventSource, beacon, img, script, css, audio, iframe, form, window.open, top.location: the canary hears nothing", async ({ page }) => {
    await openHost(page);
    await page.evaluate((url) => window.__e2e.mount({ entry: url, appsOrigin: new URL(url).origin }), hostile("net"));
    const frame = page.frameLocator("iframe[data-app-frame]");
    await expect(frame.locator("#r")).toContainText("cookie");
    expect(await page.evaluate(() => window.__e2e.ran)).toContain("net");
    await settle(page);
    expect(servers.hits, `the canary was reached: ${servers.hits.join(" ")}`).toEqual([]);

    const results = JSON.parse(await frame.locator("#r").innerText()) as Record<string, string>;
    // the things the sandbox and CSP are supposed to take away, read back from the frame itself
    expect(results.eval).toMatch(/^threw:/);
    expect(results.localStorage).toMatch(/^threw:|^ran:object|^ran:undefined/);
    expect(results["parent.document"]).toMatch(/^threw:/);
    expect(results["top.location.read"]).toMatch(/^threw:/);
    expect(results.cookie).toMatch(/^threw:|^ran:$/); // no cookie jar: throws, or reads back nothing
    expect(results.indexedDB).toMatch(/^threw:/);
    expect(results["window.open"]).toMatch(/^ran:null|^threw:/);
    expect(results.fetch).toMatch(/^blocked:/);
    expect(results.xhr).toMatch(/^blocked|^threw:|pending/);
  });
});

test.describe("a frame that navigates itself", () => {
  const attacks = ["nav-href", "nav-replace", "nav-assign", "nav-meta", "nav-anchor"];

  for (const attack of attacks) {
    test(`${attack}: the page's frame-src stops it, and the canary hears nothing`, async ({ page }) => {
      await openHost(page);
      await page.evaluate((url) => window.__e2e.mount({ entry: url, appsOrigin: new URL(url).origin }), hostile(attack));
      // the attack really ran (a frame that never loaded would pass this test for nothing)
      await page.waitForFunction((name) => window.__e2e.ran.includes(name), attack);
      await settle(page, 2000);
      expect(servers.hits, `the canary was reached: ${servers.hits.join(" ")}`).toEqual([]);
      // never handed a port: it never said hello
      expect(await page.evaluate(() => window.__e2e.statuses.some((s) => s.kind === "ready"))).toBe(false);
    });
  }

  test("a frame that loaded once and then moves to a listed origin is removed on its second load", async ({ page }) => {
    await openHost(page);
    // the canary is not listed; the other origin below is, so this navigation is allowed and a second document loads
    const url = entry("hostile", `?a=nav-href&d=300&c=${encodeURIComponent(servers.legit)}`);
    await page.evaluate(
      ([entryUrl, apps, listed]) => window.__e2e.mount({ entry: entryUrl!, appsOrigin: apps!, extraOrigins: [listed!] }),
      [url, servers.apps, servers.legit],
    );
    await page.waitForFunction(() => window.__e2e.statuses.some((s) => s.kind === "error"), null, { timeout: 8000 });
    expect(await page.evaluate(() => window.__e2e.statuses.at(-1))).toEqual({ kind: "error", reason: "frame-navigated" });
    expect(await page.locator("iframe[data-app-frame]").count()).toBe(0);
    expect(await page.evaluate(() => window.__e2e.transport.left)).toBe(1);
  });

  test("control: a sandboxed frame on a page WITHOUT the policy does reach the canary (so the test above can fail)", async ({ page, browserName }, testInfo) => {
    await openHost(page);
    await page.evaluate((url) => window.__e2e.rawSandboxFrame(url), hostile("nav-href"));
    await page.waitForFunction(() => window.__e2e.ran.includes("nav-href"));
    await settle(page, 2000);
    testInfo.annotations.push({ type: "control", description: `${browserName}: canary hits without the policy = ${servers.hits.length}` });
    // measured 2026-10-19: Chromium 151, WebKit 26.5 and Firefox 153 all deliver the secret to the canary
    expect(servers.hits.length, `${browserName} did not leak, so the policy tests above prove nothing here`).toBeGreaterThan(0);
  });
});

test.describe("a sibling pretending to be the app", () => {
  test("posts app-hello to the page: no port is handed to anyone", async ({ page }) => {
    await openHost(page);
    await page.evaluate((url) => window.__e2e.mount({ entry: url, appsOrigin: new URL(url).origin }), entry("hostile", "?a=idle"));
    await page.waitForFunction(() => window.__e2e.ran.includes("idle"));
    // a second sandboxed frame from the same apps origin says hello to the page
    await page.evaluate((url) => window.__e2e.rawSandboxFrame(url), entry("hostile", "?a=spoof"));
    await page.waitForFunction(() => window.__e2e.ran.includes("spoof"));
    await settle(page, 1500);
    expect(await page.evaluate(() => window.__e2e.statuses.some((s) => s.kind === "ready"))).toBe(false);
  });
});

test.describe("what the page legitimately frames still loads once the policy is in", () => {
  test("an allowed origin, same origin, about:blank, srcdoc and blob: load; an unlisted origin does not", async ({ page }) => {
    await openHost(page);
    await page.evaluate(
      ([apps, legit]) => window.__e2e.policy(apps!, [legit!]),
      [servers.apps, servers.legit],
    );

    const allowed = await page.evaluate((url) => window.__e2e.embed("src", url), `${servers.legit}/embed.html`);
    expect(allowed).toEqual({ loaded: true, violated: false });

    const same = await page.evaluate(() => window.__e2e.embed("src", "/same.html"));
    expect(same).toEqual({ loaded: true, violated: false });

    const blank = await page.evaluate(() => window.__e2e.embed("blank", ""));
    expect(blank.violated).toBe(false);

    const srcdoc = await page.evaluate(() => window.__e2e.embed("srcdoc", "<p>hi</p>"));
    expect(srcdoc).toEqual({ loaded: true, violated: false });

    const blob = await page.evaluate(() => window.__e2e.embed("blob", "<p>hi</p>"));
    expect(blob).toEqual({ loaded: true, violated: false });

    // the policy is real: an origin it does not list is refused
    const refused = await page.evaluate((url) => window.__e2e.embed("src", url), `${servers.other}/embed.html`);
    expect(refused.loaded).toBe(false);
  });

  test("the same embeds load before the policy exists (control)", async ({ page }) => {
    await openHost(page);
    const open = await page.evaluate((url) => window.__e2e.embed("src", url), `${servers.other}/embed.html`);
    expect(open).toEqual({ loaded: true, violated: false });
  });
});
