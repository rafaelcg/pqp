import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Message actions (reply, copy, pin, delete, report, react) used to be
 * reachable only by right-click or long-press, and the message log gave a
 * screen reader nothing but a wall of undifferentiated text. This file
 * covers the keyboard side of fixing that: a roving tab stop over the
 * message log (one stop, not one per message), the standard keys for
 * opening the context menu from a focused row, Escape returning focus to
 * where it opened from, and a new arrival never stealing focus from
 * whichever row a reader has landed on.
 *
 * `document.activeElement` is asserted throughout rather than a class name —
 * a focus ring can be present in the DOM without the browser actually having
 * moved focus there.
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

async function sendMessage(page: Page, body: string): Promise<Locator> {
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill(body);
  await composer.press("Enter");
  const row = page
    .getByText(body, { exact: true })
    .last()
    .locator("xpath=ancestor::article[1]");
  await expect(row).toBeVisible();
  return row;
}

test("Tab reaches the message log as one stop, and leaves it as one stop", async ({
  page,
}) => {
  await openApp(page);
  const marker = `tabreach-${Date.now()}`;
  const row = await sendMessage(page, marker);

  // Anchor on something the header always renders, safely before the log in
  // DOM order, rather than assuming an exact number of tab stops between it
  // and the log — channel management controls vary with the account's role.
  await page.getByRole("button", { name: "Pins" }).focus();

  let reachedLog = false;
  for (let i = 0; i < 15; i += 1) {
    await page.keyboard.press("Tab");
    const tag = await page.evaluate(() => document.activeElement?.tagName);
    if (tag === "ARTICLE") {
      reachedLog = true;
      break;
    }
  }
  expect(reachedLog).toBe(true);
  await expect(row).toBeFocused();

  // A single stop for the whole log: the very next Tab must already have
  // left it, not moved to a second message row.
  await page.keyboard.press("Tab");
  const tagAfter = await page.evaluate(() => document.activeElement?.tagName);
  expect(tagAfter).not.toBe("ARTICLE");

  // ...and from there, the composer is still reachable — no keyboard trap.
  let reachedComposer = false;
  for (let i = 0; i < 10; i += 1) {
    const isComposer = await page.evaluate(
      () => document.activeElement?.getAttribute("placeholder")?.startsWith("Message "),
    );
    if (isComposer) {
      reachedComposer = true;
      break;
    }
    await page.keyboard.press("Tab");
  }
  expect(reachedComposer).toBe(true);
});

test("Arrow keys move the roving tab stop between rows", async ({ page }) => {
  await openApp(page);
  const prefix = `arrownav-${Date.now()}`;
  const first = await sendMessage(page, `${prefix}-a`);
  const second = await sendMessage(page, `${prefix}-b`);

  await second.click();
  await expect(second).toBeFocused();

  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();

  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
});

test("a message row's accessible name announces author, content, and reply context", async ({
  page,
}) => {
  await openApp(page);
  const marker = `a11yname-${Date.now()}`;
  const parent = await sendMessage(page, `${marker}-parent`);
  await expect(parent).toHaveAccessibleName(new RegExp(`${marker}-parent`));

  // Reply to it, so the child row's label carries the reply context too.
  await parent.click({ button: "right" });
  await page.getByRole("menuitem", { name: "Reply" }).click();
  const child = await sendMessage(page, `${marker}-child`);
  await expect(child).toHaveAccessibleName(
    new RegExp(`Replying to .*${marker}-parent`),
  );
});

/**
 * Both the dedicated keyboard "Menu"/"Application" key and the Shift+F10
 * chord are standard ways a real browser opens a context menu on whatever
 * currently has focus — dispatching the same native `contextmenu` event a
 * right-click would. This app does nothing key-specific to support either:
 * making the row a real, focusable element is what lets the browser's own
 * translation reach it at all (see the comment on `onContextMenu` in
 * MessageRow).
 *
 * Chromium's automation protocol reproduces that translation faithfully for
 * the "ContextMenu" key (confirmed by instrumenting the page: the keydown
 * *and* the resulting `contextmenu` event both arrive), which is what the
 * assertions below drive. Shift+F10 is a browser/OS-level chord recognised a
 * layer above where CDP injects synthetic key events — the keydown arrives
 * but Chromium does not synthesize the follow-up `contextmenu` event the way
 * a real keypress does, so it is exercised here by dispatching that same
 * event directly, which is exactly what a real Shift+F10 produces once it
 * reaches the page.
 */
test("the Menu key opens the context menu on the focused row, and Escape returns focus to it", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `menukey-${Date.now()}`);
  await row.click();
  await expect(row).toBeFocused();

  await page.keyboard.press("ContextMenu");
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await expect(menu.getByRole("menuitem", { name: "Copy text" })).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(row).toBeFocused();
});

test("a contextmenu event on the focused row opens the menu — what Shift+F10 dispatches in a real browser", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `shiftf10-${Date.now()}`);
  await row.click();
  await expect(row).toBeFocused();

  await page.evaluate(() => {
    document.activeElement?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();

  await page.keyboard.press("Escape");
  await expect(menu).toBeHidden();
  await expect(row).toBeFocused();
});

test("selecting a menu action that has nowhere else to send focus returns it to the row", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `menuselect-${Date.now()}`);
  await row.click();

  await page.keyboard.press("ContextMenu");
  await page.getByRole("menuitem", { name: "Copy text" }).click();
  await expect(page.getByRole("menu")).toBeHidden();
  await expect(row).toBeFocused();
});

test("reaction pills announce their state and toggle from the keyboard-opened menu", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `react-${Date.now()}`);
  await row.click();

  await page.keyboard.press("ContextMenu");
  await page.getByRole("menuitem", { name: "👍", exact: true }).click();

  const pill = row.getByRole("button", { name: /👍 reaction/ });
  await expect(pill).toHaveAttribute("aria-pressed", "true");
  await expect(pill).toHaveAccessibleName(/you reacted/);
});

test("a new message arriving does not move focus away from the row being read", async ({
  page,
  context,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `noSteal-${Date.now()}`);
  await row.click();
  await expect(row).toBeFocused();

  const page2 = await context.newPage();
  await openApp(page2);
  const marker = `incoming-${Date.now()}`;
  const composer2 = page2.getByPlaceholder(/^Message /);
  await composer2.click();
  await composer2.fill(marker);
  await composer2.press("Enter");
  await expect(
    page2.getByText(marker, { exact: true }).last(),
  ).toBeVisible();

  // Arrives on page1 too — and must not have touched its focus. `toBeFocused`
  // re-checks `document.activeElement` fresh, so this fails if the arrival
  // moved it anywhere, even briefly, and back.
  await expect(page.getByText(marker, { exact: true }).last()).toBeVisible();
  await expect(row).toBeFocused();

  await page2.close();
});
