import { expect, test } from "@playwright/test";
import { ensureServer, openApp, resetPreferences } from "./fixtures";

/**
 * Stage 3: preferences live on the server, so a choice made on one device shows
 * up on the next. The rule being pinned here is "server wins on read, user
 * action wins on write" — the failure mode it prevents is a stale tab writing
 * its old settings back over a newer choice made elsewhere.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

async function readPreferences(): Promise<Record<string, unknown>> {
  const response = await fetch(`${API}/api/me`, { headers });
  const me = (await response.json()) as { preferences?: Record<string, unknown> };
  return me.preferences ?? {};
}

async function writePreferences(patch: Record<string, unknown>): Promise<void> {
  const response = await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(patch),
  });
  expect(response.ok, "preferences patch should succeed").toBe(true);
}

const themeAttr = (page: import("@playwright/test").Page) =>
  page.evaluate(() => document.documentElement.dataset.theme ?? "");

test.describe("stage 3 — preferences follow the user", () => {
  test("a theme chosen in the UI reaches the server", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await page
      .getByRole("radiogroup", { name: /brightness|claridade/i })
      .getByRole("radio", { name: /light|claro/i })
      .click();

    // The write is debounced, so poll rather than assuming it has landed.
    await expect
      .poll(async () => (await readPreferences()).theme, { timeout: 10_000 })
      .toBe("light");
  });

  test("a theme stored server-side applies on a device that has never seen it", async ({
    browser,
  }) => {
    await ensureServer();
    await resetPreferences();
    await writePreferences({ theme: "light" });

    // Fresh context: empty localStorage, OS preference says dark. Only the
    // server copy can produce light here.
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/app");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });

    await expect.poll(() => themeAttr(page), { timeout: 10_000 }).toBe("light");
    await context.close();
  });

  test("booting does not write preferences back — a stale tab cannot clobber", async ({
    browser,
  }) => {
    await ensureServer();
    await resetPreferences();
    await writePreferences({ theme: "light", muteOnJoin: true });

    // This device remembers an older, contradictory choice.
    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-theme", "dark");
    });
    await page.goto("/app");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(2_000);

    // Server state is untouched by merely opening the app.
    const stored = await readPreferences();
    expect(stored.theme).toBe("light");
    expect(stored.muteOnJoin).toBe(true);
    await context.close();
  });

  test("a partial update leaves unrelated preferences alone", async ({ page }) => {
    await openApp(page);
    await writePreferences({ theme: "dark", muteOnJoin: true, compactPeers: true });

    await writePreferences({ theme: "light" });

    const stored = await readPreferences();
    expect(stored).toMatchObject({
      theme: "light",
      muteOnJoin: true,
      compactPeers: true,
    });
  });

  test("device ids never reach the server", async ({ page }) => {
    await openApp(page);
    // A device id from another machine is meaningless and makes getUserMedia
    // throw, so it must stay on the device that chose it.
    await writePreferences({ theme: "dark", inputDeviceId: "not-a-real-device" });

    const stored = await readPreferences();
    expect(stored.inputDeviceId).toBeUndefined();
    expect(stored.outputDeviceId).toBeUndefined();
  });

  test("an appearance chosen in the UI reaches the server", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await page.getByRole("radio", { name: /hearth/i }).click();

    await expect
      .poll(async () => (await readPreferences()).appearance, { timeout: 10_000 })
      .toBe("hearth");
  });

  test("an appearance stored server-side applies on a fresh device", async ({
    browser,
  }) => {
    await ensureServer();
    await resetPreferences();
    await writePreferences({ appearance: "harmony" });

    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/app");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        () =>
          page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
        { timeout: 10_000 },
      )
      .toBe("harmony");
    await context.close();
  });

  test("an invalid appearance is rejected rather than stored", async ({
    page,
  }) => {
    await openApp(page);
    await writePreferences({ appearance: "signal" });

    const response = await fetch(`${API}/api/me/preferences`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ appearance: "discord" }),
    });
    expect(response.status).toBe(400);
    expect((await readPreferences()).appearance).toBe("signal");
  });

  test("a night appearance chosen in the UI reaches the server", async ({
    page,
  }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await page.getByRole("radio", { name: /night|noite/i }).click();

    await expect
      .poll(async () => (await readPreferences()).appearance, { timeout: 10_000 })
      .toBe("night");
    await expect
      .poll(async () => (await readPreferences()).theme, { timeout: 10_000 })
      .toBe("dark");
  });

  test("an accent hue chosen in the UI reaches the server", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await page.getByRole("button", { name: /hue 210|matiz 210/i }).click();

    await expect
      .poll(async () => (await readPreferences()).accentHue, { timeout: 10_000 })
      .toBe(210);
  });

  test("an accent hue stored server-side applies on a fresh device", async ({
    browser,
  }) => {
    await ensureServer();
    await resetPreferences();
    await writePreferences({ accentHue: 40 });

    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/app");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        () => page.evaluate(() => document.documentElement.dataset.accent ?? ""),
        { timeout: 10_000 },
      )
      .toBe("custom");
    expect(
      await page.evaluate(() =>
        document.documentElement.style.getPropertyValue("--accent-hue"),
      ),
    ).toBe("40");
    await expect
      .poll(
        () =>
          page.evaluate(() =>
            getComputedStyle(document.documentElement)
              .getPropertyValue("--rgb-picker-accent")
              .trim(),
          ),
        { timeout: 10_000 },
      )
      .not.toBe("");
    const picker = await page.evaluate(() =>
      getComputedStyle(document.documentElement)
        .getPropertyValue("--rgb-picker-accent")
        .trim(),
    );
    expect(picker).not.toBe("196, 232, 72");
    await context.close();
  });

  test("local Night does not adopt a server Light when the account has no appearance", async ({
    browser,
  }) => {
    await ensureServer();
    await resetPreferences();
    await writePreferences({ theme: "light" });

    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.addInitScript(() => {
      window.localStorage.setItem("pqp-appearance", "night");
      window.localStorage.setItem("pqp-theme", "dark");
    });
    await page.route("**/api/me", async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      const body = (await response.json()) as {
        preferences?: Record<string, unknown>;
      };
      const preferences = { ...(body.preferences ?? {}) };
      delete preferences.appearance;
      preferences.theme = "light";
      await route.fulfill({
        response,
        json: { ...body, preferences },
      });
    });
    await page.goto("/app?lang=en");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({
      timeout: 20_000,
    });

    await expect
      .poll(
        () =>
          page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
        { timeout: 10_000 },
      )
      .toBe("night");
    expect(await themeAttr(page)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("pqp-theme"))).toBe(
      "dark",
    );

    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await page.getByRole("radio", { name: /classic|clássico/i }).click();

    await expect
      .poll(
        () =>
          page.evaluate(() => document.documentElement.dataset.appearance ?? ""),
        { timeout: 10_000 },
      )
      .toBe("signal");
    expect(await themeAttr(page)).toBe("dark");
    expect(await page.evaluate(() => localStorage.getItem("pqp-theme"))).toBe(
      "dark",
    );
    await context.close();
  });

  test("an invalid accent hue is rejected rather than stored", async ({
    page,
  }) => {
    await openApp(page);
    await writePreferences({ accentHue: "default" });

    const response = await fetch(`${API}/api/me/preferences`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ accentHue: 999 }),
    });
    expect(response.status).toBe(400);
    expect((await readPreferences()).accentHue).toBe("default");
  });

  test("a contrast chosen in the UI reaches the server", async ({ page }) => {
    await openApp(page);
    await page.getByRole("button", { name: "Open settings" }).click();
    await page.getByRole("tab", { name: "Appearance & Language" }).click();
    await page
      .getByRole("radiogroup", { name: /contrast|contraste/i })
      .getByRole("radio", { name: /high|alto/i })
      .click();

    await expect
      .poll(async () => (await readPreferences()).contrast, { timeout: 10_000 })
      .toBe("more");
  });

  test("a contrast stored server-side applies on a fresh device", async ({
    browser,
  }) => {
    await ensureServer();
    await resetPreferences();
    await writePreferences({ contrast: "more" });

    const context = await browser.newContext({ colorScheme: "dark" });
    const page = await context.newPage();
    await page.goto("/app");
    await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });

    await expect
      .poll(
        () =>
          page.evaluate(() => document.documentElement.dataset.contrast ?? ""),
        { timeout: 10_000 },
      )
      .toBe("more");
    await context.close();
  });

  test("an invalid contrast is rejected rather than stored", async ({
    page,
  }) => {
    await openApp(page);
    await writePreferences({ contrast: "default" });

    const response = await fetch(`${API}/api/me/preferences`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ contrast: "loud" }),
    });
    expect(response.status).toBe(400);
    expect((await readPreferences()).contrast).toBe("default");
  });

  test("an invalid preference is rejected rather than stored", async ({ page }) => {
    await openApp(page);
    await writePreferences({ theme: "dark" });

    const response = await fetch(`${API}/api/me/preferences`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ theme: "neon" }),
    });
    expect(response.status).toBe(400);
    expect((await readPreferences()).theme).toBe("dark");
  });
});
