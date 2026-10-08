import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The Feedback section: the counter, the keyboard send, the sizes on a phone.
 * The unit test covers the logic; this one proves it in a real layout.
 */

async function openFeedback(page: Page): Promise<void> {
  await openApp(page);
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Feedback", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
}

const SHOT = process.env.E2E_FEEDBACK_SHOTS;

test.describe("settings feedback", () => {
  test("the counter warns, Enviar explains itself, and Ctrl+Enter sends", async ({
    page,
  }) => {
    await openFeedback(page);
    const box = page.getByRole("textbox", { name: "Message" });
    const send = page.getByRole("dialog").getByRole("button", { name: "Send", exact: true });

    await expect(send).toBeDisabled();
    await expect(page.getByText("Write something to send")).toBeVisible();
    if (SHOT) await page.screenshot({ path: `${SHOT}/desktop-empty.png` });

    await box.fill("   \n  ");
    await expect(send).toBeDisabled();
    await expect(page.getByText("0 / 2000").first()).toBeVisible();

    await box.fill("a".repeat(1850));
    await expect(page.getByText("150 characters left.").first()).toBeVisible();
    if (SHOT) await page.screenshot({ path: `${SHOT}/desktop-warn.png` });

    await box.fill("a".repeat(2100));
    await expect(box).toHaveValue("a".repeat(2000));
    await expect(
      page.getByText("Limit of 2000 characters. The rest was cut off.").first(),
    ).toBeVisible();
    if (SHOT) await page.screenshot({ path: `${SHOT}/desktop-full.png` });

    await box.fill("The audio drops after thirty seconds in a big room.");
    await expect(page.getByText("Write something to send")).toBeHidden();
    await box.press("Control+Enter");
    await expect(page.getByText("We read everything that comes in.")).toBeVisible();
    if (SHOT) await page.screenshot({ path: `${SHOT}/desktop-sent.png` });

    await page.getByRole("button", { name: "Send another" }).click();
    await expect(page.getByRole("radio", { name: "Bug" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
  });

  test.describe("on a phone", () => {
    test.use({ viewport: { width: 390, height: 844 } });

    test("chips and Enviar are at least 44px tall, and Enviar is full width", async ({
      page,
    }) => {
      await page.setViewportSize({ width: 390, height: 844 });
      await openApp(page);
      await page.getByRole("button", { name: "Open navigation" }).click();
      await page.waitForTimeout(350);
      await page.getByRole("button", { name: "Open settings" }).first().click();
      await page.getByRole("tab", { name: "Feedback", exact: true }).click();
      await expect(page.getByRole("textbox", { name: "Message" })).toBeVisible();
      await page.waitForTimeout(500);
      if (SHOT) await page.screenshot({ path: `${SHOT}/phone.png` });

      const heights = await page.evaluate(() => {
        const radios = [...document.querySelectorAll<HTMLElement>('[role="radio"]')];
        const send = [...document.querySelectorAll<HTMLElement>('[role="dialog"] button')].find(
          (b) => b.textContent?.trim() === "Send",
        )!;
        const pane = document.querySelector<HTMLElement>('[role="tabpanel"]')!;
        return {
          chips: radios.map((r) => r.getBoundingClientRect().height),
          send: send.getBoundingClientRect().height,
          sendWidth: send.getBoundingClientRect().width,
          paneWidth: pane.getBoundingClientRect().width,
          scrollWidth: document.documentElement.scrollWidth,
          viewport: window.innerWidth,
        };
      });
      for (const h of heights.chips) expect(h).toBeGreaterThanOrEqual(44);
      expect(heights.send).toBeGreaterThanOrEqual(44);
      expect(heights.sendWidth).toBeGreaterThan(heights.paneWidth * 0.7);
      expect(heights.scrollWidth).toBeLessThanOrEqual(heights.viewport);
    });
  });
});
