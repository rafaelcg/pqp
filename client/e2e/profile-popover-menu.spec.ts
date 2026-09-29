import { expect, test, type Browser, type Page } from "@playwright/test";

/**
 * The profile card's More menu, every row reachable without scrolling.
 *
 * The card scrolls (`overflow-y: auto`), and the menu used to be an absolute
 * child of it. Opened on a friend in a DM, the card ends just under the action
 * strip, so the menu ran past the card's bottom edge: Block was cut in half and
 * Report was hidden until you scrolled the card. `toBeVisible()` and `click()`
 * both miss that, because Playwright scrolls a clipped element into view first.
 * So this asks the page what is actually under the centre of each row.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

// Two full app boots plus a message round trip.
test.setTimeout(120_000);

// The width and height the clipping was found at.
test.use({ viewport: { width: 1440, height: 900 } });

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

/** Age gate + onboarding for one dev-bypass account. */
async function materialiseAccount(suffix: string): Promise<{ id: string }> {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as { id: string; ageGate?: string };
  if (body.ageGate && body.ageGate !== "passed") {
    await fetch(`${API}/api/me/age-check`, {
      method: "POST",
      headers,
      body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
    });
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
  return { id: body.id };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(path);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 20_000,
  });
}

async function secondClient(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
  });
  const page = await context.newPage();
  return { context, page };
}

test("every row of a friend's More menu is on screen and on top", async ({
  page,
  browser,
}) => {
  const run = Date.now().toString(36);
  const aSuffix = `menu-a-${run}`;
  const bSuffix = `menu-b-${run}`;
  const a = await materialiseAccount(aSuffix);
  const b = await materialiseAccount(bSuffix);
  const sent = await fetch(`${API}/api/friends`, {
    method: "POST",
    headers: headersFor(aSuffix),
    body: JSON.stringify({ userId: b.id }),
  });
  expect(sent.ok).toBe(true);
  const accepted = await fetch(`${API}/api/friends/${a.id}/accept`, {
    method: "POST",
    headers: headersFor(bSuffix),
  });
  expect(accepted.ok).toBe(true);
  const dm = await fetch(`${API}/api/dms`, {
    method: "POST",
    headers: headersFor(bSuffix),
    body: JSON.stringify({ userIds: [a.id] }),
  });
  const { conversation } = (await dm.json()) as {
    conversation: { channelId: string };
  };
  const dmPath = `/app/dm/${conversation.channelId}`;

  // B says something, so A has an avatar to click.
  const second = await secondClient(browser);
  const body = `hello-${run}`;
  try {
    await openAs(second.page, dmPath, bSuffix);
    const composer = second.page.getByPlaceholder(/^Message /);
    await expect(composer).toBeVisible({ timeout: 20_000 });
    await composer.click();
    await composer.fill(body);
    await composer.press("Enter");
    await expect(
      second.page.getByText(body, { exact: true }).last(),
    ).toBeVisible();
  } finally {
    await second.context.close();
  }

  await openAs(page, dmPath, aSuffix);
  await expect(page.getByText(body, { exact: true }).last()).toBeVisible({
    timeout: 20_000,
  });
  await page.locator(`[data-author-trigger="${b.id}"]`).first().click();
  const card = page.locator("[data-profile-card]");
  await expect(card).toBeVisible();

  await card.getByRole("button", { name: "More" }).click();
  const rows = card.getByRole("menuitem");
  await expect(rows).toHaveText(["Remove friend", "Block", "Report"]);

  const covered = await rows.evaluateAll((items) =>
    items
      .filter((item) => {
        const box = item.getBoundingClientRect();
        const hit = document.elementFromPoint(
          box.left + box.width / 2,
          box.top + box.height / 2,
        );
        return !(hit && item.contains(hit));
      })
      .map((item) => item.textContent),
  );
  expect(covered).toEqual([]);
});
