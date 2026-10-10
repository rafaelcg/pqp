import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * The Notifications tab: what the copy promises is what the controls do, and
 * the controls are big enough for a thumb.
 */

async function openNotifications(page: Page, phone = false): Promise<void> {
  if (phone) {
    // The sidebar is a drawer under `md`, and it covers the settings button.
    await page.getByRole("button", { name: "Open navigation" }).click();
    await expect(
      page.getByRole("button", { name: "Close navigation" }),
    ).toBeVisible();
    await page.waitForTimeout(350);
  }
  await page.getByRole("button", { name: "Open settings" }).first().click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.getByRole("tab", { name: "Notifications", exact: true }).click();
  await expect(
    page.getByRole("tabpanel").getByRole("heading", { name: "Notifications", level: 3 }),
  ).toBeVisible();
}

test.describe("settings notifications", () => {
  test("the default level is named for what it covers, and the ringtones hang under Incoming call", async ({
    page,
  }) => {
    await openApp(page);
    await openNotifications(page);
    const panel = page.getByRole("tabpanel");

    await expect(
      panel.getByRole("heading", { name: "Messages and mentions", level: 4 }),
    ).toBeVisible();
    const level = panel.getByRole("radiogroup", { name: "When someone writes" });
    await expect(level.getByRole("radio", { name: "All messages" })).toBeVisible();
    await expect(panel.getByText(/press and hold/i)).toBeVisible();

    // The ringtones sit between "Incoming call" and "Calling someone".
    const order = await panel.evaluate((root) =>
      [...root.querySelectorAll("[data-settings-row]")].map((el) =>
        el.getAttribute("data-settings-row"),
      ),
    );
    const call = order.indexOf("sound-incoming-call");
    expect(order.indexOf("incoming-ring")).toBe(call + 1);
    expect(order.indexOf("sound-outgoing-call")).toBe(call + 2);

    // Every listen button says Listen out loud, and names its sound.
    const listen = panel.getByRole("button", { name: "Listen: Message" });
    await expect(listen).toHaveText("Listen");
  });

  test("on a phone the level control, ringtones and listen buttons are thumb-sized", async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await openApp(page);
    await openNotifications(page, true);
    const panel = page.getByRole("tabpanel");

    const heights = async (locator: ReturnType<Page["locator"]>) =>
      locator.evaluateAll((els) =>
        els.map((el) => Math.round(el.getBoundingClientRect().height)),
      );

    const segments = await heights(
      panel.getByRole("radiogroup", { name: "When someone writes" }).getByRole("radio"),
    );
    const chips = await heights(
      panel.getByRole("radiogroup", { name: "Incoming call ringtone" }).getByRole("radio"),
    );
    const listen = await heights(panel.getByRole("button", { name: /^Listen: / }));
    expect(segments).toHaveLength(3);
    expect(chips).toHaveLength(5);
    for (const h of [...segments, ...chips, ...listen]) {
      expect(h).toBeGreaterThanOrEqual(40);
    }
  });
});
