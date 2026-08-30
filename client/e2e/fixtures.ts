import { expect, type Page } from "@playwright/test";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

/**
 * A fresh database has no servers, so `/app` renders the empty state and none
 * of the chat chrome exists. Seed one through the API — faster and far less
 * brittle than driving the create-server form.
 */
/**
 * Answer the 18+ gate so the rest of the suite can reach the app at all.
 *
 * The gate refuses every route but a handful until the account has declared a
 * date of birth, so on the fresh database CI creates, *every* spec dies in
 * `ensureServer` with "Confirm your date of birth" rather than in whatever it
 * was actually testing. Answering it here rather than in each spec keeps that
 * one-time setup out of tests that are about something else.
 *
 * The declaration is one-shot by design — a second answer is a 409 — so this
 * treats "already answered" as success rather than an error.
 */
async function ensureAgeCheck(headers: Record<string, string>): Promise<void> {
  const me = await fetch(`${API}/api/me`, { headers });
  if (me.ok) {
    const { ageGate } = (await me.json()) as { ageGate?: string };
    if (ageGate === "passed") {
      return;
    }
  }
  // Comfortably an adult, and stable so a run is not date-dependent.
  await fetch(`${API}/api/me/age-check`, {
    method: "POST",
    headers,
    body: JSON.stringify({ dateOfBirth: "1990-01-01" }),
  });
}

export async function ensureServer(): Promise<void> {
  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}`,
  };
  await ensureAgeCheck(headers);
  // Mark onboarding done for the same reason the age gate is answered here:
  // on the fresh database CI creates, the account is born after boot, so the
  // grandfathering backfill never saw it and the wizard would cover the app —
  // every message spec then times out uniformly in setup. Locally this is a
  // no-op, since the shared dev account has long since been stamped.
  //
  // `firstRunDismissedAt` rides along for the same reason one step further in.
  // The shared account has a server but never a friend and never an avatar, so
  // the hub's first-run checklist reads as outstanding forever and would draw
  // itself above the tab content on every spec that opens `/app/dm` — moving the
  // rows the DM and call specs measure. Only `first-run.spec.ts` wants to see it,
  // and that spec mints its own account rather than borrowing this one.
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({
      onboardedAt: new Date().toISOString(),
      firstRunDismissedAt: new Date().toISOString(),
    }),
  });
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
 * Every cross-device preference, at its default.
 *
 * `user_preferences` is one JSONB blob merged shallowly (`settings || patch`),
 * so a key can never be *removed* — only overwritten. That means resetting has
 * to name every key and its default value rather than sending `{}`, and it is
 * why this list must grow whenever `userPreferencesSchema` does.
 *
 * `onboardedAt` and `firstRunDismissedAt` are deliberately absent: clearing
 * either re-arms a first-run surface, and every spec would then open into the
 * handle picker, or into a hub with a checklist sitting on top of the rows it
 * came to measure. They are the two preferences a reset must leave alone —
 * `ensureServer` sets them instead.
 */
const DEFAULT_PREFERENCES = {
  theme: "system",
  appearance: "signal",
  contrast: "system",
  accentHue: "default",
  muteOnJoin: false,
  compactPeers: false,
  inputVolume: 1,
  outputVolume: 1,
  showLinkEmbeds: true,
  // Merged one level deep like everything else, so the whole object goes or the
  // levels it omits survive.
  notifications: { desktop: false, default: "all", servers: {}, channels: {} },
  sounds: {
    enabled: true,
    message: true,
    mention: true,
    incomingCall: true,
    outgoingCall: true,
  },
} as const;

/**
 * Preferences are server state, and the suite shares one dev-bypass account
 * against a persistent database — so anything a spec stores is still there for
 * the next one.
 *
 * This used to reset the theme alone, which made every other preference a
 * one-way door: `theme-preferences.spec.ts` sets `compactPeers: true`, that
 * shrinks every voice tile, and `voice-lobby.spec.ts` then measured a grid
 * whose height depended on which spec had run first. Resetting the whole set is
 * what makes the suite order-independent; a spec should never have to know what
 * ran before it.
 *
 * Purely local state (`pqp:collapsed-categories`, `pqp-local-settings`,
 * `pqp:locale`, the theme's own localStorage key) needs nothing here: Playwright
 * gives each test a fresh context, so it starts empty every time. The server
 * copy is the only thing that survives a context.
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
    preferences?: Record<string, unknown>;
  };
  const stored = me.preferences ?? {};
  const dirty = Object.entries(DEFAULT_PREFERENCES).some(
    ([key, value]) =>
      key in stored &&
      JSON.stringify(stored[key]) !== JSON.stringify(value),
  );
  if (!dirty) {
    return;
  }
  await fetch(`${API}/api/me/preferences`, {
    method: "PATCH",
    headers,
    body: JSON.stringify(DEFAULT_PREFERENCES),
  });
}

export async function openApp(page: Page): Promise<void> {
  await ensureServer();
  await resetPreferences();
  // Pin English. `?lang=` outranks the browser, so a Portuguese runner (or a
  // leftover `pqp:locale`) cannot flip the rest of the suite. The one test
  // that must follow the browser skips this helper.
  await page.goto("/app?lang=en");
  await expect(page.getByText("Dev auth bypass")).toBeVisible({ timeout: 20_000 });
  // The composer only exists once a text channel is selected.
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Camera, screen share, and push-to-talk are no-ops until the socket is
 * connected. The slim bar appears while still joining, so waiting on it alone
 * is not enough.
 */
export async function waitUntilVoiceConnected(page: Page): Promise<void> {
  await expect(page.getByText("Voice connected")).toBeVisible({
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
