import { expect, test, type Browser, type Page } from "@playwright/test";
import { E2E_ADMIN_TOKEN } from "../playwright.config";
import { leaveVoiceIfConnected } from "./fixtures";

/**
 * AUDIENCE MODE, three real dev-bypass accounts in one voice call
 * (`docs/plans/AUDIENCE_MODE.md`). The movie night of 2026-10-04 in one
 * spec: the host turns "Modo plateia" on with one tap, the audience's mic is
 * refused WITH the reason on the button, a raised hand reaches the host's
 * queue with a one-tap "Liberar o microfone", that person's mic unlocks while
 * everybody else's stays locked, "Silenciar" takes it back, and turning it off
 * gives everyone their mic back.
 *
 * The suite has no LiveKit, so this is the mesh path end to end (the server
 * pins `muted`, the speaker's client locks, every receiver silences). The SFU
 * half (the grant rewritten at the media server, across two API machines,
 * region routing, failures) is pinned by the server suites:
 * `ws/voice-audience.test.ts`, `ws/voice-audience-cluster.test.ts`,
 * `voice/audience-sfu.test.ts`.
 *
 * Screenshots of the host's control, the audience's state and the queue, at
 * desktop and phone width, go to `test-results/audience-mode/` when
 * `AUDIENCE_SCREENSHOTS=1`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";
const SHOTS = process.env.AUDIENCE_SCREENSHOTS === "1";
/**
 * Screenshots are taken in pt-BR (AGENTS.md: a Portuguese post wants the app
 * in Portuguese); the assertions run in English otherwise. The selectors are
 * data attributes, so only the copy below changes with the language.
 */
const LANG = SHOTS ? "pt-BR" : "en";
const COPY = {
  en: {
    locked: "Audience mode: only the presenters talk",
    ask: "Ask to talk",
    on: "turned audience mode on",
    devBypass: "Dev auth bypass",
    connected: "Voice connected",
  },
  "pt-BR": {
    locked: "Modo plateia: só quem apresenta fala",
    ask: "Pedir pra falar",
    on: "ligou o modo plateia",
    devBypass: "Bypass de auth de desenvolvimento",
    connected: "Na call",
  },
}[LANG];

test.setTimeout(180_000);
test.use({
  viewport: { width: 1440, height: 900 },
  colorScheme: "dark",
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone"],
  trace: "off",
});

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialiseAccount(suffix: string): Promise<string> {
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
    body: JSON.stringify({ onboardedAt: new Date().toISOString() }),
  });
  return body.id;
}

interface Seeded {
  serverId: string;
  generalChannelId: string;
  voiceChannelName: string;
  ids: Record<string, string>;
}

async function seed(host: string, guests: string[]): Promise<Seeded> {
  const ids: Record<string, string> = {};
  for (const suffix of [host, ...guests]) {
    ids[suffix] = await materialiseAccount(suffix);
  }
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(host),
    body: JSON.stringify({ name: `Cinema ${Date.now()}` }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  const voiceChannelName = `sessao-${Date.now()}`;
  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(host),
    body: JSON.stringify({ name: voiceChannelName, type: "voice" }),
  });
  const channelsRes = await fetch(`${API}/api/servers/${server.id}/channels`, {
    headers: headersFor(host),
  });
  const { channels } = (await channelsRes.json()) as {
    channels: { id: string; type: string; name: string }[];
  };
  const general = channels.find((c) => c.type === "text")!;
  const inviteRes = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(host),
    body: JSON.stringify({}),
  });
  const { invite } = (await inviteRes.json()) as { invite: { code: string } };
  for (const guest of guests) {
    const joined = await fetch(`${API}/api/invites/${invite.code}/join`, {
      method: "POST",
      headers: headersFor(guest),
    });
    if (!joined.ok) {
      throw new Error(`${guest} could not join: ${joined.status}`);
    }
  }
  // The operator turns the feature on for THIS server only, the way the
  // dashboard does (per-server override of `audience_mode`).
  const flip = await fetch(`${API}/api/admin/flag-overrides`, {
    method: "PUT",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${E2E_ADMIN_TOKEN}`,
    },
    body: JSON.stringify({ key: "audience_mode", serverId: server.id, enabled: true }),
  });
  expect(flip.status).toBe(200);
  return { serverId: server.id, generalChannelId: general.id, voiceChannelName, ids };
}

async function openAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=${LANG}`);
  await expect(page.getByText(COPY.devBypass)).toBeVisible({ timeout: 20_000 });
}

async function client(browser: Browser) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: "dark",
    permissions: ["microphone"],
  });
  return { context, page: await context.newPage() };
}

async function joinVoice(page: Page, channelName: string): Promise<void> {
  await page.getByRole("button", { name: new RegExp(channelName, "i") }).first().dblclick();
  await expect(page.getByText(COPY.connected, { exact: true })).toBeVisible({
    timeout: 20_000,
  });
  // The fake device's tone opens the voice-activity gate, and speaking lowers
  // your own hand by design (docs/RAISED_HANDS.md). Mute first, as in
  // raised-hands.spec.ts.
  const mute = micButton(page);
  await expect(mute).toBeVisible({ timeout: 10_000 });
  if ((await mute.getAttribute("aria-pressed")) !== "true") {
    await mute.click();
    await expect(mute).toHaveAttribute("aria-pressed", "true");
  }
}

function dock(page: Page) {
  return page.getByTestId("call-stage-collapsed");
}

/** The bar's mute, in any language. */
function micButton(page: Page) {
  return dock(page).locator("[data-mic-toggle]");
}

async function shot(page: Page, name: string) {
  if (!SHOTS) {
    return;
  }
  await page.screenshot({ path: `test-results/audience-mode/${name}.png` });
}

test("a host turns audience mode on, the audience is told why, a hand is let in and sent back", async ({
  page,
  browser,
}) => {
  const seeded = await seed("aud-host", ["aud-alberto", "aud-bia"]);
  const here = `/app/server/${seeded.serverId}/channel/${seeded.generalChannelId}`;
  const alberto = await client(browser);
  const bia = await client(browser);
  try {
    await openAs(page, here, "aud-host");
    await joinVoice(page, seeded.voiceChannelName);
    await openAs(alberto.page, here, "aud-alberto");
    await joinVoice(alberto.page, seeded.voiceChannelName);
    await openAs(bia.page, here, "aud-bia");
    await joinVoice(bia.page, seeded.voiceChannelName);

    // The audience never sees the host's control.
    await expect(dock(alberto.page).locator("[data-audience-toggle]")).toHaveCount(0);

    // One tap, no confirm, visible ON.
    const toggle = dock(page).locator("[data-audience-toggle]");
    await expect(toggle).toHaveAttribute("aria-pressed", "false", { timeout: 20_000 });
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    await expect(dock(page).locator('[data-audience-line="open"]')).toBeVisible();
    await shot(page, "host-on-desktop");

    // The audience: the mic is disabled and SAYS why, and the hand is the
    // primary control.
    for (const viewer of [alberto.page, bia.page]) {
      const mic = dock(viewer).locator('[data-speak-locked="audience"]');
      await expect(mic).toBeVisible({ timeout: 10_000 });
      await expect(mic).toBeDisabled();
      await expect(mic).toHaveAttribute("aria-label", COPY.locked);
      await expect(dock(viewer).locator('[data-audience-line="locked"]')).toBeVisible();
      await expect(dock(viewer).locator("[data-raise-hand]")).toHaveAttribute(
        "data-primary",
        "",
      );
    }
    await expect(dock(alberto.page).locator('[data-audience-notice="on"]')).toContainText(
      COPY.on,
    );
    await shot(alberto.page, "audience-desktop");

    // Alberto asks.
    const hand = dock(alberto.page).locator("[data-raise-hand]");
    await expect(hand).toHaveAttribute("aria-label", COPY.ask);
    await hand.click();
    await expect(hand).toHaveAttribute("aria-pressed", "true");

    // The host sees him first in the queue with a one-tap button.
    const allow = dock(page).locator(`[data-audience-allow="${seeded.ids["aud-alberto"]}"]`);
    await expect(allow).toBeVisible({ timeout: 10_000 });
    await shot(page, "host-queue-desktop");
    if (SHOTS) {
      await page.setViewportSize({ width: 390, height: 844 });
      await page.waitForTimeout(400);
      await shot(page, "host-queue-phone");
      await page.setViewportSize({ width: 1440, height: 900 });
    }
    await allow.click();

    // His mic unlocks (still muted: he decides when to talk); Bia's does not.
    await expect(dock(alberto.page).locator("[data-speak-locked]")).toHaveCount(0, {
      timeout: 10_000,
    });
    const albertoMic = micButton(alberto.page);
    await expect(albertoMic).toBeEnabled();
    await expect(albertoMic).toHaveAttribute("aria-pressed", "true");
    await expect(hand).toHaveAttribute("aria-pressed", "false");
    await expect(dock(bia.page).locator('[data-speak-locked="audience"]')).toBeVisible();
    await albertoMic.click();
    await expect(albertoMic).toHaveAttribute("aria-pressed", "false");

    // The host sees who was let in, with a Silenciar.
    const silence = dock(page).locator(`[data-audience-silence="${seeded.ids["aud-alberto"]}"]`);
    await expect(silence).toBeVisible();
    await shot(page, "host-speakers-desktop");
    await silence.click();
    await expect(dock(alberto.page).locator('[data-speak-locked="audience"]')).toBeVisible({
      timeout: 10_000,
    });

    // Phone width.
    if (SHOTS) {
      for (const [viewer, name] of [
        [page, "host"],
        [alberto.page, "audience"],
      ] as const) {
        await viewer.setViewportSize({ width: 390, height: 844 });
        await viewer.waitForTimeout(400);
        await shot(viewer, `${name}-phone`);
        await viewer.setViewportSize({ width: 1440, height: 900 });
      }
    }

    // Off: everybody's mic comes back.
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    for (const viewer of [alberto.page, bia.page]) {
      await expect(dock(viewer).locator("[data-speak-locked]")).toHaveCount(0, {
        timeout: 10_000,
      });
      await expect(dock(viewer).locator("[data-audience-line]")).toHaveCount(0);
    }
  } finally {
    await leaveVoiceIfConnected(alberto.page).catch(() => {});
    await leaveVoiceIfConnected(bia.page).catch(() => {});
    await leaveVoiceIfConnected(page).catch(() => {});
    await alberto.context.close();
    await bia.context.close();
  }
});
