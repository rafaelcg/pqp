import { expect, test, type Locator, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The hover toolbar on a message row, checked for what a person sees.
 *
 * The toolbar hangs 12px above the row's top edge on purpose. Rows carry
 * `content-visibility: auto`, which implies paint containment, and paint
 * containment clips at the box it sits on. With the style on the `<article>`
 * the top of the toolbar (border, tops of the emoji) was cut off on every
 * message, while every locator still said the buttons were "visible". A clipped
 * area is also not hit-testable, so the test asks the browser what is at the
 * toolbar's top edge instead of asking whether the element exists.
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
  const text = page.getByText(body, { exact: true }).last();
  await expect(text).toBeVisible();
  return text.locator("xpath=ancestor::article[1]");
}

test("the hover toolbar is not clipped at the top of the row", async ({
  page,
}) => {
  await openApp(page);
  const row = await sendMessage(page, `toolbar-${Date.now()}`);
  await row.hover();

  // The first quick reaction is a button whose whole text is an emoji.
  const emoji = row
    .locator("button")
    .filter({ hasText: /^\p{Extended_Pictographic}$/u })
    .first();
  await expect(emoji).toBeVisible();
  const toolbar = emoji.locator("xpath=..");
  const bar = (await toolbar.boundingBox())!;
  const rowBox = (await row.boundingBox())!;

  // It really does overhang the row, so the assertion below is about the
  // clipped strip and not about a toolbar that moved inside.
  expect(bar.y).toBeLessThan(rowBox.y);

  // 2px under the toolbar's top edge: above the row, over the emoji column.
  const probe = {
    x: (await emoji.boundingBox())!.x + 8,
    y: bar.y + 2,
  };
  const inside = await toolbar.evaluate(
    (node, point) => node.contains(document.elementFromPoint(point.x, point.y)),
    probe,
  );
  expect(inside).toBe(true);
});

test("the row still skips off-screen work", async ({ page }) => {
  await openApp(page);
  const row = await sendMessage(page, `skip-${Date.now()}`);
  // Wherever the containment sits (the row or its inner wrapper), it has to
  // stay: it is what keeps a long transcript cheap to scroll.
  const styles = await row.evaluate((node) =>
    [node, ...Array.from(node.children)].map(
      (el) => getComputedStyle(el).contentVisibility,
    ),
  );
  expect(styles).toContain("auto");
});
