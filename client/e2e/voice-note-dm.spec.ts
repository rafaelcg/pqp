import { expect, test, type Browser, type Page } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Voice notes in a DM, end to end, two real browser contexts.
 *
 * Alice records with Chrome's fake microphone (fed a generated WAV, so there
 * is something for the waveform to draw), sends with Enter, and Bob plays it:
 * the dot goes, the listen is reported. A second test is the native-app case:
 * a note recorded on a phone is AAC in MP4, uploaded by the API here, and the
 * web card has to play it.
 *
 * Needs object storage: a voice note is an upload. CI has no bucket, so the
 * suite skips there with the attachments config saying so; locally run it
 * with `docker compose --profile storage up -d` and the `S3_*` variables.
 *
 * The `voice_notes` flag is flipped through the admin machine token, the way
 * the operator dashboard does it. A conversation reads the global value, so
 * it is put back to "follow the environment" in `finally`.
 */

const API = process.env.E2E_API_URL ?? "http://localhost:3101";
const ADMIN_TOKEN = "e2e-admin-token-0123456789abcdef";

/** Two seconds of something voice-shaped: a tone that swells and dips. */
function fakeVoiceWav(): string {
  const rate = 48_000;
  const seconds = 3;
  const samples = rate * seconds;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20); // PCM
  buffer.writeUInt16LE(1, 22); // mono
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    const t = i / rate;
    const envelope = Math.abs(Math.sin(Math.PI * 1.5 * t));
    const value = Math.sin(2 * Math.PI * 220 * t) * envelope * 0.7;
    buffer.writeInt16LE(Math.round(value * 32_767), 44 + i * 2);
  }
  const path = join(tmpdir(), "pqp-e2e-voice-note.wav");
  writeFileSync(path, buffer);
  return path;
}

test.use({
  launchOptions: {
    args: [
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${fakeVoiceWav()}`,
    ],
  },
  permissions: ["microphone"],
});

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

/** Alice and Bob, a server they share (so a DM is allowed), and the DM. */
async function pair(stamp: string) {
  const alice = `vn-alice-${stamp}`;
  const bob = `vn-bob-${stamp}`;
  await person(alice, "Alice");
  const bobId = await person(bob, "Bob");
  const { server } = (await (
    await fetch(`${API}/api/servers`, {
      method: "POST",
      headers: headers(alice),
      body: JSON.stringify({ name: `Voz ${stamp}` }),
    })
  ).json()) as { server: { id: string } };
  const { invite } = (await (
    await fetch(`${API}/api/servers/${server.id}/invites`, {
      method: "POST",
      headers: headers(alice),
      body: "{}",
    })
  ).json()) as { invite: { code: string } };
  await fetch(`${API}/api/invites/${invite.code}/join`, {
    method: "POST",
    headers: headers(bob),
  });
  const { conversation } = (await (
    await fetch(`${API}/api/dms`, {
      method: "POST",
      headers: headers(alice),
      body: JSON.stringify({ userIds: [bobId] }),
    })
  ).json()) as { conversation: { channelId: string } };
  return { alice, bob, dm: conversation.channelId };
}

async function setGlobalFlag(key: string, enabled: boolean | null) {
  const res = await fetch(`${API}/api/admin/flags`, {
    method: "PUT",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${ADMIN_TOKEN}` },
    body: JSON.stringify({ key, enabled }),
  });
  expect(res.status).toBe(200);
}

async function openAs(browser: Browser, suffix: string, dm: string): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 820 } });
  const page = await context.newPage();
  await page.addInitScript((s) => localStorage.setItem("pqp:dev-user-suffix", s), suffix);
  await page.goto(`/app/dm/${dm}?lang=en`);
  await expect(page.getByRole("combobox", { name: /Message/ })).toBeVisible({ timeout: 20_000 });
  return page;
}

async function storageConfigured(): Promise<boolean> {
  // A fresh account answers 403 until its age check, so the probe is one.
  await person("vn-probe", "Probe");
  const res = await fetch(`${API}/api/attachments/config`, { headers: headers("vn-probe") });
  const config = (await res.json()) as { enabled?: boolean };
  return config.enabled === true;
}

test.describe("voice notes in a DM", () => {
  test.beforeEach(async () => {
    test.skip(!(await storageConfigured()), "no object storage on this server (S3_* unset)");
  });

  test("with the flag off the composer keeps its send button and no mic", async ({ browser }) => {
    const { alice, dm } = await pair(`off${Date.now().toString(36)}`);
    await setGlobalFlag("voice_notes", false);
    try {
      const page = await openAs(browser, alice, dm);
      await expect(page.getByRole("button", { name: "Send" })).toBeVisible();
      await expect(page.getByRole("button", { name: "Record a voice message" })).toHaveCount(0);
      await page.context().close();
    } finally {
      await setGlobalFlag("voice_notes", null);
    }
  });

  test("Alice records and sends with Enter, Bob plays it and the dot goes", async ({ browser }) => {
    test.setTimeout(90_000);
    const { alice, bob, dm } = await pair(Date.now().toString(36));
    await setGlobalFlag("voice_notes", true);
    try {
      const alicePage = await openAs(browser, alice, dm);
      // Empty composer: the send button is a mic.
      const mic = alicePage.getByRole("button", { name: "Record a voice message" });
      await expect(mic).toBeVisible();
      await expect(alicePage.getByRole("button", { name: "Send", exact: true })).toHaveCount(0);
      // Typing brings Send back.
      await alicePage.getByRole("combobox", { name: /Message/ }).fill("oi");
      await expect(mic).toHaveCount(0);
      await alicePage.getByRole("combobox", { name: /Message/ }).fill("");

      await mic.click();
      const panel = alicePage.locator("[data-voice-note-panel='recording']");
      await expect(panel).toBeVisible();
      await expect(panel.getByRole("timer")).toHaveText(/0:0[2-9]/, { timeout: 10_000 });
      if (process.env.SHOT_DIR) {
        await alicePage.screenshot({ path: `${process.env.SHOT_DIR}/voice-note-recording.png` });
      }
      await alicePage.keyboard.press("Enter");

      const sent = alicePage.getByRole("log").locator("[data-voice-note]");
      await expect(sent).toHaveCount(1, { timeout: 15_000 });
      await expect(sent.getByRole("group")).toHaveAccessibleName(/Voice message, 0:0\d/);
      // The composer is a composer again.
      await expect(alicePage.getByRole("combobox", { name: /Message/ })).toBeVisible();

      const bobPage = await openAs(browser, bob, dm);
      const received = bobPage.getByRole("log").locator("[data-voice-note]");
      await expect(received).toHaveCount(1, { timeout: 15_000 });
      await expect(received.locator("[data-voice-note-unheard]")).toHaveCount(1);
      if (process.env.SHOT_DIR) {
        await bobPage.screenshot({ path: `${process.env.SHOT_DIR}/voice-note-received.png` });
      }

      const listened = bobPage.waitForRequest(
        (request) => request.method() === "POST" && /\/api\/attachments\/[^/]+\/listened$/.test(request.url()),
        { timeout: 15_000 },
      );
      await received.getByRole("button", { name: "Play voice message from Alice" }).click();
      await expect(received.getByRole("button", { name: "Pause voice message" })).toBeVisible({
        timeout: 10_000,
      });
      // Past a second of playback it counts as heard: the dot goes and the
      // listen is reported once.
      await listened;
      await expect(received.locator("[data-voice-note-unheard]")).toHaveCount(0);

      // The speed pill steps and is remembered for this account.
      await received.getByRole("button", { name: "Playback speed 1x" }).click();
      await expect(received.getByRole("button", { name: "Playback speed 1.5x" })).toBeVisible();
      await bobPage.reload();
      await expect(
        bobPage.getByRole("log").locator("[data-voice-note]").getByRole("button", {
          name: "Playback speed 1.5x",
        }),
      ).toBeVisible({ timeout: 15_000 });

      await alicePage.context().close();
      await bobPage.context().close();
    } finally {
      await setGlobalFlag("voice_notes", null);
    }
  });

  test("Esc discards a recording, and Undo brings it back", async ({ browser }) => {
    const { alice, dm } = await pair(`esc${Date.now().toString(36)}`);
    await setGlobalFlag("voice_notes", true);
    try {
      const page = await openAs(browser, alice, dm);
      await page.getByRole("button", { name: "Record a voice message" }).click();
      const panel = page.locator("[data-voice-note-panel='recording']");
      await expect(panel.getByRole("timer")).toHaveText(/0:01/, { timeout: 10_000 });
      await page.keyboard.press("Escape");
      await expect(panel).toHaveCount(0);
      await expect(page.getByText(/Voice message discarded/)).toBeVisible();
      await page.getByRole("button", { name: "Undo" }).click();
      await expect(page.locator("[data-voice-note-panel='review']")).toBeVisible();
      await page.getByRole("button", { name: "Discard voice message" }).click();
      await expect(page.getByRole("button", { name: "Record a voice message" })).toBeVisible();
      await page.context().close();
    } finally {
      await setGlobalFlag("voice_notes", null);
    }
  });

  test("a note recorded on a phone (AAC in MP4) plays in the web card", async ({ browser }) => {
    test.setTimeout(60_000);
    const { alice, bob, dm } = await pair(`mp4${Date.now().toString(36)}`);
    await setGlobalFlag("voice_notes", true);
    try {
      // Bob's phone: mint with the voice block, PUT the bytes, send over the socket.
      const bytes = readFileSync(fileURLToPath(new URL("./fixtures/voice-note.m4a", import.meta.url)));
      const waveform = Buffer.from(
        Array.from({ length: 64 }, (_, i) => Math.round(80 + 120 * Math.abs(Math.sin(i / 5)))),
      ).toString("base64");
      const mintRes = await fetch(`${API}/api/channels/${dm}/attachments`, {
        method: "POST",
        headers: headers(bob),
        body: JSON.stringify({
          filename: "voice-note.m4a",
          contentType: "audio/mp4",
          byteSize: bytes.length,
          voice: { durationMs: 4633, waveform },
        }),
      });
      expect(mintRes.status).toBe(201);
      const minted = (await mintRes.json()) as { attachmentId: string; uploadUrl: string };
      const put = await fetch(minted.uploadUrl, {
        method: "PUT",
        headers: { "Content-Type": "audio/mp4" },
        body: bytes,
      });
      expect(put.ok).toBe(true);
      await sendOverSocket(bob, dm, minted.attachmentId);

      const page = await openAs(browser, alice, dm);
      const canPlayAac = await page.evaluate(
        () => document.createElement("audio").canPlayType('audio/mp4; codecs="mp4a.40.2"') !== "",
      );
      test.skip(!canPlayAac, "this Chromium build has no AAC decoder");
      const card = page.getByRole("log").locator("[data-voice-note]");
      await expect(card).toHaveCount(1, { timeout: 15_000 });
      await expect(card.getByRole("group")).toHaveAccessibleName("Voice message, 0:05");
      await card.getByRole("button", { name: "Play voice message from Bob" }).click();
      await expect(card.getByRole("button", { name: "Pause voice message" })).toBeVisible({
        timeout: 10_000,
      });
      // It is really decoding: the position moves.
      await expect(card.getByRole("slider")).toHaveAttribute("aria-valuenow", /[1-4]/, {
        timeout: 10_000,
      });
      await page.context().close();
    } finally {
      await setGlobalFlag("voice_notes", null);
    }
  });
});

/** The native clients send over the same socket; so does this. */
async function sendOverSocket(suffix: string, channelId: string, attachmentId: string) {
  const socket = new WebSocket(`${API.replace(/^http/, "ws")}/ws`);
  await new Promise<void>((resolve, reject) => {
    socket.addEventListener("open", () => resolve());
    socket.addEventListener("error", () => reject(new Error("ws error")));
  });
  const nonce = `vn-${Date.now()}`;
  const done = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("no broadcast")), 15_000);
    socket.addEventListener("message", (event) => {
      const frame = JSON.parse(String(event.data)) as { type: string; nonce?: string };
      if (frame.type === "ready") {
        socket.send(JSON.stringify({ type: "join-channel", channelId }));
        socket.send(
          JSON.stringify({ type: "message-create", channelId, body: "", nonce, attachmentIds: [attachmentId] }),
        );
      }
      if (frame.type === "message-rejected") {
        clearTimeout(timer);
        reject(new Error(`rejected: ${String(event.data)}`));
      }
      if (frame.type === "message-broadcast" && frame.nonce === nonce) {
        clearTimeout(timer);
        resolve();
      }
    });
  });
  socket.send(JSON.stringify({ type: "auth", token: `dev-local-token:${suffix}` }));
  await done;
  socket.close();
}
