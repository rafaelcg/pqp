import { expect, test, type Page } from "@playwright/test";
import { openApp } from "./fixtures";

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const headers = {
  "Content-Type": "application/json",
  Authorization: `Bearer ${DEV_TOKEN}`,
};

/**
 * Push-to-talk in a real browser, because the two things that matter about it
 * are things a unit test cannot see.
 *
 * `push-to-talk.test.ts` pins the decision table, but the decision table takes
 * an event target, and *what the browser puts in that field* is the entire
 * question. A textarea's keydown target being the textarea, a keyup after focus
 * has moved still carrying the old element, `preventDefault` actually
 * suppressing the character — none of that is testable against a plain object.
 * So the focus trap is verified here, against a genuine focused composer, with
 * genuine key events.
 */

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
    ],
  },
  permissions: ["microphone"],
  trace: "off",
});

const BACKQUOTE = {
  code: "Backquote",
  label: "`",
  ctrl: false,
  alt: false,
  shift: false,
  meta: false,
};

/**
 * Seed the mode through `localStorage` rather than by driving the settings
 * dialog: this spec is about the key, and a dozen clicks through an unrelated
 * dialog is a dozen ways for it to fail for reasons that are not push-to-talk.
 * The dialog's own wiring is covered by the last test in the file.
 */
async function usePushToTalk(page: Page): Promise<void> {
  await page.addInitScript(
    ([binding]) => {
      const raw = localStorage.getItem("pqp-local-settings");
      const stored = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      localStorage.setItem(
        "pqp-local-settings",
        JSON.stringify({
          ...stored,
          inputMode: "push-to-talk",
          pushToTalkKey: binding,
        }),
      );
    },
    [BACKQUOTE] as const,
  );
}

async function ensureVoiceChannel(): Promise<void> {
  const res = await fetch(`${API}/api/servers`, { headers });
  const { servers } = (await res.json()) as { servers: { id: string }[] };
  const serverId = servers[0]!.id;
  const list = await fetch(`${API}/api/servers/${serverId}/channels`, {
    headers,
  });
  const { channels } = (await list.json()) as {
    channels: { name: string; type: string }[];
  };
  if (channels.some((c) => c.type === "voice" && c.name === "lobby")) {
    return;
  }
  await fetch(`${API}/api/servers/${serverId}/channels`, {
    method: "POST",
    headers,
    body: JSON.stringify({ name: "lobby", type: "voice" }),
  });
}

async function joinLobby(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openApp(page);
  await page.getByRole("button", { name: /lobby/ }).first().click();
  await page.getByRole("button", { name: "Join Voice" }).click();
  await expect(page.getByText("Live").first()).toBeVisible({
    timeout: 20_000,
  });
}

/** The hold-to-talk control, whichever of its three labels it is wearing. */
const holdButton = (page: Page) =>
  page.getByRole("button", { name: /Hold to talk|Transmitting|Muted/ });

const isTransmitting = async (page: Page) =>
  (await holdButton(page).getAttribute("aria-pressed")) === "true";

/** Focus nothing in particular — the state a person is in while reading chat. */
async function focusThePage(page: Page): Promise<void> {
  await page.evaluate(() => {
    const active = document.activeElement as HTMLElement | null;
    active?.blur();
  });
}

test.describe("push-to-talk", () => {
  test.beforeEach(async () => {
    await ensureVoiceChannel();
  });

  test("joins closed, opens while held, and closes on release", async ({
    page,
  }) => {
    await usePushToTalk(page);
    await joinLobby(page);

    // Joining push-to-talk is joining silent — without pressing the mute
    // button, which is a different switch and stays off.
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "false");
    await expect(page.getByText("Hold to talk").first()).toBeVisible();

    await focusThePage(page);
    await page.keyboard.down("Backquote");
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "true");

    await page.keyboard.up("Backquote");
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("the key does NOT fire while typing in the composer", async ({
    page,
  }) => {
    await usePushToTalk(page);
    await joinLobby(page);

    const composer = page.locator("textarea").first();
    await composer.click();
    await expect(composer).toBeFocused();

    await page.keyboard.down("Backquote");

    // THE FAILURE THIS TEST EXISTS FOR: holding a letter mid-sentence opening
    // the mic. It stays shut...
    expect(await isTransmitting(page)).toBe(false);
    // ...and the character is still typed, because the handler bows out rather
    // than swallowing the key it decided was not its business.
    await expect(composer).toHaveValue("`");

    await page.keyboard.up("Backquote");
    expect(await isTransmitting(page)).toBe(false);
  });

  test("releasing works even when focus moved into the composer mid-press", async ({
    page,
  }) => {
    await usePushToTalk(page);
    await joinLobby(page);

    await focusThePage(page);
    await page.keyboard.down("Backquote");
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "true");

    // Click into the composer with the key still down. The keyup now arrives
    // with a <textarea> as its target — filter that the way keydown is
    // filtered and the mic never closes again.
    await page.locator("textarea").first().click();
    await page.keyboard.up("Backquote");

    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("losing window focus closes the mic", async ({ page }) => {
    await usePushToTalk(page);
    await joinLobby(page);

    await focusThePage(page);
    await page.keyboard.down("Backquote");
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "true");

    // Alt-Tab: the keyup is delivered to the other application and this page
    // never hears it. Without a blur handler the mic stays open for as long as
    // the user is away — the exact horror story push-to-talk is meant to avoid.
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));

    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "false");
    // And the UI says why, instead of leaving someone pressing a dead key.
    await expect(page.getByText(/window isn't focused/i)).toBeVisible();

    // A stale keyup arriving afterwards must not un-close anything.
    await page.keyboard.up("Backquote");
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "false");
  });

  test("the mute button still outranks the key", async ({ page }) => {
    await usePushToTalk(page);
    await joinLobby(page);

    await page
      .getByRole("main")
      .getByRole("button", { name: "Mute microphone" })
      .click();

    await focusThePage(page);
    await page.keyboard.down("Backquote");
    // Mute has to mean mute, or the button is a lie.
    expect(await isTransmitting(page)).toBe(false);
    await page.keyboard.up("Backquote");
  });

  test("switching mode in settings mid-call keeps the call up", async ({
    page,
  }) => {
    await joinLobby(page);

    // Voice activity is the default, so there is no hold button yet.
    await expect(holdButton(page)).toHaveCount(0);

    await page.getByRole("button", { name: "Open settings" }).click();
    // Settings is sectioned, and the input mode lives in Voice & Audio.
    await page.getByRole("tab", { name: "Voice & Audio" }).click();
    await page.getByRole("radio", { name: /Push to talk/ }).check();
    await page.getByRole("button", { name: "Cancel" }).click();

    // Still in the call — the mode change is `track.enabled`, not a rejoin.
    await expect(page.getByText("Live").first()).toBeVisible();
    await expect(holdButton(page)).toBeVisible();
    await expect(holdButton(page)).toHaveAttribute("aria-pressed", "false");
  });
});
