import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";

/**
 * CHAMAR A ATENÇÃO with two real accounts (two dev users, two browser
 * contexts): Ana nudges Bia in their DM. Bia's window shakes once and both of
 * them get the line; a second nudge inside ten seconds is refused with the
 * wait; a reload shows the line and never shakes again; under reduced motion
 * the pane pulses its border instead of moving.
 *
 * The `nudge` flag is turned on the way the operator does it, through the
 * flags route with the machine token, and handed back to its default after.
 * The button only exists in a 1:1 between friends, so no other spec's DM
 * header changes while it is on.
 *
 * The shake is a 0.4 s class, too short to poll for reliably, so each page
 * records every `data-nudge` it ever sees on `window.__nudges`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const headers = (suffix: string) => ({
  "Content-Type": "application/json",
  Authorization: `Bearer dev-local-token:${suffix}`,
});

async function person(suffix: string, displayName: string): Promise<string> {
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers: headers(suffix),
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
  await fetch(`${API}/api/me`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ displayName }),
  });
  const now = new Date().toISOString();
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers: headers(suffix),
    body: JSON.stringify({ onboardedAt: now, firstRunDismissedAt: now }),
  });
  const me = (await (await fetch(`${API}/api/me`, { headers: headers(suffix) })).json()) as {
    user?: { id: string };
    id?: string;
  };
  return (me.user ?? me).id!;
}

/** Two friends and their 1:1. */
async function friendsInDm(left: string, right: string) {
  const leftId = await person(left, "Ana");
  const rightId = await person(right, "Bia");
  const sent = await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headers(left),
    body: JSON.stringify({ userId: rightId }),
  });
  expect(sent.ok).toBe(true);
  const accepted = await fetch(`${API}/api/friends/${leftId}/accept`, {
    method: "POST",
    headers: headers(right),
  });
  expect(accepted.ok).toBe(true);
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(left),
      body: JSON.stringify({ userIds: [rightId] }),
    })
  ).json()) as { conversation: { channelId: string } };
  return conversation.channelId;
}

async function setNudgeFlag(enabled: boolean | null): Promise<void> {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${E2E_ADMIN_TOKEN}` },
    body: JSON.stringify({ key: "nudge", enabled }),
  });
  expect(res.status).toBe(200);
}

declare global {
  interface Window {
    __nudges?: string[];
  }
}

async function openDm(
  browser: Browser,
  suffix: string,
  dm: string,
  options: { reducedMotion?: "reduce" | "no-preference"; width?: number; height?: number } = {},
): Promise<Page> {
  const context = await browser.newContext({
    viewport: { width: options.width ?? 1280, height: options.height ?? 820 },
    reducedMotion: options.reducedMotion ?? "no-preference",
  });
  const page = await context.newPage();
  await page.addInitScript((s) => {
    localStorage.setItem("pqp:dev-user-suffix", s);
    window.__nudges = [];
    const record = () => {
      for (const node of document.querySelectorAll("[data-nudge]")) {
        window.__nudges!.push(node.getAttribute("data-nudge") ?? "");
      }
    };
    new MutationObserver(record).observe(document, {
      attributes: true,
      attributeFilter: ["data-nudge"],
      subtree: true,
    });
  }, suffix);
  await page.goto(`/app/dm/${dm}?lang=en`);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible({ timeout: 20_000 });
  return page;
}

const shakesOf = (page: Page) => page.evaluate(() => window.__nudges ?? []);
const shots = process.env.SHOT_DIR;

test.describe("chamar a atenção", () => {
  test.beforeAll(async () => {
    await setNudgeFlag(true);
  });
  test.afterAll(async () => {
    await setNudgeFlag(null);
  });

  test("Ana nudges Bia: Bia's pane shakes once, both get the line, a reload stays still", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    const ana = `nudge-ana-${stamp}`;
    const bia = `nudge-bia-${stamp}`;
    const dm = await friendsInDm(ana, bia);

    const biaPage = await openDm(browser, bia, dm);
    const anaPage = await openDm(browser, ana, dm);

    const button = anaPage.getByTestId("nudge-button");
    await expect(button).toBeVisible({ timeout: 15_000 });
    await expect(button).toHaveAttribute("data-state", "ready");
    await button.click();

    // Ana: her own line, and the button cooling down.
    await expect(anaPage.getByTestId("nudge-line")).toContainText("You nudged Bia.", {
      timeout: 10_000,
    });
    await expect(button).toHaveAttribute("data-state", "cooldown");

    // Bia: the line, and the shake class seen on her pane.
    await expect(biaPage.getByTestId("nudge-line")).toContainText("Ana nudged you!", {
      timeout: 10_000,
    });
    await expect.poll(() => shakesOf(biaPage), { timeout: 5_000 }).toContain("shake");
    if (shots) {
      await anaPage.waitForTimeout(700);
      await biaPage.screenshot({ path: `${shots}/nudge-received-1280.png` });
    }
    // Only the receiver shakes.
    expect(await shakesOf(anaPage)).not.toContain("shake");

    // Again inside ten seconds: refused with the wait, said under the log,
    // nothing stored. `force`: the tile is aria-disabled while it cools down
    // (still focusable and clickable, which is how the reason gets said), and
    // Playwright would otherwise wait the ten seconds out for it to enable.
    await button.click({ force: true });
    await expect(anaPage.getByTestId("nudge-notice")).toContainText(
      "Easy! Wait a few seconds before nudging again.",
    );
    if (shots) {
      await anaPage.waitForTimeout(700);
      await anaPage.screenshot({ path: `${shots}/nudge-sent-cooldown-1280.png` });
    }
    await expect(anaPage.getByTestId("nudge-line")).toHaveCount(1);

    // A reload reads the nudge out of history: the line, and no shake.
    await biaPage.reload();
    await expect(biaPage.getByTestId("nudge-line")).toContainText("Ana nudged you!", {
      timeout: 20_000,
    });
    await biaPage.waitForTimeout(1_000);
    expect(await shakesOf(biaPage)).toEqual([]);

    await anaPage.context().close();
    await biaPage.context().close();
  });

  test("under reduced motion the pane pulses its border and never moves", async ({ browser }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    const ana = `nudge-rm-ana-${stamp}`;
    const bia = `nudge-rm-bia-${stamp}`;
    const dm = await friendsInDm(ana, bia);

    const biaPage = await openDm(browser, bia, dm, { reducedMotion: "reduce" });
    const anaPage = await openDm(browser, ana, dm);
    await anaPage.getByTestId("nudge-button").click();
    await expect(biaPage.getByTestId("nudge-line")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => shakesOf(biaPage), { timeout: 5_000 }).toContain("pulse");
    expect(await shakesOf(biaPage)).not.toContain("shake");

    await anaPage.context().close();
    await biaPage.context().close();
  });

  test("on a phone-width window the button fits the header and the line wraps clean", async ({
    browser,
  }) => {
    test.setTimeout(90_000);
    const stamp = Date.now().toString(36);
    const ana = `nudge-m-ana-${stamp}`;
    const bia = `nudge-m-bia-${stamp}`;
    const dm = await friendsInDm(ana, bia);

    const biaPage = await openDm(browser, bia, dm, { width: 390, height: 844 });
    const anaPage = await openDm(browser, ana, dm, { width: 390, height: 844 });
    const button = anaPage.getByTestId("nudge-button");
    await expect(button).toBeVisible({ timeout: 15_000 });
    const box = await button.boundingBox();
    expect(box && box.x + box.width).toBeLessThanOrEqual(390);
    await button.click();
    await expect(biaPage.getByTestId("nudge-line")).toBeVisible({ timeout: 10_000 });
    await expect.poll(() => shakesOf(biaPage), { timeout: 5_000 }).toContain("shake");
    // No horizontal scroll on either side.
    for (const page of [anaPage, biaPage]) {
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
      );
      expect(overflow).toBeLessThanOrEqual(0);
    }
    if (shots) {
      await anaPage.waitForTimeout(700);
      await biaPage.screenshot({ path: `${shots}/nudge-received-390.png` });
      await anaPage.screenshot({ path: `${shots}/nudge-sent-390.png` });
    }

    await anaPage.context().close();
    await biaPage.context().close();
  });
});
