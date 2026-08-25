import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Settings as a sectioned surface.
 *
 * It used to be one column that mixed a display name, a microphone gain slider
 * and the button that deletes your account, and the only way to reach anything
 * was to scroll past everything. What matters now is not how it looks but that
 * the split did not lose anything: every section still has a door, a control
 * changed behind one of those doors still sticks, and the dialog still closes
 * the way every other dialog in the app closes.
 */

/** Every section, in nav order. The list IS the assertion. */
const SECTIONS = [
  "Profile",
  "Connections",
  "Voice & Video",
  "Notifications",
  "Appearance & Language",
  "Privacy",
  "Your data",
  "Feedback",
] as const;

async function openSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

const compactPeers = (page: Page) =>
  page.getByRole("checkbox", { name: "Compact peer list" });

test.describe("settings sections", () => {
  test("opens on a section, and every section is reachable", async ({ page }) => {
    await openApp(page);
    await openSettings(page);

    const panel = page.getByRole("tabpanel");

    for (const name of SECTIONS) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(
        page.getByRole("tab", { name, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      // The pane says what it is, so a section is never a blank right-hand
      // side that leaves you wondering whether the click registered.
      await expect(panel.getByRole("heading", { name })).toBeVisible();
    }
  });

  test("arrow keys walk the section rail", async ({ page }) => {
    await openApp(page);
    await openSettings(page);

    await page.getByRole("tab", { name: "Profile", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("tab", { name: "Connections", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("End");
    await expect(
      page.getByRole("tab", { name: "Feedback", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("a control changed in a non-default section survives close and reopen", async ({
    page,
  }) => {
    await openApp(page);
    await openSettings(page);

    await page.getByRole("tab", { name: "Voice & Video" }).click();
    await expect(compactPeers(page)).not.toBeChecked();
    await compactPeers(page).check();

    // Closed with Cancel on purpose: everything outside Profile applies as it
    // is changed, so dismissing must not quietly roll it back.
    await page.getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();

    await openSettings(page);
    await page.getByRole("tab", { name: "Voice & Video" }).click();
    await expect(compactPeers(page)).toBeChecked();

    // Put it back so the next spec starts where this one found things.
    await compactPeers(page).uncheck();
    await page.keyboard.press("Escape");
  });

  test("escape closes settings", async ({ page }) => {
    await openApp(page);
    const trigger = page.getByRole("button", { name: "Open settings" }).first();
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("the close button closes settings", async ({ page }) => {
    await openApp(page);
    await openSettings(page);
    await page.getByRole("button", { name: "Close dialog" }).click();
    await expect(page.getByRole("dialog")).toBeHidden();
  });

  test("the desktop layout puts the rail beside the section, not above it", async ({
    page,
  }) => {
    await openApp(page);
    await openSettings(page);
    await page.waitForTimeout(800);

    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const rail = panel.querySelector<HTMLElement>('[role="tablist"]')!;
      const pane = panel.querySelector<HTMLElement>('[role="tabpanel"]')!;
      return {
        railRight: rail.getBoundingClientRect().right,
        paneLeft: pane.getBoundingClientRect().left,
      };
    });
    expect(geometry.paneLeft).toBeGreaterThanOrEqual(geometry.railRight - 1);

    await page.screenshot({ path: "/tmp/settings-desktop.png" });
  });
});

test.describe("settings on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stacks into a tab strip and never scrolls the page sideways", async ({
    page,
  }) => {
    await openApp(page);
    // The sidebar is a drawer under `md`, and it covers the settings button.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(page.getByRole("button", { name: "Close navigation" })).toBeVisible();
    await page.waitForTimeout(350);
    await openSettings(page);
    await page.waitForTimeout(800);

    const geometry = await page.evaluate(() => {
      const panel = document.querySelector<HTMLElement>('[role="dialog"]')!;
      const rail = panel.querySelector<HTMLElement>('[role="tablist"]')!;
      const pane = panel.querySelector<HTMLElement>('[role="tabpanel"]')!;
      return {
        railBottom: rail.getBoundingClientRect().bottom,
        paneTop: pane.getBoundingClientRect().top,
        panelWidth: panel.getBoundingClientRect().width,
        documentScrollWidth: document.documentElement.scrollWidth,
        viewportWidth: window.innerWidth,
      };
    });

    // Stacked, not side by side — a 56px-wide section pane is unusable.
    expect(geometry.paneTop).toBeGreaterThanOrEqual(geometry.railBottom - 1);
    expect(geometry.panelWidth).toBeLessThanOrEqual(geometry.viewportWidth + 0.5);
    // The rail scrolls sideways INSIDE the panel; the page must not.
    expect(geometry.documentScrollWidth).toBeLessThanOrEqual(
      geometry.viewportWidth + 0.5,
    );

    // Every section is still reachable at this width, strip-scrolling included.
    for (const name of SECTIONS) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    }

    await page.getByRole("tab", { name: "Profile", exact: true }).click();
    await page.screenshot({ path: "/tmp/settings-mobile.png" });
  });
});
