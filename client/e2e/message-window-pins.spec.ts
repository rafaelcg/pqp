import { expect, test } from "@playwright/test";
import {
  openChannel,
  pinMessage,
  placementOf,
  seedLongChannel,
} from "./message-window-helpers";

/**
 * A pinned message outside the loaded rows, opened from the Pins panel.
 *
 * The panel used to call `chat.jumpTo` directly: the page around the pin
 * replaced the list, nothing scrolled to the pin, and the viewport (clamped to
 * the end of the new page) asked for "newer" history. With the transcript
 * windowed, that last page arriving left the list planning its window from the
 * tail while the reader was a thousand pixels up: an empty viewport until the
 * reader scrolled. The panel now goes through the list's own jump, the one a
 * reply quote and a permalink use, so the pin is mounted, centred and
 * highlighted, and the rows around it are there.
 */

test.setTimeout(120_000);
test.use({ viewport: { width: 1440, height: 900 } });

const COUNT = 400;

test("a pin far outside the loaded rows is jumped to, centred, never blank", async ({
  page,
}) => {
  const seeded = await seedLongChannel(COUNT);
  await pinMessage(seeded, 200);
  await openChannel(page, seeded, seeded.owner);
  await expect(
    page.locator('[role="log"] article[aria-label*="the reply"]'),
  ).toBeAttached({ timeout: 30_000 });
  // Only the newest page is loaded: the pin is not in the DOM.
  await expect(
    page.locator('[role="log"] article[aria-label*=". msg 200 "]'),
  ).toHaveCount(0);

  await page.getByRole("button", { name: "Pins", exact: true }).click();
  await page.getByText(/msg 200 /).first().click();

  await expect(
    page.locator('[role="log"] article[aria-label*=". msg 200 "]'),
  ).toBeAttached({ timeout: 15_000 });
  await expect
    .poll(
      async () => Math.abs((await placementOf(page, 200))?.offCentre ?? 9999),
      { timeout: 10_000 },
    )
    .toBeLessThanOrEqual(30);

  // Settled: still there, and the viewport holds messages (a spacer is not one).
  for (let i = 0; i < 6; i += 1) {
    await page.waitForTimeout(400);
    const covered = await page.evaluate(() => {
      const scroller = document.querySelector<HTMLElement>('[role="log"]')!;
      const box = scroller.getBoundingClientRect();
      return Array.from(scroller.querySelectorAll("article")).filter((row) => {
        const rect = row.getBoundingClientRect();
        return rect.bottom > box.top && rect.top < box.bottom;
      }).length;
    });
    expect(covered, "messages in the viewport").toBeGreaterThan(2);
  }
  const settled = (await placementOf(page, 200))!;
  expect(Math.abs(settled.offCentre)).toBeLessThanOrEqual(30);
  expect(settled.distanceFromBottom).toBeGreaterThan(120);
});
