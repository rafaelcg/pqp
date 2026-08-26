import { expect, test } from "@playwright/test";
import {
  computed,
  contrast,
  cssVar,
  ensureServer,
  openApp,
  resetPreferences,
} from "./fixtures";

/**
 * Stage 2: light, dark and system. The assertions that matter are the ones a
 * unit test cannot make — that the override block actually outranks `@theme`,
 * that the choice survives a reload without a flash of the wrong theme, and
 * that light is legible rather than merely different.
 */

/** Read the theme the document is actually in. */
const themeAttr = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.dataset.theme ?? "");

test.describe("stage 2 — light and system", () => {
  test("light overrides the @theme layer rather than losing to it", async ({ page }) => {
    await openApp(page);

    const darkSurface = await cssVar(page, "--color-surface-0");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const lightSurface = await cssVar(page, "--color-surface-0");

    expect(lightSurface).not.toBe(darkSurface);
    // Light must actually be lighter — a swapped ramp is the classic failure.
    const lightness = (value: string) => Number(/oklch\(\s*([\d.]+)/.exec(value)?.[1] ?? 0);
    expect(lightness(lightSurface)).toBeGreaterThan(lightness(darkSurface));
  });

  test("color-scheme follows the theme so native controls match", async ({ page }) => {
    await openApp(page);
    expect(await computed(page, ":root", "color-scheme")).toBe("dark");

    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    expect(await computed(page, ":root", "color-scheme")).toBe("light");
  });

  test("the modal scrim stays dark in light mode", async ({ page }) => {
    await openApp(page);
    const darkOverlay = await cssVar(page, "--overlay");
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    // A scrim exists to darken what is behind it; inverting it would be a bug.
    expect(await cssVar(page, "--overlay")).toBe(darkOverlay);
  });

  test("skeletons stay visible in light — surface-3 is darker than the panel", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });
    const lightness = async (token: string) =>
      Number(/oklch\(\s*([\d.]+)/.exec(await cssVar(page, token))?.[1] ?? 0);
    expect(await lightness("--color-surface-3")).toBeLessThan(
      await lightness("--color-surface-1"),
    );
  });

  test("choosing a theme in settings applies it and survives a reload", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    // The theme moved into its own section when settings was sectioned.
    await page.getByRole("tab", { name: "Appearance & Language" }).click();

    const light = page
      .getByRole("radiogroup", { name: /brightness|claridade/i })
      .getByRole("radio", { name: /light|claro/i });
    await expect(light).toBeVisible();
    await light.click();

    await expect.poll(() => themeAttr(page)).toBe("light");

    await page.reload();
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    expect(await themeAttr(page)).toBe("light");
  });

  test("a stored theme is applied before first paint", async ({ page }) => {
    await ensureServer();
    await resetPreferences();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-theme", "light");
    });

    // "commit" resolves as soon as the navigation lands, before the module
    // bundle has run — if the attribute is already set, the head script won.
    await page.goto("/app", { waitUntil: "commit" });
    await page.waitForFunction(() => document.readyState !== "loading");
    expect(await themeAttr(page)).toBe("light");

    // And the paint matches: no dark frame slipped through.
    //
    // Wait for the sheet to actually be applied rather than assuming the
    // readyState above implies it. These tests run against the Vite DEV server,
    // which injects CSS from the module graph — so styles land whenever the
    // bundle finishes executing, not when the document finishes parsing, and a
    // transparent body here means "no CSS yet" rather than "wrong colour".
    // Growing the client bundle is enough to lose that race on a cold runner.
    // The before-paint guarantee is asserted above on `data-theme`, which the
    // head script sets synchronously; this half is only checking that body is
    // painted from the themed token.
    await page.waitForFunction(
      () => getComputedStyle(document.body).backgroundColor !== "rgba(0, 0, 0, 0)",
    );
    const background = await computed(page, "body", "background-color");
    const surface = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = getComputedStyle(
        document.documentElement,
      ).getPropertyValue("--color-surface-0");
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return out;
    });
    expect(background).toBe(surface);
  });

  test("system preference is followed when the user has not chosen", async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await ensureServer();
    await resetPreferences();
    await page.goto("/app");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    expect(await themeAttr(page)).toBe("light");
    await context.close();
  });

  test("a locally stored choice paints first, before the account is known", async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await ensureServer();
    await resetPreferences();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-theme", "dark");
    });
    // Before /api/me resolves, the local copy is the only thing that exists —
    // this is what keeps the boot flash-free.
    await page.goto("/app", { waitUntil: "commit" });
    await page.waitForFunction(() => document.readyState !== "loading");
    expect(await themeAttr(page)).toBe("dark");
    await context.close();
  });

  test("the marketing page stays dark even for a light-preference visitor", async ({
    browser,
  }) => {
    const context = await browser.newContext({ colorScheme: "light" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-theme", "light");
    });
    await resetPreferences();
    // It is a composition over a hero photograph, not app chrome.
    await page.goto("/");
    await expect(page.getByRole("link", { name: /open the app/i }).first()).toBeVisible();
    expect(await themeAttr(page)).toBe("dark");
    await context.close();
  });

  test("light mode is legible — every checked pair meets its WCAG floor", async ({
    page,
  }) => {
    await openApp(page);
    await page.evaluate(() => {
      document.documentElement.dataset.theme = "light";
    });

    const pairs: Array<[string, string, number, string]> = [
      ["--color-text", "--color-surface-0", 4.5, "body text on page"],
      ["--color-text", "--color-surface-1", 4.5, "body text on panel"],
      ["--color-text-muted", "--color-surface-1", 4.5, "muted text on panel"],
      ["--color-accent", "--color-surface-0", 3.0, "accent on page"],
      ["--color-on-accent", "--color-accent", 4.5, "text on an accent button"],
      ["--color-danger", "--color-surface-1", 3.0, "danger on panel"],
      ["--color-code-text", "--color-code-bg", 4.5, "inline code"],
    ];

    for (const [fg, bg, floor, label] of pairs) {
      const ratio = await contrast(page, await cssVar(page, fg), await cssVar(page, bg));
      expect(ratio, `${label} (${fg} on ${bg})`).toBeGreaterThanOrEqual(floor);
    }
  });

  test("choosing an appearance applies it and survives a reload", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();

    const harmony = page.getByRole("radio", { name: /harmony|harmonia/i });
    await expect(harmony).toBeVisible();
    await harmony.click();

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
      )
      .toBe("harmony");

    const harmonyAccent = await cssVar(page, "--color-accent");
    await page.evaluate(() => {
      document.documentElement.dataset.appearance = "signal";
    });
    const signalAccent = await cssVar(page, "--color-accent");
    expect(harmonyAccent).not.toBe(signalAccent);

    await page.reload();
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    expect(
      await page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
    ).toBe("harmony");
  });

  test("choosing night applies it and survives a reload", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();

    const night = page.getByRole("radio", { name: /night|noite/i });
    await expect(night).toBeVisible();
    await night.click();

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
      )
      .toBe("night");

    const nightSurface = await cssVar(page, "--color-surface-0");
    expect(nightSurface).toMatch(/oklch\(\s*0\s+0\s+0\s*\)/);

    expect(await themeAttr(page)).toBe("dark");
    const light = page
      .getByRole("radiogroup", { name: /brightness|claridade/i })
      .getByRole("radio", { name: /light|claro/i });
    await expect(light).toBeDisabled();

    await page.reload();
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    expect(
      await page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
    ).toBe("night");
    expect(await themeAttr(page)).toBe("dark");

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await expect(
      page
        .getByRole("radiogroup", { name: /brightness|claridade/i })
        .getByRole("radio", { name: /light|claro/i }),
    ).toBeDisabled();
  });

  test("choosing an accent hue applies it and survives a reload", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();

    await page.getByRole("button", { name: /hue 210|matiz 210/i }).click();

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.accent ?? ""),
      )
      .toBe("custom");
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--accent-hue"),
      ),
    ).toBe("210");

    const customAccent = await cssVar(page, "--color-accent");
    await page.evaluate(() => {
      delete document.documentElement.dataset.accent;
      document.documentElement.style.removeProperty("--accent-hue");
    });
    const lookAccent = await cssVar(page, "--color-accent");
    expect(customAccent).not.toBe(lookAccent);

    await page.reload();
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.accent ?? ""),
      )
      .toBe("custom");
    await expect
      .poll(() =>
        page.evaluate(() =>
          getComputedStyle(document.documentElement)
            .getPropertyValue("--rgb-picker-accent")
            .trim(),
        ),
      )
      .not.toBe("");
    expect(
      await page.evaluate(() =>
        getComputedStyle(document.documentElement)
          .getPropertyValue("--rgb-picker-accent")
          .trim(),
      ),
    ).not.toBe("196, 232, 72");
  });

  test("a stored appearance is applied before first paint", async ({ page }) => {
    await ensureServer();
    await resetPreferences();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-appearance", "hearth");
    });

    await page.goto("/app", { waitUntil: "commit" });
    await page.waitForFunction(() => document.readyState !== "loading");
    expect(
      await page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
    ).toBe("hearth");
  });

  test("switching theme does not throw", async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(String(error)));
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });

    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    const theme = page.getByRole("radiogroup", { name: /brightness|claridade/i });
    await theme.getByRole("radio", { name: /light|claro/i }).click();
    await theme.getByRole("radio", { name: /dark|escuro/i }).click();
    await theme.getByRole("radio", { name: /system|sistema/i }).click();

    expect(errors).toEqual([]);
  });

  test("choosing high contrast applies it and survives a reload", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();

    const high = page
      .getByRole("radiogroup", { name: /contrast|contraste/i })
      .getByRole("radio", { name: /high|alto/i });
    await expect(high).toBeVisible();
    await high.click();

    await expect
      .poll(() =>
        page.evaluate(() => document.documentElement.dataset.contrast ?? ""),
      )
      .toBe("more");

    await page.reload();
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    expect(
      await page.evaluate(() => document.documentElement.dataset.contrast ?? ""),
    ).toBe("more");
  });

  test("a stored accent hue is applied before first paint", async ({ page }) => {
    await ensureServer();
    await resetPreferences();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-accent-hue", "40");
    });

    await page.goto("/app", { waitUntil: "commit" });
    await page.waitForFunction(() => document.readyState !== "loading");
    expect(
      await page.evaluate(() => document.documentElement.dataset.accent ?? ""),
    ).toBe("custom");
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--accent-hue"),
      ),
    ).toBe("40");
  });

  test("a stored contrast is applied before first paint", async ({ page }) => {
    await ensureServer();
    await resetPreferences();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-contrast", "more");
    });

    await page.goto("/app", { waitUntil: "commit" });
    await page.waitForFunction(() => document.readyState !== "loading");
    expect(
      await page.evaluate(() => document.documentElement.dataset.contrast ?? ""),
    ).toBe("more");
  });
});
