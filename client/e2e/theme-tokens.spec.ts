import { expect, test } from "@playwright/test";
import { computed, contrast, cssVar, openApp } from "./fixtures";

/**
 * Stage 1 of theming: role tokens exist, resolve at runtime, and are what the
 * UI actually paints with. These assertions are what make a later theme
 * override safe — if a token stops reaching the pixels, light mode silently
 * half-applies, and only an end-to-end check catches that.
 */

const ROLE_TOKENS = [
  "--color-surface-0",
  "--color-surface-1",
  "--color-surface-2",
  "--color-surface-3",
  "--color-rail",
  "--color-border",
  "--color-border-strong",
  "--color-text",
  "--color-text-muted",
  "--color-accent",
  "--color-accent-hover",
  "--color-on-accent",
  "--color-danger",
  "--color-warning",
  "--color-success",
  "--color-code-bg",
  "--color-code-text",
  "--color-focus-ring",
  "--color-selection",
];

const NON_COLOUR_TOKENS = [
  "--overlay",
  "--shadow-popover",
  "--shadow-speaking",
  "--glow-accent",
  "--gradient-app-1",
  "--gradient-app-2",
];

test.describe("stage 1 — role tokens", () => {
  test("every role token resolves to a real value at runtime", async ({ page }) => {
    await openApp(page);
    for (const token of [...ROLE_TOKENS, ...NON_COLOUR_TOKENS]) {
      const value = await cssVar(page, token);
      expect(value, `${token} should resolve`).not.toBe("");
    }
  });

  test("deprecated colour-named aliases still resolve, so old classes keep working", async ({
    page,
  }) => {
    await openApp(page);
    // ~200 call sites still use these names; breaking them would be invisible
    // in a typecheck and very visible on screen.
    for (const [alias, role] of [
      ["--color-ink", "--color-surface-0"],
      ["--color-ink-2", "--color-surface-1"],
      ["--color-ink-3", "--color-surface-2"],
      ["--color-ink-4", "--color-border"],
      ["--color-paper", "--color-text"],
      ["--color-paper-muted", "--color-text-muted"],
      ["--color-signal", "--color-accent"],
      ["--color-signal-dim", "--color-accent-hover"],
    ] as const) {
      expect(await cssVar(page, alias), `${alias} should alias ${role}`).toBe(
        await cssVar(page, role),
      );
    }
  });

  test("the app background is painted from the surface token", async ({ page }) => {
    await openApp(page);
    const bodyBackground = await computed(page, "body", "background-color");
    const surface = await cssVar(page, "--color-surface-0");
    // Both resolve through the same engine, so they must agree exactly.
    const [painted, token] = await Promise.all([
      page.evaluate((c) => c, bodyBackground),
      page.evaluate((value) => {
        const probe = document.createElement("div");
        probe.style.backgroundColor = value;
        document.body.appendChild(probe);
        const out = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return out;
      }, surface),
    ]);
    expect(painted).toBe(token);
  });

  test("the gradients survive as a separate layer from the base colour", async ({
    page,
  }) => {
    await openApp(page);
    // Split into longhands in stage 1 so a theme can swap the base colour
    // without losing the gradients — regressing to the shorthand loses one.
    const image = await computed(page, "body", "background-image");
    expect(image).toContain("radial-gradient");
    expect(image.match(/radial-gradient/g)?.length).toBe(2);
  });

  test("color-scheme is declared so native controls match the app", async ({ page }) => {
    await openApp(page);
    const scheme = await computed(page, ":root", "color-scheme");
    expect(scheme).toMatch(/dark|light/);
  });

  test("body text meets WCAG AA against the app background", async ({ page }) => {
    await openApp(page);
    const ratio = await contrast(
      page,
      await cssVar(page, "--color-text"),
      await cssVar(page, "--color-surface-0"),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("muted text meets WCAG AA against the panel it sits on", async ({ page }) => {
    await openApp(page);
    const ratio = await contrast(
      page,
      await cssVar(page, "--color-text-muted"),
      await cssVar(page, "--color-surface-1"),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("accent buttons are legible — on-accent against accent", async ({ page }) => {
    await openApp(page);
    const ratio = await contrast(
      page,
      await cssVar(page, "--color-on-accent"),
      await cssVar(page, "--color-accent"),
    );
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  });

  test("the Send button paints from tokens, not a baked-in colour", async ({ page }) => {
    await openApp(page);
    const send = page.getByRole("button", { name: "Send" });
    await expect(send).toBeVisible();

    const background = await send.evaluate(
      (node) => getComputedStyle(node).backgroundColor,
    );
    const accent = await page.evaluate(() => {
      const probe = document.createElement("div");
      probe.style.backgroundColor = getComputedStyle(
        document.documentElement,
      ).getPropertyValue("--color-accent");
      document.body.appendChild(probe);
      const out = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return out;
    });
    expect(background).toBe(accent);
  });

  test("no console errors while the themed app boots", async ({ page }) => {
    const errors: string[] = [];
    page.on("console", (message) => {
      if (message.type() === "error") {
        errors.push(message.text());
      }
    });
    page.on("pageerror", (error) => errors.push(String(error)));

    await openApp(page);
    expect(errors).toEqual([]);
  });
});
