import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The message context menu is anchored to the point that was clicked. Asserting
 * only that it opened would have passed while it was visibly broken: Radix
 * hardcodes `side="right" align="start"`, so a menu taller than the room below
 * the click was slid upwards by floating-ui's `shift` until the click sat
 * somewhere in the middle of its left edge — hundreds of pixels from any corner
 * of it, and hundreds of pixels from the message it belongs to. So these tests
 * measure where the menu lands relative to the click and to the window.
 */

/** A context menu is expected to hang off the click by one of its corners. */
const ANCHOR_TOLERANCE_PX = 12;

/**
 * On a database the dev-bypass account has never been through, every API call
 * is refused until the age gate is answered — including the server seeding in
 * `openApp`. Answer it once for the whole file rather than depend on whichever
 * test happened to run first having done it.
 */
test.beforeAll(async () => {
  const api = process.env.E2E_API_URL ?? "http://localhost:3101";
  await fetch(`${api}/api/me/age-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer dev-local-token",
    },
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
});

/** How much of the window has to be filled before rows reach its bottom edge. */
const ROWS_TO_FILL_THE_WINDOW = 18;

async function fillChannel(page: Page, prefix: string): Promise<Locator> {
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  let body = "";
  for (let i = 0; i < ROWS_TO_FILL_THE_WINDOW; i += 1) {
    body = `${prefix}-${i}`;
    await composer.fill(body);
    await composer.press("Enter");
  }
  const last = page.getByText(body, { exact: true }).last();
  await expect(last).toBeVisible();
  // The list scrolls itself to the newest message; measure once it has settled.
  await expect
    .poll(async () => (await last.boundingBox())?.y ?? 0)
    .toBeGreaterThan(0);
  return last.locator("xpath=ancestor::article[1]");
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Distance from a point to the nearest corner of a box. */
function cornerDistance(box: Box, x: number, y: number): number {
  const corners: [number, number][] = [
    [box.x, box.y],
    [box.x + box.width, box.y],
    [box.x, box.y + box.height],
    [box.x + box.width, box.y + box.height],
  ];
  return Math.min(
    ...corners.map(([cx, cy]) => Math.hypot(cx - x, cy - y)),
  );
}

async function openMenuAt(page: Page, x: number, y: number): Promise<Locator> {
  await page.mouse.move(x, y);
  await page.mouse.click(x, y, { button: "right" });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy text" })).toBeVisible();
  return menu;
}

function expectInsideWindow(box: Box, viewport: { width: number; height: number }) {
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
  expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
}

test("menu hangs off the click when the message sits at the bottom", async ({
  page,
}) => {
  await openApp(page);
  const row = await fillChannel(page, `anchor-${Date.now()}`);
  const rowBox = (await row.boundingBox())!;
  const x = rowBox.x + 30;
  const y = rowBox.y + rowBox.height / 2;

  const menu = await openMenuAt(page, x, y);
  const menuBox = (await menu.boundingBox())!;

  expect(cornerDistance(menuBox, x, y)).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  expectInsideWindow(menuBox, page.viewportSize()!);
});

test("menu stays inside the window at the right edge of the row", async ({
  page,
}) => {
  await openApp(page);
  const row = await fillChannel(page, `right-${Date.now()}`);
  const rowBox = (await row.boundingBox())!;
  const x = rowBox.x + rowBox.width - 6;
  const y = rowBox.y + rowBox.height / 2;

  const menu = await openMenuAt(page, x, y);
  const menuBox = (await menu.boundingBox())!;

  expect(cornerDistance(menuBox, x, y)).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  expectInsideWindow(menuBox, page.viewportSize()!);
});

test("menu hangs off the click on a narrow viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openApp(page);
  const row = await fillChannel(page, `narrow-${Date.now()}`);
  const rowBox = (await row.boundingBox())!;
  const x = rowBox.x + 30;
  const y = rowBox.y + rowBox.height / 2;

  const menu = await openMenuAt(page, x, y);
  const menuBox = (await menu.boundingBox())!;

  expect(cornerDistance(menuBox, x, y)).toBeLessThanOrEqual(ANCHOR_TOLERANCE_PX);
  expectInsideWindow(menuBox, page.viewportSize()!);
});

test("menu stays inside a window too short to hold it either way", async ({
  page,
}) => {
  // Taller than the room above the click and the room below it, so the menu can
  // only fit by shrinking — the case the max-height guard exists for.
  await page.setViewportSize({ width: 420, height: 460 });
  await openApp(page);
  const row = await fillChannel(page, `short-${Date.now()}`);
  const rowBox = (await row.boundingBox())!;

  const menu = await openMenuAt(
    page,
    rowBox.x + 30,
    rowBox.y + rowBox.height / 2,
  );
  expectInsideWindow((await menu.boundingBox())!, page.viewportSize()!);
});

test("menu is keyboard operable and Escape closes it", async ({ page }) => {
  await openApp(page);
  const row = await fillChannel(page, `keys-${Date.now()}`);
  const rowBox = (await row.boundingBox())!;

  const menu = await openMenuAt(
    page,
    rowBox.x + 30,
    rowBox.y + rowBox.height / 2,
  );
  await page.keyboard.press("ArrowDown");
  await expect(menu.locator("[data-highlighted]")).toHaveCount(1);
  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
});

test.describe("touch", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("long press opens the menu and lifting acts on nothing", async ({
    page,
  }) => {
    await openApp(page);
    const row = await fillChannel(page, `touch-${Date.now()}`);
    const rowBox = (await row.boundingBox())!;
    const x = rowBox.x + 30;
    const y = rowBox.y + rowBox.height / 2;

    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchStart",
      touchPoints: [{ x, y }],
    });
    const menu = page.getByRole("menu");
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    expect(cornerDistance(menuBox, x, y)).toBeLessThanOrEqual(
      ANCHOR_TOLERANCE_PX,
    );
    expectInsideWindow(menuBox, page.viewportSize()!);

    // Lifting the finger must not run whatever the menu opened on top of.
    await cdp.send("Input.dispatchTouchEvent", {
      type: "touchEnd",
      touchPoints: [],
    });
    await expect(menu).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(menu).toBeHidden();
    // A quick reaction firing on release would leave a chip on the row.
    await expect(row.getByRole("button", { name: /^(👍|❤️|😂)/ })).toHaveCount(0);
  });
});
