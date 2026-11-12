import { readFileSync } from "node:fs";
import { expect, test, type Page, type Route } from "@playwright/test";
import { encodeWav } from "../../src/lib/jam/pcm";

/**
 * The public jam site, end to end in a real browser. The API is mocked, so what
 * is proved is the client: no media before a play, the song really plays on the
 * engine's clock, the mosaic and its spotlight, the sign-up sheet and the intent
 * it carries to the app, the disabled page, and 390 px.
 */

const SONG_A = "0b8f2c1e-4d5a-4e6f-8a7b-1c2d3e4f5a6b";
const SONG_B = "7a1d3b2c-9e8f-4a5b-8c6d-0e1f2a3b4c5d";
const SONG_C = "5c4b3a29-1807-4f6e-9d5c-3b2a19087f6e";

const person = (name: string, handle: string | null = null) => ({ name, handle, avatarUrl: null });

function song(id: string, title: string, parts: Array<[string, string]>, needs: string[], extra: object = {}) {
  return {
    id,
    title,
    artist: null,
    coverUrl: null,
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

const WAV = (() => {
  const sr = 44100;
  const samples = new Float32Array(sr * 6);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / sr);
  return Buffer.from(encodeWav([samples], sr));
})();

interface Calls {
  list: URL[];
  detail: string[];
  media: string[];
  plays: string[];
  config: number;
}

async function mockApi(page: Page, options: { enabled?: boolean; songs?: object[]; page2?: object[] } = {}): Promise<Calls> {
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
    if (url.searchParams.get("cursor") === "c2") {
      return route.fulfill({ json: { songs: options.page2 ?? [], nextCursor: null } });
    }
    return route.fulfill({ json: { songs, nextCursor: options.page2 ? "c2" : null } });
  });
  await page.route(/\/api\/public\/jams\/[0-9a-f-]{36}$/, async (route: Route) => {
    const id = route.request().url().split("/").pop()!;
    calls.detail.push(id);
    const found = [A, B, C].find((candidate) => candidate.id === id);
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
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    await expect(page.locator("[data-jam-hero]")).toBeVisible();
    // The hero is the first song with a part; the dashed square says what is missing.
    await expect(page.locator("[data-jam-hero]")).toContainText("Falta um baixo.");
    await page.waitForTimeout(500);
    expect(mediaRequests).toEqual([]);
    expect(calls.media).toEqual([]);
    // Likes show only above one: the song with 48 shows them, the two with 1 do not.
    await expect(page.locator('[data-jam-card] [aria-label*="curtida"]')).toHaveCount(1);
    await expect(page.locator('[data-jam-card] [aria-label*="curtida"]')).toContainText("48");
  });

  test("the tabs ask the server for the sort and filter the page for the rest", async ({ page }) => {
    const calls = await mockApi(page);
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
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
    await expect(page.locator("[data-jam-card]")).toHaveCount(4);
    expect(calls.list.some((url) => url.searchParams.get("cursor") === "c2")).toBe(true);
    await expect(page.locator("[data-jam-more]")).toHaveCount(0);
  });

  test("has a button that does the same where the page cannot watch the scroll", async ({ page }) => {
    await page.addInitScript(() => {
      // @ts-expect-error a browser without the observer
      delete window.IntersectionObserver;
    });
    const second = song("1d2c3b4a-5f6e-4d7c-8b9a-0a1b2c3d4e5f", "Segunda página", [["vocals", "Lia"]], []);
    const calls = await mockApi(page, { page2: [second] });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    await page.locator("[data-jam-more]").click();
    await expect(page.locator("[data-jam-card]")).toHaveCount(4);
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
      await page.locator(selector).first().click();
      await expect(page.locator("dialog[open]")).toContainText(new RegExp(text, "i"));
      await page.getByRole("button", { name: "Agora não" }).click();
      await expect(page.locator("dialog[open]")).toHaveCount(0);
    }
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

  test("shows the 'open in the app' state when the app sends somebody back", async ({ page }) => {
    await mockApi(page);
    await page.goto(`/jam/m/${SONG_A}?from=app&record=1`);
    await expect(page.locator("[data-jam-from-app]")).toContainText("Tua conta tá pronta");
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
});

test.describe("the host mount", () => {
  test("jam.localhost serves the home at / and a song at /m/<id>", async ({ page, baseURL }) => {
    await mockApi(page);
    const host = new URL(baseURL!);
    const jam = `http://jam.localhost:${host.port}`;
    await page.goto(`${jam}/`);
    await expect(page.locator("[data-jam-card]")).toHaveCount(3);
    await page.locator("[data-jam-card]").first().getByRole("link", { name: "Minuano", exact: true }).click();
    await expect(page).toHaveURL(`${jam}/m/${SONG_A}`);
    await expect(page.locator("[data-jam-song]")).toBeVisible();
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
