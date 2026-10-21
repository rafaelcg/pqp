import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test, type Browser, type Frame, type Page } from "@playwright/test";
import { SNES_GEOMETRY_MODES, snesGeometryPattern } from "./geometry-card.ts";
import { startRig, type Rig } from "./rig.ts";

/*
 * The picture is the box the stage drew, edge to edge, whatever the game does.
 *
 * Two things were wrong at once. RetroArch drew the core's frame INSIDE the canvas at the aspect the core reports
 * (8:7 pixels for the SNES), with black bars for the rest, so a box the stage had sized for square pixels (or for
 * Encaixar) held a smaller picture, off centre, and "full screen" was a window of the picture in a black room. And
 * the size the stage fitted was read once, so a game that changes its frame (224 and 239 lines, 256 and 512 wide)
 * kept a box for a frame it no longer drew.
 *
 * The card here (e2e/geometry-card.ts, written for this, never a game) changes its PPU mode on every press of B and
 * tints its backdrop per mode, in a real full screen on a laptop at 2x. The glass is measured from a screenshot:
 * where the lit pixels start and end against the canvas's own box, and the colour at each corner.
 */

test.describe.configure({ mode: "serial" });

let rig: Rig;
let scratch: string;

test.beforeAll(async () => {
  rig = await startRig();
  scratch = mkdtempSync(join(tmpdir(), "pqp-locadora-geometry-"));
});

test.afterAll(async () => {
  await rig.close();
  rmSync(scratch, { recursive: true, force: true });
});

const LAPTOP = { width: 2000, height: 1270 } as const;
const DPR = 2;
/** Deadlines and holds are longer on the CI runner (software GL, real fullscreen), never the pixel assertions. */
const SLOW = process.env.CI ? 4 : 1;

async function openLaptop(browser: Browser) {
  const context = await browser.newContext({ viewport: LAPTOP, deviceScaleFactor: DPR, screen: { width: 2000, height: 1330 } });
  await rig.allowHostAsAncestor(context);
  await context.addInitScript(() => {
    const real = window.matchMedia.bind(window);
    window.matchMedia = (query: string) =>
      query.includes("display-mode")
        ? ({ matches: false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, onchange: null, dispatchEvent: () => false } as MediaQueryList)
        : real(query);
  });
  const page = await context.newPage();
  const problems: string[] = [];
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") problems.push(`console error: ${message.text()}`);
  });
  await page.goto(`${rig.hostOrigin}/?src=${encodeURIComponent(rig.frameUrl)}&w=1400&h=900&seen=1&fs=real`);
  const handle = await page.waitForSelector("iframe#app");
  const frame = (await handle.contentFrame())!;
  await frame.locator("#loc:not([data-view=connecting])").waitFor();
  return { context, page, frame, problems };
}

async function playCard(page: Page, frame: Frame) {
  const path = join(scratch, `${Math.random().toString(16).slice(2, 10)}.sfc`);
  writeFileSync(path, snesGeometryPattern());
  await frame.locator(".loc-top-pick").click();
  await page.waitForFunction(() => (window as unknown as { __pickWaiting?: boolean }).__pickWaiting === true);
  await page.setInputFiles("#pick", path);
  await expect(frame.locator(".ejs_start_button")).toBeHidden();
  const start = frame.locator('.loc-start[data-choice="fresh"]').first();
  await start.waitFor({ state: "visible", timeout: 30_000 * SLOW });
  await start.click();
  await expect(frame.locator(".loc-load")).toHaveCount(0, { timeout: 30_000 * SLOW });
}

/** The canvas's own box, the core's frame as it reports it, and what the pill says. */
async function readBox(frame: Frame) {
  return frame.evaluate(() => {
    const canvas = document.querySelector("canvas.ejs_canvas") as HTMLCanvasElement;
    const r = canvas.getBoundingClientRect();
    const gm = (window as unknown as { EJS_emulator?: { gameManager?: { getVideoDimensions(t: string): number } } }).EJS_emulator?.gameManager;
    return {
      left: r.left,
      top: r.top,
      width: r.width,
      height: r.height,
      buffer: { width: canvas.width, height: canvas.height },
      core: gm ? { width: gm.getVideoDimensions("width"), height: gm.getVideoDimensions("height") } : null,
      pill: document.querySelector(".loc-pill-screen")?.textContent ?? "",
    };
  });
}

type Rgb = [number, number, number];

interface Glass {
  /** The lit area (anything brighter than the bars' black), in CSS pixels. */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** The colour at the centre of the room, and a pixel in from each of the box's four corners. */
  centre: Rgb;
  corners: { topLeft: Rgb; topRight: Rgb };
}

/** Reads the glass from a screenshot of the page: the HUD is hidden (settled) so only the picture and the bars are in it. */
async function readGlass(page: Page, box: { left: number; top: number; width: number; height: number }, shot?: string): Promise<Glass> {
  const png = await page.screenshot({ animations: "allow", ...(shot ? { path: shot } : {}) });
  return page.evaluate(
    async ({ base64, box, dpr }) => {
      const image = new Image();
      image.src = `data:image/png;base64,${base64}`;
      await image.decode();
      const canvas = document.createElement("canvas");
      canvas.width = image.width;
      canvas.height = image.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: true })!;
      ctx.drawImage(image, 0, 0);
      const data = ctx.getImageData(0, 0, image.width, image.height).data;
      const at = (x: number, y: number) => {
        const i = (y * image.width + x) * 4;
        return [data[i]!, data[i + 1]!, data[i + 2]!] as [number, number, number];
      };
      const lit = (x: number, y: number) => {
        const [r, g, b] = at(x, y);
        return r + g + b > 40;
      };
      const midY = Math.round(image.height / 2);
      const midX = Math.round(image.width / 2);
      let left = -1;
      let right = -1;
      let top = -1;
      let bottom = -1;
      for (let x = 0; x < image.width; x++) if (lit(x, midY)) { left = x; break; }
      for (let x = image.width - 1; x >= 0; x--) if (lit(x, midY)) { right = x + 1; break; }
      for (let y = 0; y < image.height; y++) if (lit(midX, y)) { top = y; break; }
      for (let y = image.height - 1; y >= 0; y--) if (lit(midX, y)) { bottom = y + 1; break; }
      const px = (css: number) => Math.round(css * dpr);
      return {
        left: left / dpr,
        right: right / dpr,
        top: top / dpr,
        bottom: bottom / dpr,
        centre: at(midX, midY),
        corners: {
          topLeft: at(px(box.left) + 3, px(box.top) + 3),
          topRight: at(px(box.left + box.width) - 4, px(box.top) + 3),
        },
      };
    },
    { base64: png.toString("base64"), box, dpr: DPR },
  );
}

const near = (actual: readonly number[], expected: readonly number[], tolerance = 30) => expected.every((value, i) => Math.abs(actual[i]! - value) <= tolerance);

/** The mode a backdrop tint says the card is in: grey 0, blue 1, green 2, red 3. */
function modeOf(colour: Rgb): number | null {
  const [r, g, b] = colour;
  if (Math.abs(r - g) < 20 && Math.abs(g - b) < 20 && r > 20) return 0;
  if (b > r + 40 && b > g + 40) return 1;
  if (g > r + 40 && g > b + 40) return 2;
  if (r > g + 40 && r > b + 40) return 3;
  return null;
}

test("the picture is the stage's box, edge to edge, in every screen setting and in every mode the game takes (real full screen, laptop at 2x)", async ({ browser, browserName }) => {
  test.skip(browserName !== "chromium", "real element full screen in a headless browser is Chromium's");
  test.setTimeout(240_000 * SLOW);
  const shots = process.env.LOCADORA_SHOTS;
  if (shots) mkdirSync(shots, { recursive: true });
  const { context, page, frame, problems } = await openLaptop(browser);
  await playCard(page, frame);
  await frame.locator("#stage").hover();
  await frame.locator('[data-action="fullscreen"]').click();
  await expect.poll(() => page.evaluate(() => document.fullscreenElement?.id ?? null)).toBe("app");
  await expect(frame.locator("#loc")).toHaveAttribute("data-fullscreen", "true");

  /** The pointer over the picture, then still: the HUD fades and only the picture and the bars are on the glass. */
  const settle = async () => {
    await page.mouse.move(1000, 600);
    await page.mouse.move(1004, 604);
    await expect.poll(() => frame.evaluate(() => document.getElementById("stage")?.dataset.hud), { timeout: 15_000 * SLOW }).toBe("hidden");
    await page.waitForTimeout(600);
  };

  const measure = async (label: string, corners: boolean) => {
    await settle();
    const box = await readBox(frame);
    const glass = await readGlass(page, box, shots ? join(shots, `${label}.png`) : undefined);
    // the box is inside the window and the lit picture IS the box, to the pixel (two CSS pixels of slack for the edge rows)
    expect(box.left, label).toBeGreaterThanOrEqual(-0.01);
    expect(box.top, label).toBeGreaterThanOrEqual(-0.01);
    expect(box.left + box.width, label).toBeLessThanOrEqual(LAPTOP.width + 0.01);
    expect(box.top + box.height, label).toBeLessThanOrEqual(LAPTOP.height + 0.01);
    expect(Math.abs(glass.left - box.left), `${label}: left edge`).toBeLessThanOrEqual(2);
    expect(Math.abs(glass.right - (box.left + box.width)), `${label}: right edge`).toBeLessThanOrEqual(2);
    expect(Math.abs(glass.top - box.top), `${label}: top edge`).toBeLessThanOrEqual(2);
    expect(Math.abs(glass.bottom - (box.top + box.height)), `${label}: bottom edge`).toBeLessThanOrEqual(2);
    // the card's first mode marks the top corners: red, then green, in the corners of the box and nowhere else (the
    // other modes are the core's to crop, as bsnes does in overscan, so only their edges are asked)
    if (corners) {
      expect(near(glass.corners.topLeft, [255, 0, 0]), `${label}: top left ${String(glass.corners.topLeft)}`).toBe(true);
      expect(near(glass.corners.topRight, [0, 255, 0]), `${label}: top right ${String(glass.corners.topRight)}`).toBe(true);
    }
    return { box, glass };
  };

  const pick = async (item: string) => {
    await frame.locator("#stage").hover();
    await frame.locator(".loc-pill-screen").click();
    await frame.locator(".loc-menu .loc-menu-item", { hasText: item }).click();
    await page.keyboard.press("Escape");
    await expect(frame.locator(".loc-menu:not(.loc-turbo-menu)")).toBeHidden();
    await frame.locator("canvas.ejs_canvas").click();
  };

  // every way the person can ask for the picture (square pixels is what the app starts with), in the card's first mode
  const asked: Array<[string, string]> = [
    ["pixel-square", "Pixel perfeito"],
    ["tv", "Como na TV"],
    ["fit-tv", "Encaixar"],
    ["fit-square", "Pixel quadrado"],
  ];
  const measured: Array<{ label: string; w: number; h: number }> = [];
  for (const [label, item] of asked) {
    if (item !== "Pixel perfeito") await pick(item);
    const { box } = await measure(`mode0-${label}`, true);
    measured.push({ label, w: box.width, h: box.height });
  }
  // square pixels, Encaixar: a box of the frame's own shape (256x224), not the TV's
  const square = measured.find((m) => m.label === "fit-square")!;
  expect(square.w / square.h).toBeCloseTo(256 / 224, 1);
  expect(square.h).toBe(LAPTOP.height);

  // the game changes its frame, one press of B at a time: the picture stays the box in every one of them
  await pick("Pixel perfeito");
  /** The card's own reported mode: its backdrop tint (null while a frame is mid change). */
  let nudge = 0;
  const cardMode = async () => {
    await page.mouse.move(1000 + (nudge++ % 7), 600);
    return modeOf((await readGlass(page, { left: 0, top: 0, width: 10, height: 10 })).centre);
  };
  /**
   * Presses B until the card reaches `wanted`. A press is only seen if B is down on a frame the card samples, and on a
   * slow runner (software GL, a frame every few hundred ms) a short press falls between two of them, so the hold
   * scales with the runner and a press that changed nothing is repeated, a bounded number of times. A mode that
   * already went PAST the wanted one (a press seen twice) is not an error: the card is a ring of four, so the loop
   * keeps pressing until it comes round, and the pixel checks that follow are about the picture, never the count.
   */
  const advanceTo = async (wanted: number) => {
    const holdMs = 160 * SLOW;
    const settleMs = 2_500 * SLOW;
    // one deadline for the whole climb, so a card that never answers fails in tens of seconds, not attempts times a wait
    const overall = Date.now() + 20_000 * SLOW;
    let current: number | null = null;
    await expect.poll(async () => (current = await cardMode()), { message: "the card shows a mode", timeout: 15_000 * SLOW, intervals: [300] }).not.toBeNull();
    for (let press = 0; press < SNES_GEOMETRY_MODES.length * 2 && current !== wanted && Date.now() < overall; press++) {
      const before: number | null = current;
      await frame.locator("canvas.ejs_canvas").click();
      await page.keyboard.down("x");
      await page.waitForTimeout(holdMs);
      await page.keyboard.up("x");
      const deadline = Date.now() + settleMs;
      while (Date.now() < Math.min(deadline, overall)) {
        await page.waitForTimeout(300);
        const seen = await cardMode();
        if (seen !== null && seen !== before) {
          current = seen;
          break;
        }
      }
    }
    expect(current, `the card takes mode ${wanted}`).toBe(wanted);
  };
  for (let i = 1; i <= SNES_GEOMETRY_MODES.length; i++) {
    const wanted = i % SNES_GEOMETRY_MODES.length;
    await advanceTo(wanted);
    await measure(`press${i}-${SNES_GEOMETRY_MODES[wanted]!.name}`, wanted === 0);
  }

  expect(problems).toEqual([]);
  await context.close();
});
