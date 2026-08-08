import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Server settings as a sectioned surface.
 *
 * The same complaint that split the account settings, and the same shape of
 * test: what matters is not how it looks but that the split lost nothing.
 * Every section still has a door, a setting changed behind one of those doors
 * still sticks, and the dialog still closes the way every other dialog closes.
 *
 * The suite's account owns its server (`ensureServer` creates it), so this
 * exercises the owner's five sections. The admin's two are pinned server-side
 * instead — see `server-images.test.ts` and the audit-log tests.
 */

/** Every section, in rail order. The list IS the assertion. */
const SECTIONS = [
  "Overview",
  "Access",
  "Moderation",
  "Audit log",
  "Danger zone",
] as const;

async function openServerSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Server settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
}

const ssoField = (page: Page) =>
  page.getByRole("textbox", { name: "SSO email domain" });

test.describe("server settings sections", () => {
  test("opens on a section, and every section is reachable", async ({ page }) => {
    await openApp(page);
    await openServerSettings(page);

    const panel = page.getByRole("tabpanel");

    for (const name of SECTIONS) {
      await page.getByRole("tab", { name, exact: true }).click();
      await expect(
        page.getByRole("tab", { name, exact: true }),
      ).toHaveAttribute("aria-selected", "true");
      // The pane says what it is, so a section is never a blank right-hand side
      // that leaves you wondering whether the click registered.
      await expect(panel.getByRole("heading", { name })).toBeVisible();
    }
  });

  test("arrow keys walk the section rail", async ({ page }) => {
    await openApp(page);
    await openServerSettings(page);

    await page.getByRole("tab", { name: "Overview", exact: true }).focus();
    await page.keyboard.press("ArrowDown");
    await expect(
      page.getByRole("tab", { name: "Access", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("End");
    await expect(
      page.getByRole("tab", { name: "Danger zone", exact: true }),
    ).toHaveAttribute("aria-selected", "true");

    await page.keyboard.press("Home");
    await expect(
      page.getByRole("tab", { name: "Overview", exact: true }),
    ).toHaveAttribute("aria-selected", "true");
  });

  test("a setting changed in a non-default section survives close and reopen", async ({
    page,
  }) => {
    await openApp(page);
    await openServerSettings(page);

    await page.getByRole("tab", { name: "Access", exact: true }).click();
    await ssoField(page).fill("e2e-section.example");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("SSO domain updated.")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();

    await openServerSettings(page);
    await page.getByRole("tab", { name: "Access", exact: true }).click();
    await expect(ssoField(page)).toHaveValue("e2e-section.example");

    // Put it back so the next spec starts where this one found things.
    await ssoField(page).fill("");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("SSO domain updated.")).toBeVisible();
    await page.keyboard.press("Escape");
  });

  test("the danger zone still holds all three of its controls", async ({
    page,
  }) => {
    // The split's real risk is a control that quietly stopped being rendered.
    await openApp(page);
    await openServerSettings(page);
    await page.getByRole("tab", { name: "Danger zone", exact: true }).click();

    const panel = page.getByRole("tabpanel");
    await expect(
      panel.getByRole("button", { name: "Export server data" }),
    ).toBeVisible();
    await expect(panel.getByText("Transfer ownership")).toBeVisible();
    await expect(
      panel.getByRole("button", { name: "Delete server" }),
    ).toBeVisible();

    await page.keyboard.press("Escape");
  });

  test("escape closes server settings", async ({ page }) => {
    await openApp(page);
    const trigger = page
      .getByRole("button", { name: "Server settings" })
      .first();
    await trigger.click();
    await expect(page.getByRole("dialog")).toBeVisible();

    await page.keyboard.press("Escape");
    await expect(page.getByRole("dialog")).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test("the desktop layout puts the rail beside the section, not above it", async ({
    page,
  }) => {
    await openApp(page);
    await openServerSettings(page);
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

    await page.screenshot({ path: "/tmp/srv-settings-1440.png" });
  });
});

test.describe("server settings on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("stacks into a tab strip and never scrolls the page sideways", async ({
    page,
  }) => {
    await openApp(page);
    // The sidebar is a drawer under `md`, and it covers the settings button.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForTimeout(350);
    await openServerSettings(page);
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

    for (const name of SECTIONS) {
      const tab = page.getByRole("tab", { name, exact: true });
      await tab.click();
      await expect(tab).toHaveAttribute("aria-selected", "true");
    }

    await page.getByRole("tab", { name: "Overview", exact: true }).click();
  });
});
