import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The Atalhos (Keyboard) tab in a real browser. The unit suites pin the
 * rules; this is for what only a real window shows: the capture listeners on
 * `window`, focus staying on the field when the swap button is pressed, and a
 * jump to another tab landing where it says it does.
 */

async function openKeyboard(page: Page): Promise<void> {
  await openApp(page);
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Keyboard", exact: true }).click();
  await expect(
    page.getByRole("tabpanel").getByRole("heading", { name: "Keyboard", level: 3 }),
  ).toBeVisible();
}

const muteField = (page: Page) =>
  page.getByRole("button", { name: /^Mute \/ unmute the microphone:/ });

test.describe("settings keyboard tab", () => {
  test("names the actions in plain words and says push-to-talk is off", async ({
    page,
  }) => {
    await openKeyboard(page);
    const panel = page.getByRole("tabpanel");
    await expect(muteField(page)).toBeVisible();
    await expect(panel.getByText("Deafen / undeafen", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("Show the shortcut map", { exact: true }).first()).toBeVisible();
    await expect(panel.getByText("New direct message", { exact: true }).first()).toBeVisible();

    // The default mode is voice activity, so the key does nothing.
    const ptt = panel.locator('[data-settings-row="push-to-talk"]');
    await expect(ptt).toContainText("Off");
    await expect(ptt).toContainText("Change the mode in Voice & Video");
    await ptt.click();
    await expect(
      page.getByRole("tab", { name: "Voice & Video", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("a taken chord keeps the field armed, and Escape puts everything back", async ({
    page,
  }) => {
    await openKeyboard(page);
    const field = muteField(page);
    await field.click();
    await expect(field).toHaveAttribute("aria-pressed", "true");

    // Deafen's own chord.
    await page.keyboard.press("ControlOrMeta+Shift+D");
    const alert = page.getByRole("tabpanel").getByRole("alert");
    await expect(alert).toContainText("already belongs to Deafen / undeafen");
    await expect(field).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.press("Escape");
    await expect(alert).toHaveCount(0);
    await expect(field).toHaveAttribute("aria-pressed", "false");
    // The dialog is still open: Escape belonged to the field.
    await expect(page.getByRole("dialog")).toBeVisible();
  });

  test("a modifier on its own is refused", async ({ page }) => {
    await openKeyboard(page);
    const field = muteField(page);
    await field.click();
    await page.keyboard.press("Shift");
    await expect(page.getByRole("tabpanel").getByRole("alert")).toContainText(
      "A modifier alone does not work",
    );
    await expect(field).toHaveAttribute("aria-pressed", "true");
  });

  test("swapping hands each action the other's chord", async ({ page }) => {
    await openKeyboard(page);
    const field = muteField(page);
    await field.click();
    await page.keyboard.press("ControlOrMeta+Shift+D");
    await page
      .getByRole("button", { name: "Swap with Deafen / undeafen" })
      .click();

    await expect(page.getByRole("tabpanel").getByRole("alert")).toHaveCount(0);
    await expect(field).toHaveAttribute("aria-pressed", "false");
    await expect(field.locator("kbd").last()).toHaveText("D");
    const deafen = page.getByRole("button", { name: /^Deafen \/ undeafen:/ });
    await expect(deafen.locator("kbd").last()).toHaveText("M");
  });

  test("a bare key says it stops at text boxes", async ({ page }) => {
    await openKeyboard(page);
    const field = muteField(page);
    await field.click();
    await page.keyboard.press("j");
    await expect(field.locator("kbd")).toHaveText(["J"]);
    await expect(
      page.getByText("Without Ctrl/Cmd, this key only works outside text boxes."),
    ).toBeVisible();
  });
});
