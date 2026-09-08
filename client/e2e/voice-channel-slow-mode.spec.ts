import { expect, test } from "@playwright/test";
import { ensureServer, openApp } from "./fixtures";

/**
 * Slow mode on a voice channel's chat.
 *
 * A voice channel in pqp carries its own chat, shown beside the call, and
 * during a busy call that chat is exactly where the flooding happens. The
 * setting was drawn for text channels only, so a moderator running a
 * 510-member community reported it plainly: "n da pra por slow mode em chat de
 * call". The server skipped voice too, so exposing the control without the
 * other half would have been a setting that saved and did nothing.
 *
 * This pins the moderator's half: the control is on a voice channel's
 * Overview, it says which sound it slows, and the interval survives a save and
 * a reopen. The sending half (a second message inside the interval is held) is
 * pinned against the real database in `server/src/api/slow-mode.test.ts` and
 * `server/src/ws/chat.test.ts`, where it costs no browser.
 */

test("a voice channel's chat can be slowed, and the interval sticks", async ({
  page,
}) => {
  await ensureServer();
  await openApp(page);

  // The voice channel a fresh sandbox always has. Its settings cog rather
  // than the row itself: clicking the row would join the call.
  const voiceRow = page.locator('[data-channel-type="voice"]').first();
  await expect(voiceRow).toBeVisible({ timeout: 20_000 });
  await voiceRow.locator("[data-channel-settings]").click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();

  // The control exists here at all, which is the whole report.
  await expect(dialog.getByText("Slow mode")).toBeVisible();
  // And it says which sound it slows, so nobody reads it as slowing the talking.
  await expect(
    dialog.getByText("Applies to the chat beside the call", { exact: false }),
  ).toBeVisible();

  // A value that is not the one already stored, so the dialog is genuinely
  // dirty and Save is genuinely offered. The suite shares one database across
  // runs, and "select the value it already has" saves nothing.
  const select = dialog.locator("select").first();
  const target = (await select.inputValue()) === "15" ? "30" : "15";
  await select.selectOption(target);
  await dialog.getByRole("button", { name: /save/i }).click();

  // The save landed: the footer drops back to a single Close, which is how
  // this dialog says the draft is clean.
  const close = dialog.getByRole("button", { name: "Close", exact: true });
  await expect(close).toBeVisible({ timeout: 15_000 });
  await close.click();
  await expect(dialog).toBeHidden({ timeout: 15_000 });

  // Reopen: the interval came back from the server, not from a draft this
  // dialog was still holding.
  await voiceRow.locator("[data-channel-settings]").click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await expect(page.getByRole("dialog").locator("select").first()).toHaveValue(
    target,
  );
});
