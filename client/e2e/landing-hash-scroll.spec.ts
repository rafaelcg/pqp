import { expect, test, type Page } from "@playwright/test";

/**
 * The marketing header and footer link to sections of the landing page
 * (`/#features`, `/#communities`, `/#hosting`) from every other public page.
 *
 * WHY A BROWSER. Those links are plain `<a href>`, so following one is a full
 * page load, and the browser's own anchor jump runs before React has rendered
 * the section. The visitor landed on `/` at the top of the hero with the hash
 * in the URL. Only a real navigation in a real browser reproduces that; a unit
 * test of the hook cannot.
 *
 * Selectors are the `href`s rather than the labels, so the spec does not care
 * which language the browser asks for.
 */

/** Where the section's top edge is, relative to the top of the viewport. */
async function sectionTop(page: Page, id: string): Promise<number> {
  return page.evaluate(
    (sectionId) =>
      document.getElementById(sectionId)?.getBoundingClientRect().top ?? NaN,
    id,
  );
}

async function expectLandedOn(page: Page, id: string) {
  await expect(page).toHaveURL(new RegExp(`/#${id}$`));
  // `scroll-mt-20` leaves 80px for the header; allow a little either side.
  await expect
    .poll(() => sectionTop(page, id), { timeout: 10_000 })
    .toBeGreaterThan(40);
  await expect
    .poll(() => sectionTop(page, id), { timeout: 10_000 })
    .toBeLessThan(140);
}

test.describe("landing section links", () => {
  test("header links from another page scroll to the section", async ({
    page,
  }) => {
    for (const id of ["features", "communities", "hosting"]) {
      await page.goto("/download");
      await page.locator(`header nav a[href="/#${id}"]`).click();
      await expectLandedOn(page, id);
    }
  });

  test("footer links from another page scroll to the section", async ({
    page,
  }) => {
    await page.goto("/privacy");
    await page.locator('footer a[href="/#hosting"]').click();
    await expectLandedOn(page, "hosting");
  });

  test("a router link to a section on the landing scrolls to it", async ({
    page,
  }) => {
    await page.goto("/");
    await page.locator('a[href="/#import"]').first().click();
    await expect(page).toHaveURL(/\/#import$/);
    await expect
      .poll(() => sectionTop(page, "import"), { timeout: 10_000 })
      .toBeLessThan(200);
  });

  test("the landing without a hash still opens at the top", async ({
    page,
  }) => {
    await page.goto("/");
    await expect(page.locator("#features")).toBeAttached();
    expect(await page.evaluate(() => window.scrollY)).toBe(0);
  });
});
