import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * "Help and contact": the copy button reads as text and confirms in text, the
 * mailto has a web-mail way out, and the report notice sits above the bug
 * doors so someone in a bad situation reads it before writing to the address.
 */

async function openHelp(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Help and contact", exact: true }).click();
}

test.describe("settings help", () => {
  test.beforeEach(async ({ context }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  });

  test("copies the address and says Copied in visible text", async ({ page }) => {
    await openApp(page);
    await openHelp(page);
    const panel = page.getByRole("tabpanel");

    const copy = panel.getByRole("button", { name: "Copy address" });
    await expect(copy).toContainText("Copy address");
    const box = await copy.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThanOrEqual(40);

    await copy.click();
    await expect(copy).toContainText("Copied");
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("contato@pqp.gg");
    // The visible text goes back after about a second and a half.
    await expect(copy).toContainText("Copy address", { timeout: 4000 });
  });

  test("offers Gmail with the same subject, and the report notice before the bug doors", async ({
    page,
  }) => {
    await openApp(page);
    await openHelp(page);
    const panel = page.getByRole("tabpanel");

    const gmail = panel.getByRole("link", { name: "Open in Gmail" });
    await expect(gmail).toHaveAttribute("target", "_blank");
    const href = (await gmail.getAttribute("href")) ?? "";
    const url = new URL(href);
    expect(url.origin).toBe("https://mail.google.com");
    expect(url.searchParams.get("to")).toBe("contato@pqp.gg");
    expect(url.searchParams.get("su")).toBeTruthy();
    expect(url.searchParams.get("body")).toContain("Version: pqp web");

    const notice = panel.getByText("This email does not take reports.");
    const bug = panel.getByRole("heading", { name: "Found a bug?" });
    const noticeY = (await notice.boundingBox())?.y ?? Infinity;
    const bugY = (await bug.boundingBox())?.y ?? 0;
    expect(noticeY).toBeLessThan(bugY);
  });
});

test.describe("settings help on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("keeps the page from scrolling sideways", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open navigation" }).click();
    await page.waitForTimeout(350);
    await openHelp(page);
    await expect(page.getByRole("button", { name: "Copy address" })).toBeVisible();
    const widths = await page.evaluate(() => ({
      scroll: document.documentElement.scrollWidth,
      view: window.innerWidth,
    }));
    expect(widths.scroll).toBeLessThanOrEqual(widths.view + 0.5);
  });
});
