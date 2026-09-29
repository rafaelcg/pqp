import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * "Edit message" and "Reply" from a message's context menu must leave the
 * keyboard where the action put it: in the edit box, or in the composer.
 *
 * Both actions focus their target while the menu is still mounted, and the
 * menu is modal, so its focus trap pulled that focus straight back. A frame
 * later the menu unmounted and focus fell to <body>: the edit box was on
 * screen, but typing went nowhere and Escape did not close it. The hover
 * toolbar's pencil and ArrowUp never had the problem, because no menu is open
 * on those paths. So these go through the menu, with a real right-click, and
 * then type, because "is focused" is the whole bug.
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
  // By the row's own label rather than its visible text: once the edit box
  // opens the body is a textarea value, which getByText does not match.
  const row = page.getByRole("article", { name: new RegExp(`${body}$`) });
  await expect(row).toBeVisible();
  return row;
}

async function chooseFromMenu(page: Page, row: Locator, item: string) {
  const box = (await row.boundingBox())!;
  await page.mouse.click(box.x + 30, box.y + box.height / 2, {
    button: "right",
  });
  const menu = page.getByRole("menu");
  await expect(menu).toBeVisible();
  await menu.getByRole("menuitem", { name: item, exact: true }).click();
  await expect(menu).toBeHidden();
}

test("Edit message from the context menu focuses the edit box", async ({
  page,
}) => {
  await openApp(page);
  const body = `menu-edit-${Date.now()}`;
  const row = await sendMessage(page, body);

  await chooseFromMenu(page, row, "Edit message");

  const editor = row.getByRole("textbox", { name: "Edit message" });
  await expect(editor).toBeFocused();
  // Typing lands at the end of the text, not in a void.
  await page.keyboard.type(" changed");
  await expect(editor).toHaveValue(`${body} changed`);
  // And Escape, handled on the textarea itself, closes it.
  await page.keyboard.press("Escape");
  await expect(editor).toBeHidden();
  await expect(row.getByText(body, { exact: true })).toBeVisible();
});

test("Reply from the context menu focuses the composer", async ({ page }) => {
  await openApp(page);
  const row = await sendMessage(page, `menu-reply-${Date.now()}`);

  await chooseFromMenu(page, row, "Reply");

  const composer = page.getByPlaceholder(/^Message /);
  await expect(composer).toBeFocused();
  await page.keyboard.type("on it");
  await expect(composer).toHaveValue("on it");
});
