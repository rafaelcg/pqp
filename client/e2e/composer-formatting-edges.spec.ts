import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The edges around the formatting shortcuts, kept apart from the happy path in
 * `composer-formatting-shortcuts.spec.ts`: the shortcut must stay inside the
 * chat composer, redo must put the markers back, the other three markers must
 * render, degenerate bodies (only markers, markers around whitespace) must not
 * break the bubble, the phone layout must keep Enter and Shift+Enter, and the
 * `/help` line must name the modifier this platform actually uses.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";
const MOD_LABEL = process.platform === "darwin" ? "Cmd" : "Ctrl";

function formattingLine(text: string, prefix: string): string {
  return text.split("\n").find((line) => line.startsWith(prefix)) ?? "";
}

test("the shortcut does nothing in the message search box", async ({ page }) => {
  await openApp(page);
  await page.keyboard.press(`${MOD}+k`);
  const search = page.getByRole("dialog").getByLabel("Search messages");
  await expect(search).toBeVisible();
  await search.fill("hello");
  await search.press(`${MOD}+a`);
  await search.press(`${MOD}+b`);
  await search.press(`${MOD}+i`);
  await search.press(`${MOD}+e`);
  await search.press(`${MOD}+Shift+x`);
  await expect(search).toHaveValue("hello");
  await page.keyboard.press("Escape");
  // The composer was not focused, so it must not have picked the key up either.
  await expect(page.getByPlaceholder(/^Message /)).toHaveValue("");
});

test("redo puts the markers back after undo", async ({ page }) => {
  await openApp(page);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill("redo me");
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+b`);
  await expect(composer).toHaveValue("**redo me**");
  await composer.press(`${MOD}+z`);
  await expect(composer).toHaveValue("redo me");
  await composer.press(`${MOD}+Shift+z`);
  await expect(composer).toHaveValue("**redo me**");
});

test("italics, code and strikethrough render, and bold then italics stacks", async ({
  page,
}) => {
  await openApp(page);
  const composer = page.getByPlaceholder(/^Message /);
  const stamp = Date.now();

  await composer.click();
  await composer.fill(`em${stamp}`);
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+i`);
  await expect(composer).toHaveValue(`*em${stamp}*`);
  await composer.press("Enter");
  await expect(page.locator("article em", { hasText: `em${stamp}` })).toBeVisible();

  await composer.fill(`code${stamp}`);
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+e`);
  await expect(composer).toHaveValue(`\`code${stamp}\``);
  await composer.press("Enter");
  await expect(page.locator("article code", { hasText: `code${stamp}` })).toBeVisible();

  await composer.fill(`del${stamp}`);
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+Shift+x`);
  await expect(composer).toHaveValue(`~~del${stamp}~~`);
  await composer.press("Enter");
  await expect(page.locator("article del", { hasText: `del${stamp}` })).toBeVisible();

  // Bold then italics with a selection stacks to ***text***, and the bubble
  // renders both.
  await composer.fill(`both${stamp}`);
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+b`);
  await composer.press(`${MOD}+i`);
  await expect(composer).toHaveValue(`***both${stamp}***`);
  await composer.press("Enter");
  const both = page.locator("article strong em, article em strong", {
    hasText: `both${stamp}`,
  });
  await expect(both).toBeVisible();
  // No raw marker leaks into the rendered bubble.
  const article = page.locator("article", { hasText: `both${stamp}` }).last();
  await expect(article).not.toContainText("*");
});

test("bold then italics with nothing selected also stacks", async ({ page }) => {
  await openApp(page);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill("");
  await composer.press(`${MOD}+b`);
  await composer.press(`${MOD}+i`);
  await expect(composer).toHaveValue("******");
  await composer.pressSequentially("x");
  await expect(composer).toHaveValue("***x***");
});

test("a body that is only markers, or markers around whitespace, does not break the bubble", async ({
  page,
}) => {
  await openApp(page);
  const composer = page.getByPlaceholder(/^Message /);
  const stamp = `ws${Date.now()}`;

  // Markers around whitespace are not bold in CommonMark; they must come out
  // as the literal text, not vanish and not render as <strong>.
  await composer.click();
  await composer.fill(`${stamp} **   ** end`);
  await composer.press("Enter");
  const literal = page.locator("article", { hasText: stamp }).last();
  await expect(literal).toBeVisible();
  await expect(literal).toContainText("**");
  await expect(literal.locator("strong")).toHaveCount(0);

  // Only markers: Cmd+B on an empty composer and Enter. Whatever the renderer
  // does with `****` (CommonMark reads a line of four stars as a thematic
  // break), the send must go through and the composer must clear.
  const before = await page.locator("article").count();
  await composer.press(`${MOD}+b`);
  await expect(composer).toHaveValue("****");
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  await expect
    .poll(() => page.locator("article").count(), { timeout: 10_000 })
    .toBeGreaterThan(before);
  const last = page.locator("article").last();
  await expect(last).toBeVisible();
  test.info().annotations.push({
    type: "rendered ****",
    description: JSON.stringify(await last.innerText()),
  });
});

test.describe("phone", () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });

  test("Enter still sends, Shift+Enter still breaks the line, the shortcut still works", async ({
    page,
  }) => {
    await openApp(page);
    const composer = page.getByPlaceholder(/^Message /);
    const stamp = `phone${Date.now()}`;
    await composer.click();
    await composer.fill(stamp);
    await composer.press("Shift+Enter");
    await expect(composer).toHaveValue(`${stamp}\n`);
    await composer.pressSequentially("two");
    await composer.press(`${MOD}+a`);
    await composer.press(`${MOD}+b`);
    await expect(composer).toHaveValue(`**${stamp}\ntwo**`);
    await composer.press("Enter");
    await expect(composer).toHaveValue("");
    await expect(page.locator("article strong", { hasText: stamp })).toBeVisible();
  });
});

test("/help lists the shortcuts with this platform's modifier, in both languages", async ({
  page,
}) => {
  await openApp(page);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill("/help");
  await composer.press("Enter");
  const status = page.getByRole("status").filter({ hasText: "Formatting:" });
  await expect(status).toBeVisible();
  await expect(status).toContainText(
    `${MOD_LABEL}+B for bold, ${MOD_LABEL}+I for italics, ${MOD_LABEL}+E for code, ${MOD_LABEL}+Shift+X for strikethrough.`,
  );
  // The other lines of /help join usage and description with an em dash that
  // predates this feature; the new line must not pick the habit up.
  expect(formattingLine(await status.innerText(), "Formatting:")).not.toContain("\u2014");

  await page.goto("/app?lang=pt-BR");
  const composerPt = page.getByPlaceholder(/^Mensagem|^Message /);
  await expect(composerPt).toBeVisible({ timeout: 20_000 });
  await composerPt.click();
  await composerPt.fill("/help");
  await composerPt.press("Enter");
  const statusPt = page.getByRole("status").filter({ hasText: "Formatação:" });
  await expect(statusPt).toBeVisible();
  await expect(statusPt).toContainText(
    `${MOD_LABEL}+B para negrito, ${MOD_LABEL}+I para itálico, ${MOD_LABEL}+E para código, ${MOD_LABEL}+Shift+X para riscado.`,
  );
  expect(formattingLine(await statusPt.innerText(), "Formatação:")).not.toContain("\u2014");
});
