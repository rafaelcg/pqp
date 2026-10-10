import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Settings > Privacy.
 *
 * The DM setting saves the moment it changes, so the keyboard must not save
 * options it only passes over. Blocking works from here by name, and
 * unblocking says who was unblocked.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.setTimeout(90_000);

async function openPrivacy(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Privacy", exact: true }).click();
}

/** A second account, ready to be found by its tag. */
async function seedStranger(suffix: string): Promise<{ tag: string; name: string }> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
  const me = (await (await fetch(`${API}/api/me`, { headers })).json()) as {
    tag: string;
    displayName: string;
  };
  return { tag: me.tag, name: me.displayName };
}

test.describe("settings privacy", () => {
  test("arrow keys move between the DM options without saving them", async ({ page }) => {
    let writes = 0;
    await page.route("**/api/me", (route) => {
      const body = route.request().postData() ?? "";
      if (route.request().method() === "PATCH" && body.includes("dmPrivacy")) {
        writes += 1;
      }
      return route.continue();
    });
    await openApp(page);
    await openPrivacy(page);

    const group = page.getByRole("radiogroup", {
      name: "Who can start a direct message with you",
    });
    await expect(group).toBeVisible();
    const options = group.getByRole("radio");
    await options.nth(1).focus();
    await page.keyboard.press("ArrowDown");
    await expect(options.nth(2)).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(options.nth(1)).toBeFocused();
    expect(writes).toBe(0);
    await expect(options.nth(1)).toHaveAttribute("aria-checked", "true");
  });

  test("blocks somebody by name from here, and says who was unblocked", async ({ page }) => {
    const stranger = await seedStranger("privacyspec");
    await openApp(page);
    await openPrivacy(page);

    await page.getByRole("button", { name: "Block someone" }).click();
    const field = page.getByRole("textbox", { name: "Name or @ of the person to block" });
    await expect(field).toBeFocused();
    await field.fill(stranger.tag);
    // Enter submits, like the button.
    await field.press("Enter");

    const unblock = page.getByRole("button", { name: `Unblock ${stranger.name}` });
    await expect(unblock).toBeVisible();
    await expect(field).toHaveCount(0);

    await unblock.click();
    await expect(page.getByText(`${stranger.name} unblocked`)).toBeVisible();
    await expect(unblock).toHaveCount(0);
  });
});
