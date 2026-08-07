import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

// The owner's screenshot: desktop width, results list clipped behind the
// footer. The mobile fix was measured at 320/390 only — this pins the width
// class it was never measured at.
test.use({ viewport: { width: 990, height: 700 } });

test("DM search results render inside the dialog at desktop width", async ({ page }) => {
  // Search excludes the caller, so a fresh database returns nothing — seed a
  // few extra accounts through the dev-bypass suffix so there are rows to clip.
  for (const who of ["raquel", "rafinha", "ramon"]) {
    await fetch("http://localhost:3101/api/me", {
      headers: { Authorization: `Bearer dev-local-token:${who}` },
    });
  }
  await openApp(page);
  await page.getByRole("button", { name: "Direct messages" }).click();
  await page.getByRole("button", { name: "New message" }).first().click();
  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  await dialog.getByRole("combobox").fill("dev_user_ra");
  await page.waitForTimeout(900);
  const rows = page.getByRole("option");
  const n = await rows.count();
  expect(n, "search should return at least one row").toBeGreaterThan(0);
  const body = await dialog.boundingBox();
  for (let i = 0; i < n; i++) {
    const r = await rows.nth(i).boundingBox();
    expect(r, `row ${i} has a box`).toBeTruthy();
    // fully inside the dialog, not peeking behind the footer
    expect(r!.y + r!.height, `row ${i} bottom inside dialog`).toBeLessThanOrEqual(body!.y + body!.height + 1);
    const clipped = await rows.nth(i).evaluate((el) => {
      const r = el.getBoundingClientRect();
      const topEl = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !el.contains(topEl) && !topEl?.contains(el);
    });
    expect(clipped, `row ${i} not covered by another element`).toBe(false);
  }
});
