import { expect, test, type Page } from "@playwright/test";
import {
  AGE_RESTRICTED,
  CONTROL,
  DELETED,
  EMBED_DISABLED,
  LONG_CONTROL,
  PRIVATE,
} from "./watch-party-videos";

/**
 * What the real YouTube IFrame API actually does, pinned against the real API.
 *
 * This spec tests no pqp code at all, and that is the point. The watch-party
 * design rests on four claims about somebody else's player, every one of them
 * load bearing, and two of them are false. A test that only exercises our
 * modules against a fake would agree with the design and still ship a feature
 * that does not work, because the fake would be built from the same wrong
 * belief the design was.
 *
 * It is also the tripwire for the day YouTube changes its mind. These
 * constants are not ours and nobody will tell us when they move.
 *
 * The page is fulfilled at `https://pqp.gg/...` rather than served from
 * localhost so the iframe sees a real registered domain in the `Referer`.
 * Every finding below was checked both ways and did not differ, but the
 * production shape is the one worth pinning.
 */

test.use({
  launchOptions: {
    // The autoplay block is a real constraint on the feature and is tested
    // separately, in `watch-party-client.spec.ts`, from the app's own page.
    // Here it is only in the way: this spec is about what the player does
    // once it is playing, and clicking through a gesture requirement in a
    // fixture page would prove nothing about pqp.
    args: ["--autoplay-policy=no-user-gesture-required"],
  },
});

// Loading a real video from a real CDN, several times over.
test.setTimeout(180_000);

const PROBE_URL = "https://pqp.gg/e2e-youtube-probe";

function probePage(videoId: string, head = ""): string {
  return `<!doctype html><meta charset="utf-8"><title>probe</title>${head}
<div id="player"></div>
<script>
  window.__errors = [];
  window.__states = [];
  window.__ready = false;
</script>
<script src="https://www.youtube.com/iframe_api"></script>
<script>
  function onYouTubeIframeAPIReady() {
    window.__player = new YT.Player('player', {
      height: '270', width: '480', videoId: ${JSON.stringify(videoId)},
      playerVars: { playsinline: 1 },
      events: {
        onReady: function () { window.__ready = true; },
        onError: function (e) { window.__errors.push(e.data); },
        onStateChange: function (e) {
          window.__states.push([performance.now(), e.data]);
        }
      }
    });
  }
</script>`;
}

async function openProbe(
  page: Page,
  videoId: string,
  head = "",
  headers: Record<string, string> = {},
): Promise<void> {
  await page.route(PROBE_URL, (route) =>
    route.fulfill({
      status: 200,
      contentType: "text/html",
      headers,
      body: probePage(videoId, head),
    }),
  );
  await page.goto(PROBE_URL);
  // Deliberately not asserted: a failing video still fires `onReady`, which is
  // itself one of the findings below.
  await page
    .waitForFunction(() => (window as never as { __ready: boolean }).__ready, {
      timeout: 30_000,
    })
    .catch(() => undefined);
}

interface Probe {
  ready: boolean;
  errors: number[];
  playerState: number | null;
  currentTime: number | null;
}

async function readProbe(page: Page): Promise<Probe> {
  return page.evaluate(() => {
    const w = window as never as {
      __ready: boolean;
      __errors: number[];
      __player?: {
        getPlayerState?: () => number;
        getCurrentTime?: () => number;
      };
    };
    const safely = <T>(read: () => T): T | null => {
      try {
        return read();
      } catch {
        return null;
      }
    };
    return {
      ready: w.__ready,
      errors: w.__errors,
      playerState: safely(() => w.__player?.getPlayerState?.() ?? null),
      currentTime: safely(() => w.__player?.getCurrentTime?.() ?? null),
    };
  });
}

// --------------------------------------------------------- playback rates

test("the nudge rates the drift ladder asks for are not the rates it gets", async ({
  page,
}) => {
  await openProbe(page, LONG_CONTROL.id);
  await page.evaluate(() =>
    (window as never as { __player: { playVideo: () => void } }).__player.playVideo(),
  );
  await page.waitForFunction(
    () =>
      (window as never as { __player: { getPlayerState: () => number } })
        .__player.getPlayerState() === 1,
    { timeout: 30_000 },
  );

  const ask = async (rate: number): Promise<number> =>
    page.evaluate(async (value) => {
      const player = (
        window as never as {
          __player: {
            setPlaybackRate: (r: number) => void;
            getPlaybackRate: () => number;
          };
        }
      ).__player;
      player.setPlaybackRate(value);
      await new Promise((resolve) => setTimeout(resolve, 700));
      return player.getPlaybackRate();
    }, rate);

  // The two values `state.ts` exports as SLOW_RATE and FAST_RATE.
  const slow = await ask(0.97);
  const fast = await ask(1.03);
  // eslint-disable-next-line no-console
  console.log(`[youtube] asked 0.97 got ${slow}; asked 1.03 got ${fast}`);

  // This is the failure, stated as the assertion that would have caught it.
  // Asking to speed up by 3 percent is not a weak correction, it is NO
  // correction: the player lands on exactly 1.0 and the peer that is behind
  // stays behind until it crosses the 1s threshold and hard seeks, which is
  // the one thing the ladder exists to avoid.
  expect(
    fast,
    "1.03 must actually speed the player up; if this reads 1 the whole behind half of the nudge band is dead",
  ).toBeGreaterThan(1);

  // And 0.97 does correct, but at roughly 1.7x the strength the design
  // intended, which is a different bug in the same line.
  expect(
    slow,
    "0.97 is snapped to 0.95, so the ahead half corrects harder than designed",
  ).toBe(0.97);
});

test("the honoured rates near 1.0 are multiples of 0.05, and getAvailablePlaybackRates does not say so", async ({
  page,
}) => {
  // A reader of `getAvailablePlaybackRates()` would conclude the only usable
  // values near 1.0 are 0.75, 1 and 1.25, and would therefore give up on
  // nudging altogether. That list is not the restriction. 0.95 and 1.05 both
  // work and neither appears in it, so this pins what is really available.
  await openProbe(page, LONG_CONTROL.id);
  await page.evaluate(() =>
    (window as never as { __player: { playVideo: () => void } }).__player.playVideo(),
  );
  await page.waitForFunction(
    () =>
      (window as never as { __player: { getPlayerState: () => number } })
        .__player.getPlayerState() === 1,
    { timeout: 30_000 },
  );

  const advertised = await page.evaluate(() =>
    (
      window as never as {
        __player: { getAvailablePlaybackRates: () => number[] };
      }
    ).__player.getAvailablePlaybackRates(),
  );
  // eslint-disable-next-line no-console
  console.log(`[youtube] getAvailablePlaybackRates: ${JSON.stringify(advertised)}`);
  expect(advertised).not.toContain(0.95);
  expect(advertised).not.toContain(1.05);

  const measured = await page.evaluate(async () => {
    const player = (
      window as never as {
        __player: {
          setPlaybackRate: (r: number) => void;
          getPlaybackRate: () => number;
          getCurrentTime: () => number;
        };
      }
    ).__player;
    const settle = () => new Promise((resolve) => setTimeout(resolve, 700));
    const out: Record<string, number> = {};
    for (const rate of [0.95, 1.05]) {
      player.setPlaybackRate(rate);
      await settle();
      out[`reported_${rate}`] = player.getPlaybackRate();
      // Reported is not the same as real. Measure how far the video actually
      // advances against the wall clock, because a rate the player accepts and
      // then ignores would look identical from the getter alone.
      const t0 = player.getCurrentTime();
      const w0 = performance.now();
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      out[`effective_${rate}`] =
        (player.getCurrentTime() - t0) / ((performance.now() - w0) / 1_000);
    }
    player.setPlaybackRate(1);
    return out;
  });
  // eslint-disable-next-line no-console
  console.log(`[youtube] rates: ${JSON.stringify(measured)}`);

  expect(measured["reported_0.95"]).toBe(0.95);
  expect(measured["reported_1.05"]).toBe(1.05);
  // Generous windows: this is a real decoder on a machine also running two
  // browsers, so the claim is "it moved in the right direction by roughly the
  // right amount", not a benchmark.
  expect(measured["effective_0.95"]).toBeGreaterThan(0.9);
  expect(measured["effective_0.95"]).toBeLessThan(1.0);
  expect(measured["effective_1.05"]).toBeGreaterThan(1.0);
  expect(measured["effective_1.05"]).toBeLessThan(1.12);
});

// --------------------------------------------------------------- failures

const FAILING = [
  { fixture: EMBED_DISABLED, label: "embedding disabled" },
  { fixture: AGE_RESTRICTED, label: "age restricted" },
  { fixture: DELETED, label: "deleted" },
  { fixture: PRIVATE, label: "private" },
  { fixture: { id: "zzzzzzzzzzz", title: "not a video id" }, label: "not a video" },
];

for (const { fixture, label } of FAILING) {
  test(`a ${label} video fires onReady, reports 150, and sits at position 0 forever`, async ({
    page,
  }) => {
    await openProbe(page, fixture.id);
    await page.evaluate(() => {
      try {
        (
          window as never as { __player: { playVideo: () => void } }
        ).__player.playVideo();
      } catch {
        // A failed player can throw here; the reading below is the assertion.
      }
    });
    await page.waitForTimeout(6_000);
    const probe = await readProbe(page);
    // eslint-disable-next-line no-console
    console.log(`[youtube] ${label} (${fixture.id}): ${JSON.stringify(probe)}`);

    // Readiness is not playability. A client that treats `onReady` as "we are
    // watching" is wrong for every video in this list.
    expect(probe.ready, "onReady still fires for an unplayable video").toBe(true);

    // The code. Not 101, not 100, not 2, not 5. One code for every one of
    // these conditions, which is the finding that decides what the failure UI
    // is allowed to claim.
    expect(probe.errors).toContain(150);

    // The hazard the wire contract warns about, as an observed fact: a failed
    // player reports exactly 0 forever, so if it is ever allowed to write, its
    // position 0 on a fresh `rev` outranks everyone and resets the room.
    expect(probe.playerState, "unstarted forever").toBe(-1);
    expect(probe.currentTime).toBe(0);
  });
}

test("a playable video reports no error, which is what makes the check above mean something", async ({
  page,
}) => {
  await openProbe(page, CONTROL.id);
  await page.evaluate(() =>
    (window as never as { __player: { playVideo: () => void } }).__player.playVideo(),
  );
  await page.waitForTimeout(6_000);
  const probe = await readProbe(page);
  expect(probe.errors).toEqual([]);
  expect(probe.playerState).toBe(1);
  expect(probe.currentTime ?? 0).toBeGreaterThan(0);
});

// ------------------------------------------------------------- error 153

test("error 153 could not be provoked by suppressing the referrer", async ({
  page,
}) => {
  // The IFrame API reference defines 153 as "the request does not include the
  // HTTP Referer header or equivalent API Client identification". If that were
  // the whole story, a document served with `Referrer-Policy: no-referrer`
  // would produce it, and it does not: the video plays normally.
  //
  // So 153 is documented rather than reproduced, and this test records the
  // attempt rather than the result. The practical consequence for the feature
  // is the opposite of what was feared: 153 is trivially distinguishable
  // because it is a distinct code, and the codes that are NOT distinguishable
  // are 100 and 101, which never arrive at all.
  await openProbe(page, CONTROL.id, '<meta name="referrer" content="no-referrer">', {
    "Referrer-Policy": "no-referrer",
  });
  await page.evaluate(() =>
    (window as never as { __player: { playVideo: () => void } }).__player.playVideo(),
  );
  await page.waitForTimeout(6_000);
  const probe = await readProbe(page);
  // eslint-disable-next-line no-console
  console.log(`[youtube] no-referrer probe: ${JSON.stringify(probe)}`);
  expect(
    probe.errors,
    "if this ever reports 153, the branch is reachable from a test and should get a real one",
  ).toEqual([]);
});
