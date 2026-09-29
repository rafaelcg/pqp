import { expect, test } from "@playwright/test";
import { openApp } from "./fixtures";

/**
 * A channel whose history request fails used to render the empty state, "Start
 * the thread", as if nothing had ever been said there. During a database blip
 * (the breaker answers 503) that makes every channel look wiped. The failure
 * has to read as a failure, and it has to offer a way back.
 */

test.beforeAll(async () => {
  const api = process.env.E2E_API_URL ?? "http://localhost:3101";
  await fetch(`${api}/api/me/age-check`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer dev-local-token",
    },
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
});

test("a failed history load shows an error with a retry, not an empty channel", async ({
  page,
}) => {
  await openApp(page);
  const body = `history-${Date.now()}`;
  const composer = page.getByPlaceholder(/^Message /);
  await composer.fill(body);
  await composer.press("Enter");
  const log = page.getByRole("log");
  const row = log.getByRole("article").filter({ hasText: body });
  await expect(row).toBeVisible();
  // Saved, not just drawn: a send still in flight when the page reloads is
  // broadcast to the new socket and would show up without any history load.
  await expect
    .poll(async () => {
      const label = await row.getAttribute("aria-label");
      return Boolean(label && !/Sending|Failed to send/.test(label));
    })
    .toBeTruthy();

  const history = "**/api/channels/*/messages*";
  await page.route(history, (route) =>
    route.request().method() === "GET"
      ? route.fulfill({
          status: 503,
          headers: { "Retry-After": "5" },
          contentType: "application/json",
          body: JSON.stringify({ error: "database_unavailable" }),
        })
      : route.continue(),
  );
  await page.reload();

  await expect(
    page.getByText("Couldn't load the messages", { exact: true }),
  ).toBeVisible({ timeout: 20_000 });
  const retry = page.getByRole("button", { name: "Try again" });
  await expect(retry).toBeVisible();
  await expect(page.getByText("Start the thread")).toHaveCount(0);
  // The raw server string is not copy.
  await expect(page.getByText("database_unavailable")).toHaveCount(0);

  await page.unroute(history);
  await retry.click();
  await expect(log.getByText(body, { exact: true })).toBeVisible();
  await expect(
    page.getByText("Couldn't load the messages", { exact: true }),
  ).toHaveCount(0);
});
