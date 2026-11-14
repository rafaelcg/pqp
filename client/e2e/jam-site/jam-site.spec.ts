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

/** One second of a 96x54 test pattern (VP8), so a tile has a real frame to show without a media server. */
const STILL_WEBM = Buffer.from(
  "GkXfo59ChoEBQveBAULygQRC84EIQoKEd2VibUKHgQJChYECGFOAZwEAAAAAAAsiEU2bdLpNu4tTq4QVSalmU6yBoU27i1OrhBZUrmtTrIHYTbuMU6uEElTDZ1OsggElTbuMU6uEHFO7a1OsggsM7AEAAAAAAABZAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAVSalmsirXsYMPQkBNgI1MYXZmNjIuMTIuMTAwV0GNTGF2ZjYyLjEyLjEwMESJiECPQAAAAAAAFlSua8iuAQAAAAAAAD/XgQFzxYhx0UsHgF1loZyBACK1nIN1bmSIgQCGhVZfVlA4g4EBI+ODhA7msoDgkLCBYLqBNpqBAlWwhFW5gQESVMNn/HNzoGPAgGfImkWjh0VOQ09ERVJEh41MYXZmNjIuMTIuMTAwc3PWY8CLY8WIcdFLB4BdZaFnyKFFo4dFTkNPREVSRIeUTGF2YzYyLjI4LjEwMCBsaWJ2cHhnyKFFo4hEVVJBVElPTkSHkzAwOjAwOjAxLjAwMDAwMDAwMAAfQ7Z1SWDngQCjRmWBAACAUCYAnQEqYAA2AAAHCIWFiIWEiAICAnW7aAJ+PfhF+mPwE0Z+GfaD9Zv6lrgPnNcLfxj8Jv8171f8h+SXyB8wH+1fxz+Z/ix2gfMD/Hv5Z/X/8B76v8z/kHsB/7XqA/0z+UerJ/P/4D7gP7AewD+i/pF/5H/DfAN+v390/0vwHfyv+o/P/pgP8i7Ov6X+GvPr+vXFteM+tH3H8n9sB9QP9C/JH8oM47+G/0f8itSA/I74J4gH+Uf4D8gP6B8L3859mfsF+Pv9J/MPwB+wH+F/yX+9f0j9mf7N/3+4B9gH9Guyjg/+D9DqdrO+JWv9ToowYYZBHLvD6L8MAnIFwxVu42lLmDAcLYM4p32qGd6hatmb3KrWD79In1XDJazXZ+GMi4gH/sEoxe2OIPfksyUpJnwZuYDBn4fZ1OExAP7/xbYblgyAR3D+Cvl3hl7FRUJv//EV92ZHmrJst8Dx5wSd8Tqf+g8wYXP9xjZ4TZMEsaYr6auRDU50xOB9QboP4TKzHq1/gCd0yYF2oTeBc9LbZi/Lt8i74mrvOoa3famQDxf/tc4oGVwWxaVobt3l7jQiGgY//5dsolyUFMmPftQ/JkQMjLePuk83XMjKjv9TlpDBt7p1h8ZdSyXMsH6DxUsld+vtjvv/+ebOT2d2/RnrqWR86IrdlPMBLbb7MfRFipIOFXVO8CmPM6RqFX71bB6RUznVOuCz5X3naYHz5m0ukhMOBqv/+94XLNdl/gD+ysUDS8iP//mgStuqZHRJprUH96OCzWaYNhHvU/H9QYXVb9dCVPM0LQ6gQPE/qI1vJ/Z0NFoR1ye1YXFq+dMoYJgffPeMAvuw9J1HRbOkEDhwzDe0eL8KJzBoEvuAYf3JV4knlgPwhuAA/ksKT5mE8vdP4WIOzOfT5iPP/M681ZfMBABDoCnAA2AAR7iAAEa9oDiPuvQ26236O747lZt9+AiTwQ1sft+W+gOJ+af20Emjf6aI+/bdL/olCuQ2EQ/DzF9JCyOVecl+XOyGj9svikXVVRBIMAMYQ2lzkAauCwB5YeKA5vkg4XVRynz5nxmo4EtuniGlR0SaUhmkcSU+SPkQAQRMc7cAhnFuN3JPFvAHq6QDZVsIIIV0BOox8k0sMn3/lL4HnnRxcXnRxcX3b9s96v1RsKwt8SaUkJ2iLsbQ/+a3jDld6vUVu+A0sYnI1Le34eRx3zEFdpQQo0Vd2hnnaCXHclqG2QPeaOfsB3o3qx/9FXLfYSpib/CuO62VWUK5fr+PbQuCJm/r6IJk2PtDg9OrOFBX3yBM/RZbSYAgEBvDP6O9KU5iAaNCxcABDBg5dOQTEIOh3FevIugAB+39YXRNvBh8h+3LvN+ZMOIA6BnDlY312uTcbmQ1hqtWQkoCTulR9ev/zoBtM3H6kRJiprClMAAMq7XH+jwKNd6ZGyQCZ0JQRzOdgPKiwgn4beNHZ1MDzRR1k8bhZMPXJhNPXJhNPXJhNPF7/f2CcHQZv3RaQWGb7a8nBDoJqliVkQcue3Dvs/qmutVKV28MttB6kO0SPOxeTDa8AHCnYOwXIpjSgVlvE+XzHU883zMw9P8TP6wTpi34X7yXCin/Rr9JK5tDKce4LGM572ZayWL2xw1ZA1j7NMtN3TKrQOkSOj9ySdY4ltIUL8BaKLcAwdvcNXLOG9oi58OKo2/iquTO2W8p+6ppp4T2JnVh06SoEnIA7AFPjjCWdM/7+yNWfKnnlHn+0il2gMG4PiC//80yq0kJzgu17fokBjcBwNU+2Wp97KkQoou96QBlsmc4qAWLaYKdP84SVvodTnnzpcO4gEbSyXGbqkmdc7uQaIgZtWQ0MgJb6Tn9mlKiY12pBe6QD7LtJqV6QT40CqTc36xchkKh+qDZk/Je4QNMJDUZ+2QkSegG6m5YxnsTUYaCT4QJsEmev+1NXQNpiU2eWTCWmu2IHg5uAn6tu910s4N9FDu0p1ahoD++ex5c3Xyajy1WiXRMIzEYVfop401yFF5YAGeSqinnVyoDJj/wa90as3M3xr1HKROd2Bfxgu39vLIMkMbNoQ7vM3WTpVzf9i/P7KyK3zltPSwNYqEyXC2Uf29w9292VfhspNkNCjH+0QJg5uAGd2RxQAoiFG6sNkVqNs2XdmajQAmA88tmeoOGt290CDaqRajLcTHs8fDYYKCAAKNA2YEA+gCRBAAMEFwAHMREBBCVYCv+Z5v+CCAM/MAzrA2bYa1/xMOrR5wTDSAWsSi+uIZkgymMmcE7nC4AAALklOAAAADr9wd34a6CzmDKdZwAADegAAPdvQveYH18sYAAAAAAAAAAAA8oCa+KYAeJ8+MvOAAIZKIE8Z2WwbCX4xJ6YAZV1IAF7ubMA/0nUcDF4Kd2V4h5D+dH/60+0nB4AAAAAAAAAAACR8wr0xlqkBxD6ngAD0FBNZ+75647y3zPAAAAAAAAAAAPl1T/kKQB7t7LLaAACHWOAACjQOuBAfQAkQQAChBUABgEl/BsgJnbrIbEOA0TAeDaKKuGyU5dJ/IX98YXC7AAFN+OHHmirMBUNGWcAAAAK+fHAAAAdotUKpd2GNCr9KBicwfcAAV7LdsYAAHOaphr8H2DKDsJWihIzkVGeuY8cdrKBxQnkPJqgAA9BnKinADvqAAGidDSNQDHv/mIKY4AAADpsr4wAAMYDgbX/03Hu7sOo//7s9uOG0AAAAAAAAAABG3v0AYU5A3wA4qmlz50VAgAPQZyoo5n+tgE85dWLlO1s8EoJ2kQjJw3M0yBfoAAD3b3v6C7uaIgAGFivUsAo0EogQLuAHEFAAoQTAAYAWITGaS//CQGEYzKKiI1DdpxHt+RaDZLOyM2iDbXcS+Dl4iEukAAAAAAAAAAAAFiJyAAyEahFRp70g0AAAR9N7/AAAFY/RCyTUAAAAAAAAAyuAAMr1EDlyI2cAADIDtTAqOgIwAA0vTPvHxc8BQAAAAAAAAAAb/xE0PlJDGMGlciO9RQgAAHLiwj+P+qON+OHWGSACsq2FS6WvES8Pg6AAAAAAAAAAAAAAESfcjbc/wkAIOAqB6gQQAABjAq7W7J8DAAAAAAAAAAAAAAMexTYAavfekt+c1apCfwADecETxl+bbYTMgTibJqlG15AAAAAAAAAAAAYThN3+I9SYADKf4FExwAABO1lCruPEwAANsb/QwaPcuWTBEAwAAcU7trkbuPs4EAt4r3gQHxggGm8IED",
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

  test("the play button on the home opens the song and starts it", async ({ page }) => {
    await mockApi(page);
    // The engine's code is fetched when the page is idle; wait for it so the click can unlock the audio.
    const warmed = page.waitForResponse((response) => /jam-session/.test(response.url()), { timeout: 20_000 });
    await page.goto("/jam");
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await warmed;
    await page.waitForLoadState("networkidle");
    await page.waitForTimeout(1000);
    await page.locator(`[data-jam-card] [data-jam-play="${SONG_B}"]`).click();
    await expect(page).toHaveURL(new RegExp(`/jam/m/${SONG_B}$`));
    await expect(page.locator("[data-jam-toggle]")).toHaveAttribute("data-playing", "true", { timeout: 15_000 });
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
    await expect(page.locator("[data-jam-card]")).toHaveCount(2);
    await page.locator("[data-jam-hero]").getByRole("link", { name: "Abrir a música" }).click();
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
