import { expect, test, type Browser, type Page } from "@playwright/test";
import { waitUntilVoiceConnected } from "./fixtures";

/**
 * Does the line under the quality menu ever say a number?
 *
 * IT DID NOT, FOR ITS WHOLE LIFE, AND EVERY UNIT TEST PASSED. The readout
 * reads `lib/voice-stats-probe.ts`, which handed `getStats()` straight to its
 * parser as an iterable. `RTCStatsReport` is maplike: iterating it yields
 * `[id, stat]` pairs, so the parser saw a list of two-element arrays, matched
 * nothing, and returned an empty snapshot. The readout has one branch for
 * that, and it is the one that says there is no outgoing video to measure. So
 * a person with their camera on, sending 1.5 Mbps to a peer, was told there
 * was nothing to measure, and `pqpVoiceStats.report()` in the console said "no
 * mesh connections" from inside a live call.
 *
 * The unit tests could not see it because they feed arrays of plain objects,
 * and an array iterates as its elements. Only a browser has the maplike shape,
 * which is why this check has to be an e2e one.
 *
 * IT ASSERTS THE SENTENCE, NOT THE NUMBERS. What the encoder chooses to spend
 * on Chrome's fake camera is not a fact about pqp. That the readout reached
 * the encoder at all, and printed a size and a rate rather than an apology, is.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const DEV_TOKEN = "dev-local-token";

test.use({
  launchOptions: {
    args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream"],
  },
  permissions: ["microphone", "camera"],
});

test.setTimeout(120_000);

function headersFor(suffix: string) {
  return {
    "Content-Type": "application/json",
    Authorization: `Bearer ${DEV_TOKEN}:${suffix}`,
  };
}

async function materialiseAccount(suffix: string) {
  const headers = headersFor(suffix);
  const me = await fetch(`${API}/api/me`, { headers });
  const body = (await me.json()) as {
    id: string;
    displayName: string;
    ageGate?: string;
  };
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
  return body;
}

async function seedVoiceServer(hostSuffix: string, guestSuffix: string) {
  await materialiseAccount(hostSuffix);
  await materialiseAccount(guestSuffix);
  const created = await fetch(`${API}/api/servers`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "Readout" }),
  });
  const { server } = (await created.json()) as { server: { id: string } };
  await fetch(`${API}/api/servers/${server.id}/channels`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({ name: "stage", type: "voice" }),
  });
  const invited = await fetch(`${API}/api/servers/${server.id}/invites`, {
    method: "POST",
    headers: headersFor(hostSuffix),
    body: JSON.stringify({}),
  });
  const { invite } = (await invited.json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headersFor(guestSuffix),
    body: "{}",
  });
  return server.id;
}

async function bootAs(page: Page, path: string, suffix: string): Promise<void> {
  await page.addInitScript((value) => {
    localStorage.setItem("pqp:dev-user-suffix", value);
  }, suffix);
  await page.goto(`${path}?lang=en`);
  await expect(page.getByText("Dev auth bypass")).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole("button", { name: "Send" })).toBeVisible({
    timeout: 30_000,
  });
}

async function joinVoice(page: Page): Promise<void> {
  await page.getByRole("button", { name: /stage/ }).first().click();
  await expect(page.getByTestId("call-stage-collapsed")).toBeVisible({ timeout: 30_000 });
  await waitUntilVoiceConnected(page);
}

async function secondClient(browser: Browser, path: string, suffix: string) {
  const context = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    colorScheme: "dark",
  });
  await context.grantPermissions(["microphone", "camera"]);
  const page = await context.newPage();
  await bootAs(page, path, suffix);
  return { context, page };
}

test("the in-call readout reports the camera that is actually on the wire", async ({
  page,
  browser,
}) => {
  const serverId = await seedVoiceServer("ro-a", "ro-b");
  const watcher = await secondClient(browser, `/app/servers/${serverId}`, "ro-b");

  try {
    await bootAs(page, `/app/servers/${serverId}`, "ro-a");
    await joinVoice(page);
    await joinVoice(watcher.page);

    await page
      .getByRole("button", { name: "Turn camera on", exact: true })
      .click({ timeout: 15_000 });
    await expect(watcher.page.getByLabel(/camera$/)).toBeVisible({
      timeout: 40_000,
    });

    await page
      .getByRole("button", { name: /^Video you send:/ })
      .click({ timeout: 15_000 });
    const menu = page.getByRole("menu", { name: /^Video you send:/ });
    await expect(menu).toBeVisible({ timeout: 15_000 });

    // Polled rather than read once: the readout samples on a two-second timer,
    // and the encoder needs a frame or two before it can report a size at all.
    await expect
      .poll(async () => (await menu.evaluate((el) => el.textContent)) ?? "", {
        timeout: 30_000,
        message: "the readout names a size and a rate",
      })
      .toMatch(/Sending \d+x\d+ at \d+ fps, \d+ kbps/);
  } finally {
    await watcher.context.close();
  }
});
