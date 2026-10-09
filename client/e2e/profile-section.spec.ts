import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Perfil, the parts only a browser can prove: the link field asks the server
 * whether a name is free while it is typed, the ready-made avatars move with
 * the arrow keys, and Enter in a field is the Save button.
 *
 * Nothing here saves a handle (a claim locks it for 30 days on a shared
 * account) and the one save puts the display name back.
 */

/**
 * The shared account may already own a link (the handles spec claims one) and
 * a claimed link is locked for 30 days, which disables the field. This view of
 * the account has none, so the field is open whatever ran before.
 */
async function withoutALink(page: Page): Promise<void> {
  await page.route(
    (url) => url.pathname === "/api/me",
    async (route) => {
      if (route.request().method() !== "GET") {
        return route.fallback();
      }
      const response = await route.fetch();
      const user = (await response.json()) as Record<string, unknown>;
      return route.fulfill({
        response,
        json: { ...user, handle: null, handleChangedAt: null },
      });
    },
  );
}

async function openProfile(page: Page): Promise<void> {
  await openApp(page);
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("tab", { name: "Profile", exact: true })).toHaveAttribute(
    "aria-selected",
    "true",
  );
}

test.describe("profile", () => {
  test("says whether the public link is free while it is typed", async ({ page }) => {
    await withoutALink(page);
    await openProfile(page);
    const field = page.getByRole("textbox", { name: "Public link" });
    await expect(page.getByText("3 to 20 letters, numbers, _ . or -")).toBeVisible();

    await field.fill("zz_never_taken_e2e");
    await expect(page.getByText("Available", { exact: true })).toBeVisible();

    await field.fill("admin");
    await expect(page.getByText("That one is reserved.")).toBeVisible();
    await expect(page.getByText("Available", { exact: true })).toHaveCount(0);
  });

  test("moves between the ready-made avatars with the arrow keys", async ({ page }) => {
    await openProfile(page);
    const group = page.getByRole("radiogroup", { name: "Ready-made avatars" });
    await group.getByRole("radio").first().focus();
    await page.keyboard.press("ArrowRight");
    const second = group.getByRole("radio").nth(1);
    await expect(second).toBeFocused();
    await expect(second).toHaveAttribute("aria-checked", "true");
    await expect(page.getByText(/Ready-made avatar selected: /)).toBeVisible();
    // Shown as an unsaved draft; leave it unsaved.
    await page.getByRole("button", { name: "Discard" }).click();
  });

  test("Enter in the display name saves, with repeated spaces collapsed", async ({ page }) => {
    await openProfile(page);
    const name = page.getByRole("textbox", { name: "Display name" });
    const original = await name.inputValue();
    await name.fill(`${original}  QA`);
    await name.press("Enter");
    await expect(page.getByText("Saved", { exact: true }).first()).toBeVisible();
    await expect(name).toHaveValue(`${original} QA`);

    // Put the shared account back as it was.
    await name.fill(original);
    await name.press("Enter");
    await expect(name).toHaveValue(original);
    await expect(page.getByRole("button", { name: "Save changes" })).toHaveCount(0);
  });
});
