import { mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Page, type Route } from "@playwright/test";
import { encodeWav } from "../../src/lib/jam/pcm";

/**
 * The public jam site, end to end in a real browser. The API is mocked, so what
 * is proved is the client: no media before a play, the song really plays on the
 * engine's clock, the mosaic and its spotlight, the sign-up sheet and the intent
 * it carries to the app, the disabled page, and 390 px.
 */

/** Real-click screenshots for a PR's QA section, only when asked for (`PQP_QA_SHOTS=<dir>`). */
async function shot(page: Page, name: string): Promise<void> {
  const dir = process.env.PQP_QA_SHOTS;
  if (!dir) return;
  mkdirSync(dir, { recursive: true });
  await page.waitForTimeout(500); // let a dialog finish its fade, so the picture is what a person sees
  await page.screenshot({ path: path.join(dir, `${name}.png`) });
}

const SONG_A = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";
const SONG_B = "7a1d3b2c-9e8f-4a5b-8c6d-0e1f2a3b4c5d";
const SONG_C = "5c4b3a29-1807-4f6e-9d5c-3b2a19087f6e";
const SONG_D = "3d4c5b6a-7e8f-4a9b-8c0d-2e3f4a5b6c7d";
const SONG_E = "9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a";

const person = (name: string, handle: string | null = null) => ({ name, handle, avatarUrl: null });

function song(id: string, title: string, parts: Array<[string, string]>, needs: string[], extra: object = {}) {
  return {
    id,
    title,
    artist: null,
    // A cover is part of what earns the hero (`pickFeatured`); `song(..., { coverUrl: null })` is the coverless one.
    coverUrl: "/e2e-media/cover.png",
    durationMs: 6000,
    previewPeaks: [0.2, 0.6, 0.3, 0.9, 0.4, 0.7, 0.2, 0.5, 0.8, 0.3, 0.6, 0.4],
    parts: parts.map(([instrument, name]) => ({ instrument, person: person(name), hasVideo: false })),
    needs,
    plays: 120,
    likes: 1,
    startedBy: person("Leco", "leco"),
    origin: null,
    publishedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    createdAt: new Date(Date.now() - 4 * 3600_000).toISOString(),
    updatedAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
    ...extra,
  };
}

const A = song(SONG_A, "Minuano", [["drums", "Leco"], ["guitar", "Tchelo"]], ["bass"], { likes: 48 });
const B = song(SONG_B, "Riff solto", [["guitar", "Duda"]], ["vocals"]);
const C = song(SONG_C, "Duo pronto", [["keys", "Gui"], ["bass", "Nanda"]], []);
/** A song that takes no part from a visitor: only its starter adds. */
const D = song(SONG_D, "Gravada e fechada", [["drums", "Leco"], ["guitar", "Tchelo"]], [], { joinMode: "closed" });
/** A song that asks for more than one instrument (round 3, n-8). */
const E = song(SONG_E, "Pede duas", [["guitar", "Tchelo"]], ["drums", "vocals", "keys"], { joinMode: "wanted" });

function track(id: string, instrument: string, name: string, offsetMs = 0) {
  return {
    id,
    instrument,
    label: null,
    person: person(name, name.toLowerCase()),
    offsetMs,
    trimStartMs: 0,
    trimEndMs: 0,
    durationMs: 6000,
    gain: 1,
    peaks: Array.from({ length: 60 }, (_, i) => 0.3 + 0.6 * Math.abs(Math.sin(i / 4))),
    audioUrl: `/e2e-media/${id}.wav`,
    audioContentType: "audio/wav",
    videoUrl: null,
    videoContentType: null,
    videoSources: [],
  };
}

/** A 2x2 PNG: a cover that loads without a media server. */
const COVER_PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFklEQVR4nGP4z8Dwn4GB4T8DAwMDAA0KAgHqk9E0AAAAAElFTkSuQmCC", "base64");

const WAV = (() => {
  const sr = 44100;
  const samples = new Float32Array(sr * 6);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
  return Buffer.from(encodeWav([samples], sr));
})();

/** One second of a 96x54 test pattern (VP8), so a tile has a real frame to show without a media server. */
const STILL_WEBM = Buffer.from(
  "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",
  "base64",
);

/** Serves STILL_WEBM the way a bucket does, with byte ranges: a media element asks for them. */
async function serveStill(route: Route): Promise<void> {
  const range = /bytes=(\d+)-(\d*)/.exec(route.request().headers().range ?? "");
  const base = { "access-control-allow-origin": "*", "accept-ranges": "bytes", "content-type": "video/webm" };
  if (!range) {
    return route.fulfill({ status: 200, body: STILL_WEBM, headers: { ...base, "content-length": String(STILL_WEBM.length) } });
  }
  const from = Number(range[1]);
  const to = Math.min(STILL_WEBM.length - 1, range[2] ? Number(range[2]) : STILL_WEBM.length - 1);
  const body = STILL_WEBM.subarray(from, to + 1);
  return route.fulfill({
    status: 206,
    body,
    headers: { ...base, "content-length": String(body.length), "content-range": `bytes ${from}-${to}/${STILL_WEBM.length}` },
  });
}

interface Calls {
  list: URL[];
  detail: string[];
  media: string[];
  plays: string[];
  config: number;
}

async function mockApi(
  page: Page,
  options: { enabled?: boolean; songs?: object[]; page2?: object[]; featuredDelayMs?: number } = {},
): Promise<Calls> {
  const calls: Calls = { list: [], detail: [], media: [], plays: [], config: 0 };
  const enabled = options.enabled ?? true;
  const songs = options.songs ?? [A, B, C];
  await page.route("**/api/public/jams/config", async (route) => {
    calls.config += 1;
    await route.fulfill({ json: { enabled } });
  });
  await page.route("**/api/public/jams?**", async (route) => {
    const url = new URL(route.request().url());
    calls.list.push(url);
    // The hero's read (`useFeatured`, six of Em alta) can be held back, so the grid's
    // own first page lands before it, which is the order a slow network can pick.
    if (options.featuredDelayMs && url.searchParams.get("limit") === "12") {
      await new Promise((resolve) => setTimeout(resolve, options.featuredDelayMs));
    }
    if (url.searchParams.get("cursor") === "c2") {
      return route.fulfill({ json: { songs: options.page2 ?? [], nextCursor: null } });
    }
    return route.fulfill({ json: { songs, nextCursor: options.page2 ? "c2" : null } });
  });
  await page.route(/\/api\/public\/jams\/[0-9a-f-]{36}$/, async (route: Route) => {
    const id = route.request().url().split("/").pop()!;
    calls.detail.push(id);
    const found = [A, B, C, D, E].find((candidate) => candidate.id === id);
    if (!found) return route.fulfill({ status: 404, json: { error: "not found" } });
    const tracks = found.parts.map((part, index) => track(`${id.slice(0, 8)}-t${index}`, part.instrument, part.person.name, index * 500));
    return route.fulfill({
      json: { song: found, tracks, mediaExpiresAt: new Date(Date.now() + 3600_000).toISOString() },
    });
  });
  await page.route(/\/api\/public\/jams\/[0-9a-f-]{36}\/play$/, async (route) => {
    calls.plays.push(route.request().url());
    await route.fulfill({ status: 204 });
  });
  await page.route("**/e2e-media/cover.png", async (route) => {
    await route.fulfill({ body: COVER_PNG, contentType: "image/png", headers: { "access-control-allow-origin": "*" } });
  });
  await page.route("**/e2e-media/*.wav", async (route) => {
    calls.media.push(route.request().url());
    await route.fulfill({ body: WAV, contentType: "audio/wav", headers: { "access-control-allow-origin": "*" } });
  });
  return calls;
}

test.describe("the home", () => {
  test("loads with no audio or video request, and says what each song needs", async ({ page }) => {
    const calls = await mockApi(page);
    const mediaRequests: string[] = [];
    page.on("request", (request) => {
      if (/\.(wav|webm|mp4|flac|mp3|ogg)(\?|$)/.test(request.url()) || request.resourceType() === "media") {
        mediaRequests.push(request.url());
      }
    });
    await page.goto("/jam");
    // The hero is the first song; it is not repeated in the grid under it.
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await expect(page.locator("[data-jam-hero]")).toBeVisible();
    // The hero is the first song with a part; the dashed square says what is missing.
    await expect(page.locator("[data-jam-hero]")).toContainText("Falta um baixo.");
    await page.waitForTimeout(500);
    expect(mediaRequests).toEqual([]);
    expect(calls.media).toEqual([]);
    // Likes show only above one: the hero (48) shows them, the two cards (1 like each) do not.
    await expect(page.locator('[data-jam-hero] [aria-label*="curtida"]')).toContainText("48");
    await expect(page.locator('[data-jam-card] [aria-label*="curtida"]')).toHaveCount(0);
  });

  test("the tabs ask the server for the sort and filter the page for the rest", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await page.locator('[data-jam-tab="needs"]').click();
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await page.locator('[data-jam-tab="done"]').click();
    await expect(page.locator("[data-jam-card]")).toHaveCount(1);
    await page.locator('[data-jam-tab="new"]').click();
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    const sorts = calls.list.map((url) => url.searchParams.get("sort"));
    expect(sorts).toContain("top");
    expect(sorts).toContain("new");
    await page.locator('[data-jam-tab="needs"]').click();
    await page.locator('[data-jam-need="bass"]').click();
    await expect.poll(() => calls.list.some((url) => url.searchParams.get("needs") === "bass")).toBe(true);
  });

  test("pages by cursor as the end of the list nears the screen", async ({ page }) => {
    const second = song("1d2c3b4a-5f6e-4d7c-8b9a-0a1b2c3d4e5f", "Segunda página", [["vocals", "Lia"]], []);
    const calls = await mockApi(page, { page2: [second] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    expect(calls.list.some((url) => url.searchParams.get("cursor") === "c2")).toBe(true);
    await expect(page.locator("[data-jam-more]")).toHaveCount(0);
  });

  test("the hero's song never shows in the grid, even when the grid's page lands first", async ({ page }) => {
    const second = song("1d2c3b4a-5f6e-4d7c-8b9a-0a1b2c3d4e5f", "Segunda página", [["vocals", "Lia"]], []);
    const calls = await mockApi(page, { page2: [second], featuredDelayMs: 1500 });
    const gridPage = page.waitForResponse((response) => /\/api\/public\/jams\?/.test(response.url()) && new URL(response.url()).searchParams.get("limit") === "24");
    await page.goto("/jam");
    await gridPage;
    // The grid's page is in and the hero is still on its way: the grid is drawn
    // without waiting for it, and already leaves out the song the hero will be,
    // rather than show it as a card and pull it out a moment later.
    // Read once, not retried: a retrying assertion would pass by waiting for the hero.
    await page.waitForTimeout(300);
    expect(await page.locator("[data-jam-hero]").count()).toBe(0);
    expect(await page.locator(`[data-jam-card="${SONG_B}"]`).count()).toBe(1);
    expect(await page.locator(`[data-jam-card="${SONG_A}"]`).count()).toBe(0);
    await expect(page.locator(`[data-jam-hero="${SONG_A}"]`)).toBeVisible();
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    await expect(page.locator(`[data-jam-card="${SONG_A}"]`)).toHaveCount(0);
    expect(calls.list.some((url) => url.searchParams.get("cursor") === "c2")).toBe(true);
  });

  test("has a button that does the same where the page cannot watch the scroll", async ({ page }) => {
    await page.addInitScript(() => {
      // @ts-expect-error a browser without the observer
      delete window.IntersectionObserver;
    });
    const second = song("1d2c3b4a-5f6e-4d7c-8b9a-0a1b2c3d4e5f", "Segunda página", [["vocals", "Lia"]], []);
    const calls = await mockApi(page, { page2: [second] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await page.locator("[data-jam-more]").click();
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    expect(calls.list.some((url) => url.searchParams.get("cursor") === "c2")).toBe(true);
    await expect(page.locator("[data-jam-more]")).toHaveCount(0);
  });

  test("says so when the list fails, and tries again", async ({ page }) => {
    await mockApi(page);
    let fail = true;
    await page.route("**/api/public/jams?**", async (route) => {
      if (fail) return route.fulfill({ status: 503, json: {} });
      return route.fulfill({ json: { songs: [A], nextCursor: null } });
    });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-error]")).toBeVisible();
    fail = false;
    await page.getByRole("button", { name: "Tentar de novo" }).click();
    await expect(page.locator("[data-jam-card]")).toHaveCount(1);
  });

  test("shows the empty state", async ({ page }) => {
    await mockApi(page, { songs: [] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-empty]")).toBeVisible();
  });
});

test.describe("a song", () => {
  test("plays on the engine's clock, seeks, and counts the play once", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-tile]")).toHaveCount(2);
    await expect(page.locator("[data-jam-need-tile]")).toHaveCount(1);
    // No audio until the button is pressed.
    expect(calls.media).toEqual([]);
    const toggle = page.locator("[data-jam-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
    expect(calls.media.length).toBe(2);
    const time = page.locator("[data-jam-time] span").first();
    await expect.poll(async () => (await time.textContent()) !== "0:00", { timeout: 8000 }).toBe(true);
    await expect.poll(() => calls.plays.length).toBe(1);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-playing", "false");
    // Keyboard seek: the range is a real slider.
    const seek = page.locator("[data-jam-seek]");
    await seek.focus();
    await seek.press("End");
    await expect(time).toHaveText("0:06");
    await seek.press("Home");
    await expect(time).toHaveText("0:00");
    // Space plays when focus is not in a control.
    await page.locator("h1").click();
    await page.keyboard.press("Space");
    await expect(toggle).toHaveAttribute("data-playing", "true");
  });

  test("a tile spotlights its part, and Escape or the x gives the band back", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    const tiles = page.locator("[data-jam-tile]");
    await tiles.nth(1).click();
    await expect(page.locator("[data-jam-solo]")).toContainText("Só Tchelo");
    await expect(tiles.nth(1)).toHaveAttribute("data-spotlit", "true");
    await page.keyboard.press("Escape");
    await expect(page.locator("[data-jam-solo]")).toHaveCount(0);
    await tiles.nth(0).click();
    await expect(page.locator("[data-jam-solo]")).toContainText("Só Leco");
    await page.locator("[data-jam-solo-exit]").click();
    await expect(page.locator("[data-jam-solo]")).toHaveCount(0);
  });

  test("a focused tile shows a ring drawn over its picture", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    const tile = page.locator("[data-jam-tile]").first();
    await expect(tile).toBeVisible();
    await page.keyboard.press("Shift");
    await tile.focus();
    const shadow = await tile.evaluate((node) => getComputedStyle(node, "::after").boxShadow);
    expect(shadow).not.toBe("none");
  });

  test("a play button on the home opens the song PAUSED: opening never starts sound", async ({ page }) => {
    const calls = await mockApi(page);
    // The engine's code is fetched when the page is idle; wait for it, so the audio could have been unlocked.
    const warmed = page.waitForResponse((response) => /jam-session/.test(response.url()), { timeout: 20_000 });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await warmed;
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.locator(`[data-jam-card] [data-jam-play="${SONG_B}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/jam/m/${SONG_B}$`));
    await expect(page.locator("[data-jam-toggle]")).toHaveAttribute("data-playing", "false");
    await page.waitForTimeout(1200);
    await expect(page.locator("[data-jam-toggle]")).toHaveAttribute("data-playing", "false");
    await expect(page.locator("[data-jam-time]")).toContainText("0:00");
    expect(calls.plays).toEqual([]);
    expect(calls.media).toEqual([]);
  });

  test("play song A, then open song B from the home, a link, or Back: B is paused at 0:00 and no play is counted for it", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    // The hero is A. Open it and press its play: this is a person starting a song.
    await page.locator(`[data-jam-hero="${SONG_A}"] [data-jam-play]`).click();
    await expect(page).toHaveURL(new RegExp(`/jam/m/${SONG_A}$`));
    const toggle = page.locator("[data-jam-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
    await expect.poll(() => calls.plays.filter((url) => url.includes(SONG_A)).length).toBe(1);

    const assertPausedAtZero = async (id: string, counted = 0) => {
      await expect(page).toHaveURL(new RegExp(`/jam/m/${id}$`));
      await expect(page.locator("[data-jam-toggle]")).toHaveAttribute("data-playing", "false");
      await page.waitForTimeout(1200);
      await expect(page.locator("[data-jam-toggle]")).toHaveAttribute("data-playing", "false");
      await expect(page.locator("[data-jam-time]")).toContainText("0:00");
      expect(calls.plays.filter((url) => url.includes(id)).length).toBe(counted);
    };

    // 1. back to the home, the round play button on another card
    await page.goBack();
    await expect(page.locator("[data-jam-card]").first()).toBeVisible();
    await page.locator(`[data-jam-card] [data-jam-play="${SONG_B}"]`).click();
    await assertPausedAtZero(SONG_B);

    // 2. the same song's title link from the home
    await page.goBack();
    await expect(page.locator("[data-jam-card]").first()).toBeVisible();
    await page.locator(`[data-jam-card="${SONG_B}"] h3 a`).click();
    await assertPausedAtZero(SONG_B);

    // 3. the song that WAS heard, opened again from the hero's "open" link: paused, and not counted again
    await page.goBack();
    await expect(page.locator(`[data-jam-hero="${SONG_A}"]`)).toBeVisible();
    await page.locator(`[data-jam-hero="${SONG_A}"] a:not([data-jam-play])`).first().click();
    await assertPausedAtZero(SONG_A, 1);

    // 4. pressing B's own play is what starts it, and counts one play
    await page.goBack();
    await page.locator(`[data-jam-card="${SONG_B}"] h3 a`).click();
    await assertPausedAtZero(SONG_B);
    await page.locator("[data-jam-toggle]").click();
    await expect(page.locator("[data-jam-toggle]")).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
    await expect.poll(() => calls.plays.filter((url) => url.includes(SONG_B)).length).toBe(1);
  });

  test("lays out one to nine parts as a mosaic that covers its box", async ({ page }) => {
    for (const count of [1, 2, 3, 6, 9]) {
      const many = song(SONG_A, "Muitos", Array.from({ length: count }, (_, i) => [["drums", "guitar", "vocals", "keys", "bass", "other"][i % 6]!, `P${i}`] as [string, string]), []);
      await page.unroute("**/api/public/jams/config");
      await mockApi(page, { songs: [many] });
      await page.route(/\/api\/public\/jams\/[0-9a-f-]{36}$/, async (route) =>
        route.fulfill({
          json: {
            song: many,
            tracks: many.parts.map((part, index) => track(`m-${index}`, part.instrument, part.person.name)),
            mediaExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
          },
        }),
      );
      await page.goto(`/jam/m/${SONG_A}`);
      await expect(page.locator("[data-jam-tile]")).toHaveCount(count);
      const boxes = await page.locator("[data-jam-tile]").evaluateAll((nodes) =>
        nodes.map((node) => {
          const rect = node.parentElement!.getBoundingClientRect();
          return { w: rect.width, h: rect.height };
        }),
      );
      for (const box of boxes) {
        expect(box.w).toBeGreaterThan(40);
        expect(box.h).toBeGreaterThan(40);
      }
      await page.unroute(/\/api\/public\/jams\/[0-9a-f-]{36}$/);
    }
  });

  test("a song of nine parts shows a frame of every video before the first press, and loads no audio", async ({ page }) => {
    const nine = song(
      SONG_A,
      "Nove",
      Array.from({ length: 9 }, (_, i) => [["drums", "guitar", "vocals", "keys", "bass", "other"][i % 6]!, `P${i}`] as [string, string]),
      [],
    );
    const calls = await mockApi(page, { songs: [nine] });
    await page.route(/\/api\/public\/jams\/[0-9a-f-]{36}$/, async (route) =>
      route.fulfill({
        json: {
          song: nine,
          tracks: nine.parts.map((part, index) => ({
            ...track(`n-${index}`, part.instrument, part.person.name),
            videoUrl: `/e2e-media/n-${index}.webm`,
            videoContentType: "video/webm",
          })),
          mediaExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      }),
    );
    await page.route("**/e2e-media/*.webm", serveStill);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-tile] video")).toHaveCount(9);
    // every tile has its picture (it used to be the first four, and the rest showed initials until play)
    await expect(page.locator('[data-jam-tile][data-jam-tile-shown="true"]')).toHaveCount(9, { timeout: 15_000 });
    const ready = await page.locator("[data-jam-tile] video").evaluateAll((nodes) => nodes.map((node) => (node as HTMLVideoElement).readyState));
    expect(ready.every((state) => state >= 2)).toBe(true);
    // and nothing played, so the audio was not fetched
    expect(calls.media).toHaveLength(0);
  });

  test("a song that is not public says so", async ({ page }) => {
    await mockApi(page);
    await page.goto("/jam/m/11111111-2222-4333-8444-555555555555");
    await expect(page.locator("[data-jam-message]")).toContainText("Essa jam não existe");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
  });
});

test.describe("what needs an account", () => {
  test("recording opens one sheet and carries the intent to the app", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.goto(`/jam/m/${SONG_A}`);
    await page.locator("[data-jam-record]").click();
    await expect(page.locator("dialog[open]")).toContainText("Pra gravar tu precisa de uma conta");
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("jam")).toBe(SONG_A);
    expect(url.searchParams.get("record")).toBe("1");
    expect(url.searchParams.get("instrument")).toBe("bass");
  });

  test("the dashed tile, like, report and start each ask, and 'not now' closes", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    for (const [selector, text] of [
      ["[data-jam-need-tile]", "gravar"],
      ["[data-jam-like]", "curtir"],
      ["[data-jam-report]", "denunciar"],
      ["[data-jam-report-part]", "denunciar"],
      ["[data-jam-start]", "começar uma jam"],
    ] as const) {
      // a part's report is in its lane's menu, not a flag on the row
      if (selector === "[data-jam-report-part]") {
        await page.locator("[data-jam-lane-menu]").first().click();
      }
      await page.locator(selector).first().click();
      await expect(page.locator("dialog[open]")).toContainText(new RegExp(text, "i"));
      await page.getByRole("button", { name: "Agora não" }).click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }
  });

  test("a lane's report is in its own menu, reachable by keyboard, and no row carries a flag", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    const lanes = page.locator("[data-jam-lane]");
    await expect(lanes).toHaveCount(2);
    // the menu is closed, so no report button is on the page at all
    await expect(page.locator("[data-jam-report-part]")).toHaveCount(0);
    const trigger = page.locator("[data-jam-lane-menu]").first();
    await expect(trigger).toHaveAttribute("aria-haspopup", "menu");
    await expect(trigger).toHaveAttribute("aria-expanded", "false");
    // Enter opens it and puts the keyboard on the item
    await trigger.focus();
    await page.keyboard.press("Enter");
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    const item = page.locator("[data-jam-report-part]");
    await expect(item).toHaveCount(1);
    await expect(item).toBeFocused();
    // Escape closes it and gives the keyboard back to the button
    await page.keyboard.press("Escape");
    await expect(item).toHaveCount(0);
    await expect(trigger).toBeFocused();
    // ArrowDown opens it too, a press outside closes it, and Enter on the item asks for an account
    await page.keyboard.press("ArrowDown");
    await expect(item).toBeFocused();
    await page.locator("h1").click();
    await expect(item).toHaveCount(0);
    await trigger.click();
    await page.keyboard.press("Enter");
    await expect(page.locator("dialog[open]")).toContainText(/denunciar/i);
    await page.getByRole("button", { name: "Agora não" }).click();
    // the sheet closes and the keyboard is back on the button that opened the menu
    await expect(trigger).toBeFocused();
  });

  test("a sheet closed with Escape opens again", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    for (let round = 0; round < 2; round += 1) {
      await page.locator("[data-jam-report]").click();
      await expect(page.locator("dialog[open]")).toContainText(/denunciar/i);
      await page.keyboard.press("Escape");
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }
    await page.locator("[data-jam-lane-menu]").first().click();
    await page.locator("[data-jam-report-part]").click();
    await expect(page.locator("dialog[open]")).toContainText(/denunciar/i);
  });

  test("a part with no video is the person alone at rest, and gets its level strip only while the song plays", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    const tiles = page.locator("[data-jam-tile]");
    await expect(tiles).toHaveCount(2);
    await expect(page.locator("[data-jam-tile] [data-jam-person]").first()).toBeVisible();
    await expect(page.locator("[data-jam-level]")).toHaveCount(0);
    const toggle = page.locator("[data-jam-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
    const strip = page.locator("[data-jam-level-live]").first();
    await expect(strip).toBeVisible();
    // drawn on its tile, under the person
    const tile = page.locator("[data-jam-tile]").first();
    const within = await tile.boundingBox();
    const stripBox = await strip.boundingBox();
    const person = await tile.locator("[data-jam-person]").boundingBox();
    expect(stripBox!.y).toBeGreaterThanOrEqual(person!.y + person!.height - 2);
    expect(stripBox!.y + stripBox!.height).toBeLessThanOrEqual(within!.y + within!.height);
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-playing", "false");
    await expect(page.locator("[data-jam-level]")).toHaveCount(0);
  });

  test("starting a jam carries ?jam=new", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.goto("/jam");
    await page.locator("[data-jam-start-strip]").click();
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    expect(new URL(page.url()).searchParams.get("jam")).toBe("new");
  });

  test("hands over where the visit came from: ref and utm_* from the arrival, kept across pages", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    // arrived on a clip's link, moved around the site: the sign-up button is pages away from the address
    await page.goto(`/jam/m/${SONG_A}?ref=clip-ana&utm_source=tiktok&utm_medium=social&gclid=zzz`);
    await page.locator("header a", { hasText: /Explorar/ }).first().click();
    await page.waitForURL(/\/jam$/);
    expect(new URL(page.url()).searchParams.has("ref")).toBe(false);
    await page.locator("[data-jam-start-strip]").click();
    await shot(page, "01-site-start-sheet-rights-line");
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("jam")).toBe("new");
    expect(url.searchParams.get("ref")).toBe("clip-ana");
    expect(url.searchParams.get("utm_source")).toBe("tiktok");
    expect(url.searchParams.get("utm_medium")).toBe("social");
    expect(url.searchParams.has("gclid")).toBe(false);
  });

  test("a visit with no ref says ref=jam, on the sheet and on the plain sign-in link", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("header a", { hasText: /Entrar/ })).toHaveAttribute("href", /[?&]ref=jam(&|$)/);
    await page.locator("[data-jam-record]").click();
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("ref")).toBe("jam");
    expect(url.searchParams.has("utm_source")).toBe(false);
  });

  test("the record sheet says to post only what is yours, with a link to the Terms; the like sheet does not", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    await page.locator("[data-jam-record]").click();
    const rights = page.locator("dialog[open] [data-jam-rights]");
    await expect(rights).toContainText("Só posta o que tu fez ou tem direito de usar.");
    await expect(rights.locator("a")).toHaveAttribute("href", /\/terms$/);
    await expect(rights.locator("a")).toHaveAttribute("target", "_blank");
    await shot(page, "02-site-record-sheet-rights-line");
    await page.getByRole("button", { name: "Agora não" }).click();
    await page.locator("[data-jam-like]").click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await expect(page.locator("dialog[open] [data-jam-rights]")).toHaveCount(0);
  });

  test("copyright is its own item, on the song and in a part's menu, and the intent carries the reason", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.goto(`/jam/m/${SONG_A}`);
    // the part's menu has two items and the arrows move between them
    await page.locator("[data-jam-lane-menu]").first().click();
    const report = page.locator("[data-jam-report-part]");
    const copyright = page.locator("[data-jam-copyright-part]");
    await expect(report).toBeFocused();
    await page.keyboard.press("ArrowDown");
    await expect(copyright).toBeFocused();
    await page.keyboard.press("ArrowUp");
    await expect(report).toBeFocused();
    await shot(page, "03-site-part-menu-copyright");
    await copyright.click();
    await expect(page.locator("dialog[open]")).toContainText("direitos autorais");
    await shot(page, "04-site-copyright-sheet");
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    const part = new URL(page.url()).searchParams;
    expect(part.get("jam")).toBe(SONG_A);
    expect(part.get("act")).toBe("report");
    expect(part.get("reason")).toBe("copyright");
    expect(part.get("track")).toMatch(/-t0$/); // the mock's id for the first lane
    // the song's own copyright button
    await page.goto(`/jam/m/${SONG_A}`);
    await page.locator("[data-jam-copyright]").click();
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    const song = new URL(page.url()).searchParams;
    expect(song.get("act")).toBe("report");
    expect(song.get("reason")).toBe("copyright");
    expect(song.has("track")).toBe(false);
  });

  test("shows the 'open in the app' state when the app sends somebody back", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}?from=app&record=1`);
    await expect(page.locator("[data-jam-from-app]")).toContainText("Tua conta tá pronta");
  });
});

/**
 * N4 of the launch user test, round 2: after signing up the public site still
 * treated the person as signed out. The app leaves a hint (`lib/jam-signed-in.ts`)
 * and the site reads it; these set it the three ways it can arrive.
 */
test.describe("a visitor the app says is signed in", () => {
  const signedIn = (name: string | null) => ({
    key: "pqp:jam-signed-in",
    raw: JSON.stringify({ value: name ? `1.${encodeURIComponent(name)}` : "1", at: Date.now() }),
  });

  async function appRoute(page: Page) {
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.route("**/app", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
  }

  test("sees their name, not Entrar, and record goes straight to the app with no sheet", async ({ page }) => {
    await mockApi(page);
    await appRoute(page);
    const hint = signedIn("Rafa");
    await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), hint);
    await page.goto(`/jam/m/${SONG_A}`);
    // The chip is the door to "Tuas músicas" in the app; the name is on its title (round 3, N-3).
    await expect(page.locator("[data-jam-account]")).toContainText("Tuas músicas");
    await expect(page.locator("[data-jam-account]")).toHaveAttribute("title", "Rafa · Tuas músicas");
    await expect(page.locator("[data-jam-account]")).toHaveAttribute("href", /\/app\?jam=mine/);
    await expect(page.locator("[data-jam-signin]")).toHaveCount(0);
    await page.locator("[data-jam-record]").click();
    await page.waitForURL(/\/app\?/);
    expect(await page.locator("dialog[open]").count()).toBe(0);
    const url = new URL(page.url());
    expect(url.searchParams.get("jam")).toBe(SONG_A);
    expect(url.searchParams.get("record")).toBe("1");
    expect(url.searchParams.get("instrument")).toBe("bass");
  });

  test("on a phone the door to the songs has a word beside the initial, and the header still fits (problem 7)", async ({ page }) => {
    await mockApi(page);
    await appRoute(page);
    const hint = signedIn("Rafa");
    await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), hint);
    for (const width of [390, 360]) {
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/jam");
      await expect(page.locator("[data-jam-account]")).toBeVisible();
      // the accessible name never depended on the picture
      await expect(page.locator("[data-jam-account]")).toHaveAttribute("aria-label", "Tuas músicas");
      await expect(page.locator("[data-jam-account-short]")).toBeVisible();
      await expect(page.locator("[data-jam-account-short]")).toHaveText("Músicas");
      expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
      // nothing in the header is cut off by the right edge
      const right = await page.locator("header button").last().evaluate((node) => node.getBoundingClientRect().right);
      expect(right).toBeLessThanOrEqual(width);
      const label = await page.locator("[data-jam-account-short]").evaluate((node) => ({ clipped: node.scrollWidth > node.clientWidth }));
      expect(label.clipped).toBe(false);
    }
    // below 360 px the word steps aside for the note, which the link's own name still labels
    await page.setViewportSize({ width: 320, height: 800 });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-account-short]")).toBeHidden();
    await expect(page.locator("[data-jam-account]")).toHaveAttribute("aria-label", "Tuas músicas");
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  });

  test("start, like and report go straight on as well", async ({ page }) => {
    await mockApi(page);
    await appRoute(page);
    const hint = signedIn("Rafa");
    await page.addInitScript(({ key, raw }) => localStorage.setItem(key, raw), hint);
    await page.goto(`/jam/m/${SONG_A}`);
    await page.locator("[data-jam-like]").click();
    await page.waitForURL(/\/app\?/);
    expect(new URL(page.url()).searchParams.get("act")).toBe("like");
    await page.goBack();
    await page.locator("[data-jam-start]").click();
    await page.waitForURL(/\/app\?/);
    expect(new URL(page.url()).searchParams.get("jam")).toBe("new");
  });

  test("the app's own link (?signed=1) is enough: remembered for the visit, off the address, no wall", async ({ page }) => {
    await mockApi(page);
    await appRoute(page);
    await page.goto(`/jam?signed=1&ref=clip`);
    await expect(page.locator("[data-jam-account]")).toBeVisible();
    expect(new URL(page.url()).searchParams.has("signed")).toBe(false);
    expect(new URL(page.url()).searchParams.get("ref")).toBe("clip");
    // the visit, not the browser: nothing was written where the next tab would find it
    expect(await page.evaluate(() => localStorage.getItem("pqp:jam-signed-in"))).toBeNull();
    // moving about the site keeps it
    await page.locator("[data-jam-card] a").first().click();
    await expect(page.locator("[data-jam-account]")).toBeVisible();
    await page.locator("[data-jam-record]").click();
    await page.waitForURL(/\/app\?/);
  });

  test("a sign-out elsewhere (the shared cookie goes) ends a visit that arrived with the marker", async ({ page }) => {
    await mockApi(page);
    await page.addInitScript(() => {
      if (!sessionStorage.getItem("__seeded")) {
        sessionStorage.setItem("__seeded", "1");
        document.cookie = "pqp_jam_in=1.Ana; Path=/";
      }
    });
    await page.goto("/jam?signed=1");
    await expect(page.locator("[data-jam-account]")).toBeVisible();
    await page.evaluate(() => {
      document.cookie = "pqp_jam_in=; Path=/; Max-Age=0";
      window.dispatchEvent(new Event("focus"));
    });
    await expect(page.locator("[data-jam-signin]")).toBeVisible();
    await expect(page.locator("[data-jam-account]")).toHaveCount(0);
  });

  test("a stranger with a junk hint is a stranger: Entrar and the sheet", async ({ page }) => {
    await mockApi(page);
    await page.addInitScript(() => {
      localStorage.setItem("pqp:jam-signed-in", "not json");
      document.cookie = "pqp_jam_in=yes; Path=/";
    });
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-signin]")).toBeVisible();
    await page.locator("[data-jam-record]").click();
    await expect(page.locator("dialog[open]")).toContainText("Pra gravar tu precisa de uma conta");
  });

  test("a cookie from the app (the hosted way) is read too", async ({ page }) => {
    await mockApi(page);
    await page.addInitScript(() => {
      document.cookie = "pqp_jam_in=1.Ana; Path=/";
    });
    await page.goto("/jam");
    // The name is on the chip's title, the words are the door's (round 3, N-3).
    await expect(page.locator("[data-jam-account]")).toHaveAttribute("title", /Ana/);
  });

  for (const width of [320, 390, 1280]) {
    test(`at ${width} px a signed-out visitor sees Entrar and a signed-in one sees the account, both inside the screen`, async ({ page }) => {
      await mockApi(page);
      await page.setViewportSize({ width, height: 800 });
      await page.goto("/jam");
      const entrar = page.locator("[data-jam-signin]");
      await expect(entrar).toBeVisible();
      const box = await entrar.boundingBox();
      expect(box!.x + box!.width).toBeLessThanOrEqual(width);
      await page.evaluate(() => {
        document.cookie = "pqp_jam_in=1.Rafa; Path=/";
        window.dispatchEvent(new Event("focus"));
      });
      const account = page.locator("[data-jam-account]");
      await expect(account).toBeVisible();
      await expect(page.locator("[data-jam-signin]")).toHaveCount(0);
      const accountBox = await account.boundingBox();
      expect(accountBox!.x + accountBox!.width).toBeLessThanOrEqual(width);
      expect(accountBox!.height).toBeGreaterThanOrEqual(44);
      const toggle = await page.locator("[data-jam-theme-toggle]").boundingBox();
      expect(toggle!.x + toggle!.width).toBeLessThanOrEqual(width);
    });
  }
});

test.describe("how it works and the featured slot", () => {
  const ORIGINAL = song("1d2c3b4a-5f6e-4d7c-8b9a-0a1b2c3d4e5f", "Cantiga nossa", [["vocals", "Lia"], ["keys", "Beto"]], []);
  const COVER = song("2e3d4c5b-6a7f-4e8d-9c0b-1b2c3d4e5f60", "Um hit", [["guitar", "Duda"], ["drums", "Ivo"]], ["bass"], { artist: "Banda Famosa", likes: 900 });

  test("the strip is under the hero, in three steps, and costs no media request", async ({ page }) => {
    await mockApi(page);
    const media: string[] = [];
    page.on("request", (request) => {
      if (/\.(wav|webm|mp4|flac|mp3|ogg)(\?|$)/.test(request.url()) || request.resourceType() === "media") media.push(request.url());
    });
    await page.goto("/jam");
    const how = page.locator("[data-jam-how]");
    await expect(how).toBeVisible();
    await expect(how.locator("[data-jam-how-step]")).toHaveCount(3);
    await expect(how).toContainText("Como funciona");
    await expect(how).toContainText("Ouve. Não precisa de conta.");
    await expect(how).toContainText("Grava a parte que falta, de fone, em cima da banda.");
    await expect(how).toContainText("Quem começou escolhe o que entra na mistura.");
    // under the hero, above the tabs
    const [hero, strip, tabs] = await Promise.all(
      ["[data-jam-hero]", "[data-jam-how]", '[data-jam-tab="top"]'].map(async (selector) => (await page.locator(selector).boundingBox())!.y),
    );
    expect(hero).toBeLessThan(strip!);
    expect(strip).toBeLessThan(tabs!);
    await shot(page, "02-home-how-it-works");
    await page.waitForTimeout(400);
    expect(media).toEqual([]);
  });

  for (const [width, height] of [[360, 740], [320, 640]] as const) {
    test(`on a ${width} px phone the strip comes before the hero, inside the first screen`, async ({ page }) => {
      await page.setViewportSize({ width, height });
      await mockApi(page);
      await page.goto("/jam");
      await expect(page.locator("[data-jam-hero]")).toBeVisible();
      const strip = (await page.locator("[data-jam-how]").boundingBox())!;
      const hero = (await page.locator("[data-jam-hero]").boundingBox())!;
      expect(strip.y + strip.height).toBeLessThanOrEqual(hero.y);
      expect(strip.y + strip.height).toBeLessThan(height);
      await shot(page, `05-home-${width}`);
    });
  }

  test("the strip is on the empty home too, and fits a 320 px screen", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await mockApi(page, { songs: [] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-empty]")).toBeVisible();
    await expect(page.locator("[data-jam-how-step]")).toHaveCount(3);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(0);
    await shot(page, "03-home-empty-320");
  });

  test("the featured slot is an original, not a more liked cover", async ({ page }) => {
    await mockApi(page, { songs: [COVER, ORIGINAL] });
    await page.goto("/jam");
    await expect(page.locator(`[data-jam-hero="${ORIGINAL.id}"]`)).toBeVisible();
    // the cover is still on the page, as a card
    await expect(page.locator(`[data-jam-card="${COVER.id}"]`)).toHaveCount(1);
    await expect(page.locator(`[data-jam-card="${ORIGINAL.id}"]`)).toHaveCount(0);
  });

  test("a rough upload does not take the front page: no hero, and the page leads with how it works and the list", async ({ page }) => {
    const rough = song("3f4e5d6c-7b8a-4c9d-8e0f-1a2b3c4d5e6f", "Primeira gravação", [["guitar", "Estranho"]], [], { coverUrl: null, plays: 0, likes: 0 });
    await mockApi(page, { songs: [rough, B] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await expect(page.locator("[data-jam-hero]")).toHaveCount(0);
    await expect(page.locator("[data-jam-lead]")).toHaveAttribute("data-jam-lead", "how");
    // The strip is the first thing under the tagline, on a wide window too, and the list follows it.
    const how = (await page.locator("[data-jam-how]").boundingBox())!;
    const grid = (await page.locator("[data-jam-grid]").boundingBox())!;
    expect(how.y).toBeLessThan(grid.y);
    await expect(page.locator("[data-jam-hero] , [data-jam-wants]")).toHaveCount(0);
  });

  test("the hero is the song that earned it, not the newest one: a cover, two people, and the most engagement among them", async ({ page }) => {
    const fresh = song("4a5b6c7d-8e9f-4a0b-9c1d-2e3f4a5b6c7d", "Acabou de sair", [["guitar", "Zé"], ["bass", "Nina"]], [], { plays: 2, likes: 0 });
    const loved = song("5b6c7d8e-9f0a-4b1c-8d2e-3f4a5b6c7d8e", "Todo mundo ouviu", [["guitar", "Zé"], ["keys", "Nina"]], [], { plays: 400, likes: 30 });
    await mockApi(page, { songs: [fresh, loved] });
    await page.goto("/jam");
    await expect(page.locator(`[data-jam-hero="${loved.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-jam-card="${fresh.id}"]`)).toHaveCount(1);
  });

  test("with only covers the featured slot is the first song", async ({ page }) => {
    await mockApi(page, { songs: [COVER, { ...ORIGINAL, artist: "Outra Banda" }] });
    await page.goto("/jam");
    await expect(page.locator(`[data-jam-hero="${COVER.id}"]`)).toBeVisible();
  });
});

test.describe("a song that takes no part", () => {
  test("a closed song offers no record button and no dashed tile, only to start your own", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_D}`);
    await expect(page.locator("[data-jam-toggle]")).toBeVisible();
    await expect(page.locator("[data-jam-record]")).toHaveCount(0);
    await expect(page.locator("[data-jam-need-tile]")).toHaveCount(0);
    await expect(page.locator("[data-jam-closed]")).toContainText("Essa música tá fechada: só quem começou grava nela.");
    // "Cada pessoa grava a parte dela em cima das outras" over a closed song contradicted itself
    await expect(page.locator("[data-jam-tagline]")).toHaveCount(0);
    await shot(page, "06-song-closed");
    await page.locator("[data-jam-closed-start]").click();
    await expect(page.locator("dialog[open]")).toContainText("Pra começar uma jam tu precisa de uma conta");
  });

  test("an open song keeps its record button and dashed tile, and no closed note", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-record]")).toBeVisible();
    await expect(page.locator("[data-jam-need-tile]")).toBeVisible();
    await expect(page.locator("[data-jam-closed]")).toHaveCount(0);
    await expect(page.locator("[data-jam-tagline]")).toContainText("Cada pessoa grava a parte dela");
  });

  test("a closed song on a phone: the note is in the page, nothing scrolls sideways", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 640 });
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_D}`);
    await expect(page.locator("[data-jam-closed]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    await shot(page, "07-song-closed-320");
  });

  // A closed original is the hero (it beats an open cover), so the home points at what still takes a part.
  const COVER_ASKS = song("2e3d4c5b-6a7f-4e8d-9c0b-1b2c3d4e5f60", "Um hit pedindo baixo", [["guitar", "Duda"]], ["bass"], {
    artist: "Banda Famosa",
    joinMode: "wanted",
  });

  test("a closed hero gets a 'these want a part' entry right under it, and its songs open", async ({ page }) => {
    await mockApi(page, { songs: [D, COVER_ASKS] });
    await page.goto("/jam");
    await expect(page.locator(`[data-jam-hero="${SONG_D}"]`)).toBeVisible();
    const wants = page.locator("[data-jam-wants]");
    await expect(wants).toContainText("Essas tão pedindo gente");
    await expect(wants.locator("[data-jam-wants-song]")).toHaveCount(1);
    await expect(wants).toContainText("Um hit pedindo baixo");
    await expect(wants).toContainText("Falta um baixo.");
    const hero = (await page.locator("[data-jam-hero]").boundingBox())!;
    const box = (await wants.boundingBox())!;
    expect(box.y).toBeGreaterThanOrEqual(hero.y + hero.height - 1);
    await shot(page, "08-home-closed-hero-wants");
    await wants.locator("[data-jam-wants-song]").click();
    await expect(page).toHaveURL(new RegExp(`/jam/m/${COVER_ASKS.id}$`));
  });

  test("'Ver todas' opens the Falta alguém tab", async ({ page }) => {
    await mockApi(page, { songs: [D, COVER_ASKS] });
    await page.goto("/jam");
    await page.locator("[data-jam-wants-all]").click();
    await expect(page.locator('[data-jam-tab="needs"]')).toHaveAttribute("aria-pressed", "true");
  });

  test("no entry when the hero takes a part, and none when no song does", async ({ page }) => {
    await mockApi(page, { songs: [A, B, C] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-hero]")).toBeVisible();
    await expect(page.locator("[data-jam-wants]")).toHaveCount(0);
    const closedToo = song("4a5b6c7d-8e9f-4a0b-8c1d-3e4f5a6b7c8d", "Outra fechada", [["keys", "Gui"]], [], { joinMode: "closed" });
    await page.unroute("**/api/public/jams?**");
    await page.route("**/api/public/jams?**", (route) => route.fulfill({ json: { songs: [D, closedToo], nextCursor: null } }));
    await page.goto("/jam");
    await expect(page.locator(`[data-jam-hero="${SONG_D}"]`)).toBeVisible();
    await expect(page.locator("[data-jam-wants]")).toHaveCount(0);
  });

  test("on a 360 px phone the entry fits and sits under the hero", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 740 });
    await mockApi(page, { songs: [D, COVER_ASKS] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-wants]")).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
    const link = (await page.locator("[data-jam-wants-song]").boundingBox())!;
    expect(link.height).toBeGreaterThanOrEqual(44);
    await page.locator("[data-jam-wants]").scrollIntoViewIfNeeded();
    await shot(page, "09-home-closed-hero-wants-360");
  });

  test("the featured slot passes over a closed original for one that takes a part", async ({ page }) => {
    const open = song("1d2c3b4a-5f6e-4d7c-8b9a-0a1b2c3d4e5f", "Cantiga aberta", [["vocals", "Lia"], ["keys", "Beto"]], []);
    await mockApi(page, { songs: [D, open] });
    await page.goto("/jam");
    await expect(page.locator(`[data-jam-hero="${open.id}"]`)).toBeVisible();
    await expect(page.locator(`[data-jam-card="${SONG_D}"]`)).toHaveCount(1);
  });
});

test.describe("shared links carry ref=share", () => {
  /** A share sheet that records what it was handed, or none at all (the copy path). */
  async function withShare(page: Page, mode: "sheet" | "copy") {
    await page.addInitScript((m) => {
      const w = window as unknown as { __shared: unknown[]; __copied: string[] };
      w.__shared = [];
      w.__copied = [];
      Object.defineProperty(navigator, "share", {
        configurable: true,
        value: m === "sheet" ? async (data: unknown) => void w.__shared.push(data) : undefined,
      });
      Object.defineProperty(navigator, "clipboard", {
        configurable: true,
        value: { writeText: async (text: string) => void w.__copied.push(text) },
      });
    }, mode);
  }
  const read = <T,>(page: Page, key: "__shared" | "__copied") => page.evaluate((k) => (window as never as Record<string, T[]>)[k]!, key);

  test("the share sheet is handed the address with ref=share", async ({ page }) => {
    await mockApi(page);
    await withShare(page, "sheet");
    await page.goto(`/jam/m/${SONG_A}`);
    await page.locator("[data-jam-share]").click();
    await expect.poll(async () => (await read<{ url: string }>(page, "__shared")).length).toBe(1);
    const [data] = await read<{ url: string }>(page, "__shared");
    const url = new URL(data!.url);
    expect(url.pathname).toBe(`/jam/m/${SONG_A}`);
    expect(url.searchParams.get("ref")).toBe("share");
  });

  test("the copied link has ref=share and the toast says it was copied", async ({ page }) => {
    await mockApi(page);
    await withShare(page, "copy");
    await page.goto(`/jam/m/${SONG_A}`);
    await page.locator("[data-jam-share]").click();
    // No share sheet here: a small card with the link, copy, and the three places to send it to.
    await expect(page.locator("[data-jam-share-menu]")).toBeVisible();
    await expect(page.locator("[data-jam-share-network]")).toHaveCount(3);
    await page.locator("[data-jam-share-copy]").click();
    await expect(page.getByText("Link copiado").first()).toBeVisible();
    const [copied] = await read<string>(page, "__copied");
    expect(new URL(copied!).searchParams.get("ref")).toBe("share");
    await shot(page, "04-song-share-copied");
  });

  test("a page opened with a ref keeps it on the link it shares", async ({ page }) => {
    await mockApi(page);
    await withShare(page, "copy");
    await page.goto(`/jam/m/${SONG_A}?ref=clip-ana`);
    await page.locator("[data-jam-share]").click();
    await page.locator("[data-jam-share-copy]").click();
    await expect.poll(async () => (await read<string>(page, "__copied")).length).toBe(1);
    const [copied] = await read<string>(page, "__copied");
    expect(new URL(copied!).searchParams.get("ref")).toBe("clip-ana");
  });

  test("arriving on a shared link and pressing Gravar hands ref=share to the app", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.goto(`/jam/m/${SONG_A}?ref=share`);
    await page.locator("[data-jam-record]").click();
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    const url = new URL(page.url());
    expect(url.searchParams.get("jam")).toBe(SONG_A);
    expect(url.searchParams.get("record")).toBe("1");
    expect(url.searchParams.get("ref")).toBe("share");
  });
});

test.describe("when the flag is off", () => {
  test("is a small page that asks nothing but the config, and is kept out of search", async ({ page }) => {
    const calls = await mockApi(page, { enabled: false });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-soon]")).toBeVisible();
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex, nofollow");
    await page.waitForTimeout(400);
    // One read (two under the dev server's strict mode).
    expect(calls.config).toBeLessThanOrEqual(2);
    expect(calls.list).toEqual([]);
    expect(calls.detail).toEqual([]);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-soon]")).toBeVisible();
    expect(calls.detail).toEqual([]);
  });

  /** The flag is flipped on while a tab is open on the holding page (the answer is cached for 60 s on purpose). */
  async function flippable(page: Page) {
    const state = { enabled: false, asked: 0, fresh: 0 };
    await mockApi(page, { enabled: false });
    await page.unroute("**/api/public/jams/config");
    await page.route("**/api/public/jams/config", async (route) => {
      state.asked += 1;
      await route.fulfill({ json: { enabled: state.enabled }, headers: { "cache-control": "public, max-age=60" } });
    });
    return state;
  }

  test("a tab left on the holding page opens by itself when it gets focus after the flag went on", async ({ page }) => {
    const state = await flippable(page);
    await page.goto("/jam");
    await expect(page.locator("[data-jam-soon]")).toBeVisible();
    const before = state.asked;
    state.enabled = true;
    // The tab comes back into view (a real switch fires both events).
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("[data-jam-soon]")).toHaveCount(0);
    await expect(page.locator("[data-jam-card]").first()).toBeVisible();
    expect(state.asked).toBeGreaterThan(before);
  });

  test("with no focus at all it asks again after the answer's own cache window, and not before", async ({ page }) => {
    await page.clock.install();
    const state = await flippable(page);
    await page.goto("/jam");
    await expect(page.locator("[data-jam-soon]")).toBeVisible();
    const first = state.asked;
    state.enabled = true;
    await page.clock.fastForward(30_000);
    expect(state.asked).toBe(first);
    await page.clock.fastForward(36_000);
    await expect(page.locator("[data-jam-card]").first()).toBeVisible();
    expect(state.asked).toBeGreaterThan(first);
  });

  test("a site that is on never goes back to the holding page under somebody who is listening", async ({ page }) => {
    await page.clock.install();
    const state = await flippable(page);
    state.enabled = true;
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]").first()).toBeVisible();
    const asked = state.asked;
    state.enabled = false;
    await page.clock.fastForward(200_000);
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.locator("[data-jam-soon]")).toHaveCount(0);
    expect(state.asked).toBe(asked);
  });
});

test.describe("on a phone", () => {
  test.use({ viewport: { width: 390, height: 844 } });
  test("nothing scrolls sideways", async ({ page }) => {
    await mockApi(page);
    for (const path of ["/jam", `/jam/m/${SONG_A}`]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      await page.waitForTimeout(300);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
    }
  });

  test("the header fits from 320 to 768 px, with the theme toggle inside the screen", async ({ page }) => {
    await mockApi(page);
    for (const width of [320, 360, 390, 768]) {
      await page.setViewportSize({ width, height: 800 });
      for (const path of ["/jam", `/jam/m/${SONG_A}`]) {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
        expect(overflow, `${width} ${path}`).toBeLessThanOrEqual(0);
        const toggle = await page.locator("[data-jam-theme-toggle]").boundingBox();
        expect(toggle!.x + toggle!.width, `${width} ${path}`).toBeLessThanOrEqual(width);
      }
    }
  });

  test("the home does not jump when the config answer lands late (the booting frame has the home's height)", async ({ page }) => {
    await mockApi(page);
    await page.route("**/api/public/jams/config", async (route) => {
      await new Promise((resolve) => setTimeout(resolve, 600));
      await route.fulfill({ json: { enabled: true } });
    });
    await page.addInitScript(() => {
      (window as unknown as { __cls: number }).__cls = 0;
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries() as unknown as Array<{ value: number; hadRecentInput: boolean }>) {
          if (!entry.hadRecentInput) (window as unknown as { __cls: number }).__cls += entry.value;
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-grid]")).toBeVisible();
    await page.waitForTimeout(500);
    const cls = await page.evaluate(() => (window as unknown as { __cls: number }).__cls);
    // 0.195 with the old short placeholder (the footer moved a whole screen); well under the 0.1 "good" line now
    expect(cls).toBeLessThan(0.05);
  });

  test("says what this is in the first screen, on the home and on a song", async ({ page }) => {
    await mockApi(page);
    for (const path of ["/jam", `/jam/m/${SONG_A}`]) {
      await page.goto(path);
      const line = page.locator("[data-jam-tagline]");
      await expect(line).toBeVisible();
      const box = await line.boundingBox();
      expect(box!.y + box!.height, path).toBeLessThan(844);
    }
  });

  test("play, share and record are all on the first screen of a song, on a short phone too", async ({ page }) => {
    await mockApi(page);
    for (const height of [844, 667]) {
      await page.setViewportSize({ width: 390, height });
      await page.goto(`/jam/m/${SONG_A}`);
      for (const selector of ["[data-jam-toggle]", "[data-jam-share]", "[data-jam-record]"]) {
        const box = await page.locator(selector).boundingBox();
        expect(box, `${selector} at ${height}`).not.toBeNull();
        expect(box!.y + box!.height, `${selector} at ${height}`).toBeLessThanOrEqual(height);
      }
    }
  });

  test("every control on the song page is at least 44 px", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-toggle]")).toBeVisible();
    const small = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>("button, a[href], input")]
        .filter((node) => !node.closest("dialog") && !node.matches(".sr-only") && node.getBoundingClientRect().width > 0)
        .map((node) => ({ node: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? node.tagName, box: node.getBoundingClientRect() }))
        .filter(({ box }) => box.width < 44 || box.height < 44)
        .map(({ node, box }) => `${node} ${Math.round(box.width)}x${Math.round(box.height)}`),
    );
    expect(small).toEqual([]);
  });

  test("the like button's name carries the count", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.getByRole("button", { name: "Curtir, 48 curtidas" })).toBeVisible();
  });

  test("the seek bar says the time it is at", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    const seek = page.locator("[data-jam-seek]");
    await seek.focus();
    await seek.press("End");
    await expect(seek).toHaveAttribute("aria-valuetext", "0:06 / 0:06");
    await seek.press("Home");
    await expect(seek).toHaveAttribute("aria-valuetext", "0:00 / 0:06");
  });
});

test.describe("the host mount", () => {
  test("jam.localhost serves the home at / and a song at /m/<id>", async ({ page, baseURL }) => {
    await mockApi(page);
    const host = new URL(baseURL!);
    const jam = `http://jam.localhost:${host.port}`;
    await page.goto(`${jam}/`);
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await page.locator("[data-jam-hero]").getByRole("link", { name: "Abrir sem tocar" }).click();
    await expect(page).toHaveURL(`${jam}/m/${SONG_A}`);
    await expect(page.locator("[data-jam-song]")).toBeVisible();
  });
});

test.describe("the language", () => {
  // The Vite page has no edge in front of it, so this is the browser's half: `navigator.languages`,
  // the saved choice and `?lang=`. The edge's half (`pqp:locale`, `<html lang>`) is `jam-edge.test.ts`.
  test.describe("of a Spanish browser", () => {
    test.use({ locale: "es-MX" });

    test("is Spanish on the home and on a song, with <html lang> to match", async ({ page }) => {
      await mockApi(page);
      for (const path of ["/jam", `/jam/m/${SONG_A}`]) {
        await page.goto(path);
        await expect(page.locator("main")).toBeVisible();
        await expect(page.getByRole("link", { name: "Conocer pqp" })).toBeVisible();
        await expect(page.locator("html")).toHaveAttribute("lang", "es");
      }
      await page.goto("/jam");
      await expect(page.locator("[data-jam-tagline]")).toHaveText("Canciones hechas en conjunto, una parte grabada a la vez.");
    });

    test("the footer switch goes to Portuguese and English, keeps the page, and the choice survives moving about", async ({ page }) => {
      await mockApi(page);
      await page.goto(`/jam/m/${SONG_A}?ref=clip-ana`);
      const group = page.getByRole("group", { name: "Idioma" });
      await expect(group.getByRole("button", { name: "Español" })).toHaveAttribute("aria-pressed", "true");
      await expect(group.getByRole("button", { name: "Português" })).toHaveAttribute("aria-pressed", "false");

      await group.getByRole("button", { name: "Português" }).click();
      await expect(page).toHaveURL(new RegExp(`/jam/m/${SONG_A}\\?ref=clip-ana$`));
      await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");
      await expect(page.getByRole("link", { name: "Conhecer o pqp" })).toBeVisible();
      expect(await page.evaluate(() => localStorage.getItem("pqp:locale"))).toBe("pt-BR");

      // Move within the site (pushState) and the language stays.
      await page.getByRole("link", { name: "pqp jam, início" }).click();
      await expect(page).toHaveURL(/\/jam$/);
      await expect(page.locator("[data-jam-tagline]")).toHaveText("Músicas feitas em conjunto, uma parte gravada por vez.");
      // A fresh load, with the browser still Spanish, stays Portuguese: the choice outranks it.
      await page.goto("/jam");
      await expect(page.locator("html")).toHaveAttribute("lang", "pt-BR");

      await page.getByRole("group", { name: "Idioma" }).getByRole("button", { name: "English" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("[data-jam-tagline]")).toHaveText("Songs built together, one recorded part at a time.");
    });

    test("the switch is reachable and usable from the keyboard", async ({ page }) => {
      await mockApi(page);
      await page.goto("/jam");
      await page.getByRole("button", { name: "Português" }).focus();
      await page.keyboard.press("Tab");
      await expect(page.getByRole("button", { name: "English" })).toBeFocused();
      await page.keyboard.press("Enter");
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
    });

    test("a language asked for rides into the app, and one only implied by the browser does not", async ({ page }) => {
      await mockApi(page);
      await page.goto("/jam");
      await expect(page.locator("header").getByRole("link", { name: "Entrar" })).toHaveAttribute("href", "/app?ref=jam");
      await page.getByRole("button", { name: "English" }).click();
      await expect(page.locator("html")).toHaveAttribute("lang", "en");
      await expect(page.locator("header").getByRole("link", { name: "Sign in" })).toHaveAttribute("href", "/app?ref=jam&lang=en");
      await page.locator("[data-jam-start]").click();
      await page.getByRole("button", { name: "Create an account and start" }).click();
      await expect(page).toHaveURL(/\/app\?jam=new&ref=jam&lang=en$/);
    });
  });

  test("?lang= beats a Portuguese browser, and the switch drops it once the choice is stored", async ({ page }) => {
    await mockApi(page);
    await page.goto("/jam?lang=es");
    await expect(page.locator("html")).toHaveAttribute("lang", "es");
    await page.getByRole("button", { name: "English" }).click();
    await expect(page).toHaveURL(/\/jam$/);
    await expect(page.locator("html")).toHaveAttribute("lang", "en");
  });

  test("the switch fits a 320 px footer and stays 44 px tall", async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 700 });
    await mockApi(page);
    for (const path of ["/jam", `/jam/m/${SONG_A}`]) {
      await page.goto(path);
      const group = page.locator("[data-jam-language]");
      await group.scrollIntoViewIfNeeded();
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow, path).toBeLessThanOrEqual(0);
      for (const button of await group.getByRole("button").all()) {
        const box = await button.boundingBox();
        expect(box!.height, path).toBeGreaterThanOrEqual(44);
        expect(box!.x + box!.width, path).toBeLessThanOrEqual(320);
        expect(box!.x, path).toBeGreaterThanOrEqual(0);
      }
      await shot(page, `language-320-${path.includes("/m/") ? "song" : "home"}`);
    }
  });
});

test.describe("round 3 minors", () => {
  test("every instrument the song asks for is a choice on the first screen, and each carries its own to the app (n-8)", async ({ page }) => {
    await mockApi(page);
    await page.route("**/app?*", (route) => route.fulfill({ body: "<html><body>app</body></html>", contentType: "text/html" }));
    await page.goto(`/jam/m/${SONG_E}`);
    await expect(page.locator("[data-jam-record]")).toContainText("Gravar a bateria");
    await expect(page.locator("[data-jam-record-alt]")).toHaveCount(2);
    await expect(page.locator("[data-jam-record-alt=vocals]")).toBeVisible();
    // three dashed tiles on the stage, one per instrument asked for
    await expect(page.locator("[data-jam-need-tile]")).toHaveCount(3);
    await shot(page, "n8-several-needs");
    await page.locator("[data-jam-record-alt=vocals]").click();
    await expect(page.locator("dialog[open]")).toContainText("Pra gravar tu precisa de uma conta");
    await page.locator("[data-jam-ask-go]").click();
    await page.waitForURL(/\/app\?/);
    expect(new URL(page.url()).searchParams.get("instrument")).toBe("vocals");
  });

  test("a song with one need still has one record button and no list of others", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}`);
    await expect(page.locator("[data-jam-record]")).toHaveCount(1);
    await expect(page.locator("[data-jam-record-others]")).toHaveCount(0);
  });

  test("the song pauses under the account sheet and stays paused when it closes (round 1 m9)", async ({ page }) => {
    await mockApi(page);
    const warmed = page.waitForResponse((response) => /jam-session/.test(response.url()), { timeout: 20_000 });
    await page.goto(`/jam/m/${SONG_A}`);
    await warmed;
    await page.waitForLoadState("networkidle");
    const toggle = page.locator("[data-jam-toggle]");
    await toggle.click();
    await expect(toggle).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
    await page.locator("[data-jam-record]").click();
    await expect(page.locator("dialog[open]")).toBeVisible();
    await expect(toggle).toHaveAttribute("data-playing", "false");
    await page.keyboard.press("Escape");
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    // closing the sheet starts nothing: playing is a press
    await page.waitForTimeout(400);
    await expect(toggle).toHaveAttribute("data-playing", "false");
  });

  test("the hero's play says where it goes, and a card's has a tooltip (m5)", async ({ page }) => {
    await mockApi(page);
    await page.goto("/jam");
    await expect(page.locator("[data-jam-hero] [data-jam-play-label]")).toContainText("Ouvir na página da música");
    await expect(page.locator("[data-jam-card] [data-jam-play]").first()).toHaveAttribute("title", /Abre a página da música/);
  });
});

// A real local API, seeded by tools/jam-site-seed. Skipped without JAM_SITE_API.
const LIVE_API = process.env.JAM_SITE_API;
const LIVE_IDS = process.env.JAM_SITE_IDS;
test.describe("against a seeded API", () => {
  test.skip(!LIVE_API || !LIVE_IDS, "set JAM_SITE_API and JAM_SITE_IDS to run");
  const ids = () => JSON.parse(readFileSync(LIVE_IDS!, "utf8")) as Record<string, { id: string }>;

  test("a part with no consent, a take left out of the mix and an unpublished song are not there", async ({ page }) => {
    await page.route("**/api/**", (route) => route.continue({ url: route.request().url().replace(/^https?:\/\/[^/]+/, LIVE_API!) }));
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]").first()).toBeVisible();
    await expect(page.getByText("Despublicada")).toHaveCount(0);
    await page.goto(`/jam/m/${ids().minuano!.id}`);
    // Four public parts (a fifth withdrew its consent) and the dashed square.
    await expect(page.locator("[data-jam-tile]")).toHaveCount(4);
    await expect(page.locator("[data-jam-lane]")).toHaveCount(4);
    await page.goto(`/jam/m/${ids().onibus!.id}`);
    await expect(page.locator("[data-jam-tile]")).toHaveCount(1);
    await page.goto(`/jam/m/${ids().despublicada!.id}`);
    await expect(page.locator("[data-jam-message]")).toContainText("não existe");
  });
});
