import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The quick reactions in a message's context menu, measured — not counted.
 *
 * They used to be ordinary menu items: eight `ContextMenuItemDef`s appended
 * after an "Add reaction" heading, and a menu item is a full-width row, so the
 * menu grew a tall column of one emoji per line. A test that only asserted
 * "eight quick reactions are present" would have passed the entire time the
 * bug existed. What separates the column from the strip is GEOMETRY: in a row
 * every emoji shares a y-centre and they march rightwards; in a column they
 * share an x and march downwards. So that is what these assert.
 */

/** Rows are never pixel-perfect (line-height rounding); this is the slack. */
const ROW_TOLERANCE_PX = 2;

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

async function sendMessage(page: Page, body: string): Promise<Locator> {
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  const text = page.getByText(body, { exact: true }).last();
  await expect(text).toBeVisible();
  return text.locator("xpath=ancestor::article[1]");
}

async function openMenuOn(page: Page, row: Locator) {
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height / 2, {
    button: "right",
  });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  return menu;
}

test("the quick reactions are one horizontal row at the top of the menu", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `strip-${Date.now()}`);
  const menu = await openMenuOn(page, row);

  const emoji = menu.locator("[data-quick-reaction]");
  const count = await emoji.count();
  expect(count).toBeGreaterThanOrEqual(6);

  const boxes = [];
  for (let i = 0; i < count; i += 1) {
    boxes.push((await emoji.nth(i).boundingBox())!);
  }

  // ONE ROW: every cell shares a y-centre.
  const centres = boxes.map((box) => box.y + box.height / 2);
  const spread = Math.max(...centres) - Math.min(...centres);
  expect(spread).toBeLessThanOrEqual(ROW_TOLERANCE_PX);

  // …and marches rightwards, one after another, never overlapping.
  for (let i = 1; i < boxes.length; i += 1) {
    expect(boxes[i]!.x).toBeGreaterThanOrEqual(
      boxes[i - 1]!.x + boxes[i - 1]!.width - ROW_TOLERANCE_PX,
    );
  }

  // Equal-spaced: the cells are the same width, so no emoji is a bigger
  // target than its neighbour.
  const widths = boxes.map((box) => box.width);
  expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(
    ROW_TOLERANCE_PX,
  );

  // The strip is at the TOP — above every action item.
  const firstItem = menu.getByRole("menuitem", { name: "Copy text" });
  const itemBox = (await firstItem.boundingBox())!;
  expect(boxes[0]!.y + boxes[0]!.height).toBeLessThanOrEqual(itemBox.y + 1);

  // The tail opens the full picker, and sits after the last emoji on the same
  // line rather than starting a second one.
  const more = menu.locator("[data-quick-reaction-more]");
  const moreBox = (await more.boundingBox())!;
  expect(Math.abs(moreBox.y + moreBox.height / 2 - centres[0]!)).toBeLessThanOrEqual(
    ROW_TOLERANCE_PX,
  );
  expect(moreBox.x).toBeGreaterThan(boxes[count - 1]!.x);
});

test("the strip does not make the menu taller than the list of actions", async ({
  page,
}) => {
  // The column bug's signature was a menu roughly twice as tall as its
  // actions. One row of ~32px cannot add more than a row's worth.
  await openApp(page);
  const row = await sendMessage(page, `height-${Date.now()}`);
  const menu = await openMenuOn(page, row);

  const menuBox = (await menu.boundingBox())!;
  const items = menu.getByRole("menuitem");
  const total = await items.count();
  const strip = await menu.locator("[data-quick-reaction]").count();
  const actions = total - strip - 1; // …minus the `+` tail.

  const firstAction = (await menu
    .getByRole("menuitem", { name: "Copy text" })
    .boundingBox())!;
  // Height budget: the action rows, plus one strip row, plus chrome.
  expect(menuBox.height).toBeLessThan(firstAction.height * (actions + 4));
});

test("clicking an emoji in the strip reacts, and the tail opens the picker", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `react-${Date.now()}`);

  const menu = await openMenuOn(page, row);
  await menu.locator("[data-quick-reaction]").first().click();
  await expect(row.getByRole("button", { name: /reaction/ }).first()).toBeVisible();
  // Radix owns `document.body`'s pointer-events while a menu is open; a second
  // right-click before it has unmounted lands on nothing.
  await expect(page.getByRole("menu")).toBeHidden();

  const again = await openMenuOn(page, row);
  await again.locator("[data-quick-reaction-more]").click();
  // The full picker is emoji-mart's own search field.
  await expect(page.getByPlaceholder("Search")).toBeVisible();
});
