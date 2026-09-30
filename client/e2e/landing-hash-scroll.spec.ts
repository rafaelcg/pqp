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

/**
 * The Communities band and its links follow the server's public config
 * (`GET /api/public/communities/config`, `COMMUNITIES_ENABLED`, off by
 * default and in CI). Specs about that link say what the server answers
 * instead of depending on the environment.
 */
async function mockCommunities(
  page: Page,
  answer: { status: number; body: unknown },
) {
  await page.route("**/api/public/communities/config", (route) =>
    route.fulfill({
      status: answer.status,
      contentType: "application/json",
      body: JSON.stringify(answer.body),
    }),
  );
}

test.describe("landing section links", () => {
  test("header links from another page scroll to the section", async ({
    page,
  }) => {
    await mockCommunities(page, { status: 200, body: { enabled: true } });
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

  test("the Communities band and both links show when the server says enabled", async ({
    page,
  }) => {
    await mockCommunities(page, { status: 200, body: { enabled: true } });
    await page.goto("/");
    await expect(page.locator("#communities")).toBeAttached();
    await expect(page.locator('header nav a[href="/#communities"]')).toBeAttached();
    await expect(page.locator('footer a[href="/#communities"]')).toBeAttached();
  });

  for (const [name, answer] of [
    ["enabled: false", { status: 200, body: { enabled: false } }],
    ["404 (an older API)", { status: 404, body: { error: "not found" } }],
  ] as const) {
    test(`the Communities band and both links are hidden on ${name}`, async ({
      page,
    }) => {
      await mockCommunities(page, answer);
      await page.goto("/");
      // The rest of the page has rendered, so absence is not just "not yet".
      await expect(page.locator("#features")).toBeAttached();
      await expect(page.locator('footer a[href="/#hosting"]')).toBeAttached();
      await page.waitForTimeout(500);
      await expect(page.locator("#communities")).toHaveCount(0);
      await expect(page.locator('header nav a[href="/#communities"]')).toHaveCount(0);
      await expect(page.locator('footer a[href="/#communities"]')).toHaveCount(0);
    });
  }
});
