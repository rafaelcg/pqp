import { expect, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/**
 * A fresh database has no servers, so `/app` renders the empty state and none
 * of the chat chrome exists. Seed one through the API — faster and far less
 * brittle than driving the create-server form.
 */
export async function ensureServer(): Promise<void> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}`,
  };
  const existing = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await existing.json()) as { servers: unknown[] };
  if (servers.length > 0) {
    return;
  }
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "E2E" }),
  });
  if (!created.ok) {
    throw new Error(`could not seed a server: ${created.status}`);
  }
}

/**
 * The app boots straight into `/app` with the dev auth bypass, but it still has
 * to reach the server, so wait for real chrome rather than a fixed delay.
 */
/**
 * Theme is server state now, and the suite shares one dev-bypass account against
 * a persistent database. Without this, a test that stores a theme would decide
 * the outcome of every later test.
 */
export async function resetPreferences(): Promise<void> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}`,
  };
  // Read first. Writes are rate limited per user, and every test in the suite
  // shares one account — unconditionally PATCHing here exhausts the budget and
  // fails whichever test happens to run last.
  const current = await fetch(`${API}/api/me`, { headers });
  const me = (await current.json()) as {
    preferences?: { theme?: string };
  };
  if ((me.preferences?.theme ?? "system") === "system") {
    return;
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ theme: "system" }),
  });
}

export async function openApp(page: Page): Promise<void> {
  await ensureServer();
  await resetPreferences();
  await page.goto("/app");
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  // The composer only exists once a text channel is selected.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

/** Read a resolved CSS custom property off :root. */
export function cssVar(page: Page, name: string): Promise<string> {
  return page.evaluate(
    (property) =>
      getComputedStyle(document.documentElement).getPropertyValue(property).trim(),
    name,
  );
}

/** Read a computed style off the first element matching a selector. */
export function computed(
  page: Page,
  selector: string,
  property: string,
): Promise<string> {
  return page.evaluate(
    ([sel, prop]) => {
      const node = document.querySelector(sel as string);
      if (!node) {
        throw new Error(`no element for ${sel}`);
      }
      return getComputedStyle(node).getPropertyValue(prop as string).trim();
    },
    [selector, property],
  );
}

/**
 * Resolve any CSS colour to sRGB bytes. Uses a canvas rather than a computed
 * style because Chrome echoes `oklch()` back verbatim, so string parsing would
 * silently read lightness/chroma/hue as if they were r/g/b.
 */
export async function toRgb(
  page: Page,
  colour: string,
): Promise<{ r: number; g: number; b: number; a: number }> {
  return page.evaluate((value) => {
    const canvas = document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    const context = canvas.getContext("2d", { willReadFrequently: true })!;
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = "#000";
    context.fillStyle = value;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = context.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a: a / 255 };
  }, colour);
}

/** WCAG 2.x contrast between two computed colour strings, evaluated in-page. */
export async function contrast(
  page: Page,
  foreground: string,
  background: string,
): Promise<number> {
  const fg = await toRgb(page, foreground);
  const bg = await toRgb(page, background);
  const channel = (value: number) => {
    const s = value / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const luminance = (c: { r: number; g: number; b: number }) =>
    0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
  const lf = luminance(fg);
  const lb = luminance(bg);
  return (Math.max(lf, lb) + 0.05) / (Math.min(lf, lb) + 0.05);
}
