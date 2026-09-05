import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * Discord-style formatting shortcuts in the composer. The pure toggle logic is
 * unit tested in `lib/composer-formatting.test.ts`; this pins the browser half
 * that jsdom cannot: the keydown reaching the handler with the right modifier
 * on this platform, the edit landing in a controlled React textarea without
 * the value snapping back, and the sent message rendering as `<strong>`.
 *
 * The modifier follows `process.platform` because the Playwright browser runs
 * on the same OS as the runner, and the handler picks Cmd or Ctrl from the
 * browser's own platform report.
 */
const MOD = process.platform === "darwin" ? "Meta" : "Control";

test("Cmd/Ctrl+B wraps the selection in ** and the sent message is bold", async ({
  page,
}) => {
  await openApp(page);
  const word = `bold${Date.now()}`;
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill(word);
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+b`);
  await expect(composer).toHaveValue(`**${word}**`);

  // One undo step removes the markers and only the markers: the edit went
  // through the browser's own text insertion, not a value swap.
  await composer.press(`${MOD}+z`);
  await expect(composer).toHaveValue(word);
  await composer.press(`${MOD}+a`);
  await composer.press(`${MOD}+b`);
  await expect(composer).toHaveValue(`**${word}**`);

  // The selection stays on the word, so the same key takes the markers back.
  await composer.press(`${MOD}+b`);
  await expect(composer).toHaveValue(word);
  await composer.press(`${MOD}+b`);
  await expect(composer).toHaveValue(`**${word}**`);

  await composer.press("Enter");
  const strong = page.locator("article strong", { hasText: word });
  await expect(strong).toBeVisible();
  await expect(composer).toHaveValue("");
});

test("a shortcut with nothing selected leaves the caret between the markers", async ({
  page,
}) => {
  await openApp(page);
  const composer = page.getByPlaceholder(/^Message /);
  await composer.click();
  await composer.fill("");
  await composer.press(`${MOD}+i`);
  await expect(composer).toHaveValue("**");
  await composer.pressSequentially("soft");
  await expect(composer).toHaveValue("*soft*");
});
