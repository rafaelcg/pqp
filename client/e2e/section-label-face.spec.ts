import { expect, test } from "@playwright/test";

/**
 * Under the redesign every section label and group title draws in the sans
 * face with no tracking, whatever toggle-off classes its caller passes. The
 * unit tests read class strings; only a browser shows that the unlayered
 * `.font-display` rule in index.css lost to the redesign's classes.
 */
test("section labels draw in the sans face under the redesign", async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("pqp-redesign", "on"));
  await page.goto("/qa/ui?lang=pt-BR");
  const labels = page.getByTestId("qa-primitive-section-header").locator("[data-section-label]");
  await expect(labels.first()).toBeVisible();
  const faces = await labels.evaluateAll((nodes) =>
    nodes.map((node) => {
      const style = getComputedStyle(node);
      return { face: style.fontFamily, tracking: style.letterSpacing, transform: style.textTransform };
    }),
  );
  expect(faces.length).toBeGreaterThan(2);
  for (const { face, tracking, transform } of faces) {
    expect(face).toMatch(/^"?Instrument Sans/);
    expect(tracking).toBe("normal");
    expect(transform).toBe("none");
  }
});
