import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Seus dados, in a real browser.
 *
 * What the unit tests cannot see: where things land on a screen. The typed
 * confirmation has to be on screen in a short window, the export button must
 * not move when a line appears under the text, and closing the delete dialog
 * has to put focus back on the button that opened it. No account is deleted
 * here; the request that would do it is never sent.
 */

async function openYourData(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Your data", exact: true }).click();
  await expect(
    page.getByRole("tabpanel").getByRole("heading", { name: "Your data", level: 3 }),
  ).toBeVisible();
  // The pane slides in on a tab change; a position read before it settles
  // measures the animation, not the layout.
  await page.waitForTimeout(800);
}

/**
 * Answer `GET /api/me/export` with a canned response. The client and the API
 * are on different origins, so the preflight goes to the real server (it
 * answers it correctly) and the canned reply carries the CORS headers a
 * browser needs, including the one that lets the page read `Retry-After`.
 */
async function stubExport(
  page: Page,
  response: { status: number; headers?: Record<string, string>; body: unknown },
): Promise<void> {
  await page.route("**/api/me/export", (route) => {
    const request = route.request();
    if (request.method() === "OPTIONS") {
      return route.fallback();
    }
    return route.fulfill({
      status: response.status,
      contentType: "application/json",
      headers: {
        "Access-Control-Allow-Origin": request.headers()["origin"] ?? "*",
        "Access-Control-Expose-Headers": "Retry-After",
        ...response.headers,
      },
      body: JSON.stringify(response.body),
    });
  });
}

const exportRow = (page: Page) => page.locator('[data-settings-row="export"]');
const exportButton = (page: Page) => exportRow(page).getByRole("button");
const deleteButton = (page: Page) =>
  page.locator('[data-settings-row="delete-account"]').getByRole("button");

test.describe("settings, your data", () => {
  test("a finished download says which file it was, and the button stays put", async ({
    page,
  }) => {
    await stubExport(page, { status: 200, body: { ok: true } });
    await openApp(page);
    await openYourData(page);

    const before = await exportButton(page).boundingBox();
    const [download] = await Promise.all([
      page.waitForEvent("download"),
      exportButton(page).click(),
    ]);
    const name = download.suggestedFilename();
    expect(name).toMatch(/^pqp-my-data-\d{4}-\d{2}-\d{2}\.json$/);
    await expect(exportRow(page)).toContainText(`The file ${name} was downloaded.`);

    const after = await exportButton(page).boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
    await expect(exportRow(page)).not.toContainText("was downloaded.", {
      timeout: 10_000,
    });
  });

  test("a limited download counts down on the button", async ({ page }) => {
    await stubExport(page, {
      status: 429,
      headers: { "Retry-After": "30" },
      body: { error: "Too many exports" },
    });
    await openApp(page);
    await openYourData(page);

    const before = await exportButton(page).boundingBox();
    await exportButton(page).click();
    await expect(exportButton(page)).toBeDisabled();
    await expect(exportButton(page)).toContainText(/Download in \d+ s/);
    await expect(exportRow(page).getByRole("alert")).toContainText(
      "Too many downloads in a row. Try again in",
    );
    // The line grew the row; the button is still where the person's eye was.
    const after = await exportButton(page).boundingBox();
    expect(Math.abs(after!.y - before!.y)).toBeLessThan(1);
  });

  test("the typed confirmation is on screen in a short window, and Escape returns to the delete button", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await openApp(page);
    await openYourData(page);

    await deleteButton(page).click();
    const dialog = page.getByRole("dialog", { name: "Delete your account?" });
    await expect(dialog).toBeVisible();
    const input = dialog.getByRole("textbox");
    await expect(input).toBeInViewport();
    const confirm = dialog.getByRole("button", { name: "Delete account", exact: true });
    await expect(confirm).toBeInViewport();
    await expect(confirm).toBeDisabled();

    // The name without its number gets a hint, and the button stays off.
    const tag = (await dialog.locator("span.select-all").textContent())!;
    await input.fill(tag.split("#")[0]!);
    await expect(dialog.getByText(`Missing #${tag.split("#")[1]}`)).toBeVisible();
    await expect(confirm).toBeDisabled();
    await input.fill(tag);
    await expect(confirm).toBeEnabled();

    await page.keyboard.press("Escape");
    await expect(dialog).toBeHidden();
    await expect(page.getByRole("dialog", { name: /settings/i })).toBeVisible();
    await expect(deleteButton(page)).toBeFocused();
  });

  test("Keep account also returns focus to the delete button", async ({ page }) => {
    await openApp(page);
    await openYourData(page);
    await deleteButton(page).click();
    await page
      .getByRole("dialog", { name: "Delete your account?" })
      .getByRole("button", { name: "Keep account" })
      .click();
    await expect(deleteButton(page)).toBeFocused();
  });
});
