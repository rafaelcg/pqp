import { test, expect } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { allPages, launchApp, resolveApp, startPageServer } from "./driver.mjs";
import { classifyRejection, judgeShare } from "./verdict.mjs";

/**
 * DOES A SCREEN SHARE START IN THE APP PEOPLE DOWNLOAD.
 *
 * Desktop 0.2.8 (Electron 44.9.1, Chromium 152) was promoted on 2026-10-27
 * and Windows 11 users got "Invalid capture constraints" the moment they
 * clicked share, while 505 shell unit tests, the window smoke test and the
 * Windows audio add-on smoke test were all green. All of those test the share
 * against a MOCK of Chromium; none of them ever handed the constraints the
 * client really builds to the Chromium that really ships.
 *
 * This does. It starts the packaged binary (`PQP_SHARE_SMOKE_APP`; fuses as
 * shipped, see driver.mjs for how a fused binary is driven at all), points it
 * at a page that runs the client's real share code (client/e2e/desktop-share),
 * clicks through the shell's real picker, and requires a live, moving video
 * track, the right audio, and a clean stop. Every scenario runs in the same
 * app, one after another, so the second one also proves the first one let go.
 *
 * Then it breaks the constraints on purpose and requires the SAME judgement to
 * call that a failure, so a green run is evidence that red was possible.
 *
 *   PQP_SHARE_SMOKE_APP=/path/to/pqp.app pnpm --filter @pqp/electron smoke:share
 *
 * `PQP_SHARE_SMOKE_BREAK=width-zero` breaks every scenario, the red run a
 * person can ask for to see this gate fail end to end.
 */

const OUT_DIR = path.resolve(
  process.env.PQP_SHARE_SMOKE_OUT ?? path.join(import.meta.dirname, "..", "..", "test-results", "share-smoke"),
);
/**
 * Video constraint breaks, merged over what the app built. Measured on
 * Electron 44.9.1 (Chromium 152), 2026-10-28:
 *
 * - `width-zero` (`width: { max: 0 }`): OverconstrainedError naming `width`,
 *   before the picker opens. A constraint no surface can meet, refused by
 *   Chromium's own constraint check, the family the 0.2.8 refusal belongs to.
 * - `min-width` (`width: { min: 640 }`): TypeError, "min constraints are not
 *   supported". The request's SHAPE refused, before the shell is asked.
 *
 * `displaySurface: "browser"`, the 13 Sep 2026 regression, is NOT here: on
 * Chromium 152 a window or screen source satisfies it and the share starts.
 */
const BREAKS = {
  "width-zero": { width: { max: 0 } },
  "min-width": { width: { min: 640 } },
};
const BREAK_ALL = process.env.PQP_SHARE_SMOKE_BREAK || null;
if (BREAK_ALL && !BREAKS[BREAK_ALL]) {
  throw new Error(`PQP_SHARE_SMOKE_BREAK must be one of ${Object.keys(BREAKS).join(", ")}`);
}
const EXPECT_VERSION = process.env.PQP_SHARE_SMOKE_EXPECT_VERSION || null;
/** How long one share may wait for the picker and the capture. */
const SHARE_DEADLINE_MS = 45_000;

// Not serial: a failed scenario must not stop the next one from reporting.
// After a failure Playwright starts a fresh worker, so the app is relaunched.
test.setTimeout(5 * 60_000);

let server;
let app;
let page;
/** About the app under test; each scenario writes its own file beside it. */
const run = {};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test.beforeAll(async () => {
  test.setTimeout(3 * 60_000);
  mkdirSync(OUT_DIR, { recursive: true });
  const target = resolveApp();
  server = await startPageServer();
  app = await launchApp({
    app: target,
    appUrl: server.url,
    logFile: path.join(OUT_DIR, "app.log"),
  });
  run.app = { kind: target.kind, command: target.command, browser: app.version.Browser };
  run.platform = process.platform;
  run.osRelease = os.release();

  const deadline = Date.now() + 60_000;
  while (!page && Date.now() < deadline) {
    page = allPages(app.browser).find((p) => p.url().startsWith(server.url));
    if (!page) {
      await sleep(250);
    }
  }
  if (!page) {
    throw new Error(
      `the app never opened ${server.url}. Pages: ${allPages(app.browser)
        .map((p) => p.url())
        .join(", ")}. Last output:\n${app.lines.slice(-30).join("\n")}`,
    );
  }
  await page.waitForFunction(() => window.pqpShareSmoke?.ready === true, null, {
    timeout: 30_000,
  });
  run.userAgent = await page.evaluate(() => navigator.userAgent);
  // Only a packaged build (`app.isPackaged`) logs this, so it is the binary
  // itself saying it is the shipped kind and not the repo's own Electron.
  run.packagedSaysSo = app.lines.some((l) => l.includes("PQP_ALLOW_APP_URL_OVERRIDE is set"));
  if (process.env.PQP_SHARE_SMOKE_REQUIRE_PACKAGED === "1" && !run.packagedSaysSo) {
    throw new Error(
      `the app under test did not report itself as a packaged build. Output:\n${app.lines.slice(-30).join("\n")}`,
    );
  }
  writeFileSync(path.join(OUT_DIR, "run.json"), `${JSON.stringify(run, null, 2)}\n`);
});

test.afterAll(async () => {
  await app?.close();
  await server?.close();
});

/**
 * Click through the shell's picker the way a person would: the first SCREEN
 * (the surface most people share), the sound switch left as drawn or set, then
 * Share. Returns what the picker offered.
 */
async function answerPicker(picker, sound) {
  await picker.waitForSelector(".tile", { timeout: 15_000 });
  const tiles = await picker.$$eval(".tile", (all) =>
    all.map((t) => ({
      id: t.dataset.id,
      title: t.title,
      thumbnail: Boolean(t.querySelector(".shot img")),
    })),
  );
  const ids = tiles.map((t) => t.id);
  // A screen first, the tile the picker pre-selects and most people share.
  // Failing that (a macOS that lists no displays), this app's own window,
  // whose page animates: a capturer may deliver no frames for a still
  // surface, and another app's idle window would read as a dead share.
  const chosen =
    ids.find((id) => id.startsWith("screen:")) ??
    tiles.find((t) => /pqp share smoke/i.test(t.title))?.id ??
    ids[0];
  await picker.click(`.tile[data-id="${chosen}"]`);
  const audioRow = await picker.evaluate(() => {
    const row = document.getElementById("audio-row");
    const box = document.getElementById("share-audio");
    const switchEl = document.getElementById("audio-switch");
    return {
      visible: Boolean(row && !row.hidden),
      hasSwitch: Boolean(row && !row.hidden && switchEl && !switchEl.hidden),
      checkedAsDrawn: Boolean(box?.checked),
    };
  });
  if (sound !== "as-drawn" && audioRow.hasSwitch) {
    await picker.locator("#share-audio").setChecked(sound === "on", { force: true });
  }
  const checkedAtShare = await picker.evaluate(
    () => Boolean(document.getElementById("share-audio")?.checked),
  );
  await picker.click("#confirm");
  return {
    sources: ids.length,
    screens: ids.filter((id) => id.startsWith("screen:")).length,
    thumbnails: tiles.filter((t) => t.thumbnail).length,
    chosen,
    audioRow,
    checkedAtShare,
  };
}

/**
 * macOS without an effective Screen Recording grant does not refuse: the shell
 * lists only windows, every one without a preview, and the capture it then
 * starts is a live track that never delivers a frame. That is what this
 * process sees on a Mac where the grant belongs to some other app, and it is
 * the one shape where "no frames" is the machine and not the build.
 */
function macWithoutScreenGrant(picker) {
  return (
    process.platform === "darwin" &&
    Boolean(picker) &&
    picker.sources > 0 &&
    picker.screens === 0 &&
    picker.thumbnails === 0
  );
}

const FRAME_PROBLEMS = [/^no frame arrived/, /^frames stopped advancing/];

/**
 * `PQP_SHARE_SMOKE_MAC_WITHOUT_GRANT=accept`: on a Mac that cannot grant this
 * binary Screen Recording (a CI runner, a terminal that does not hold it),
 * frames are reported and not required. Everything up to them still is: the
 * constraints accepted, a source chosen, a live track, a clean stop.
 */
const ACCEPT_MAC_WITHOUT_GRANT = process.env.PQP_SHARE_SMOKE_MAC_WITHOUT_GRANT === "accept";

async function share(scenario) {
  const harnessScenario = {
    nativeShareAudio: scenario.nativeShareAudio,
    breakVideo: BREAKS[scenario.breakConstraints ?? BREAK_ALL] ?? null,
  };
  await page.evaluate((s) => window.pqpShareSmoke.start(s), harnessScenario);
  const deadline = Date.now() + SHARE_DEADLINE_MS;
  let picker = null;
  let result = null;
  while (Date.now() < deadline) {
    result = await page.evaluate(() => window.pqpShareSmoke.result());
    if (!result.pending) {
      break;
    }
    if (!picker) {
      const target = allPages(app.browser).find((p) => p.url().includes("/picker/index.html"));
      if (target) {
        try {
          picker = await answerPicker(target, scenario.sound);
        } catch (err) {
          picker = { error: String(err?.message ?? err) };
        }
      }
    }
    await sleep(200);
  }
  return { result, picker };
}

function record(name, outcome, extra = {}) {
  const entry = { name, platform: process.platform, ...outcome, ...extra };
  const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  mkdirSync(path.join(OUT_DIR, "scenarios"), { recursive: true });
  writeFileSync(
    path.join(OUT_DIR, "scenarios", `${slug}.json`),
    `${JSON.stringify(entry, null, 2)}\n`,
  );
  return entry;
}

function stuckMessage(picker) {
  const tail = app.lines.filter((l) => l.includes("[pqp]")).slice(-15).join("\n");
  if (picker) {
    return `the picker was answered (${JSON.stringify(picker)}) but getDisplayMedia never settled within ${SHARE_DEADLINE_MS / 1000} s. Shell log:\n${tail}`;
  }
  return (
    `no picker and no answer within ${SHARE_DEADLINE_MS / 1000} s: the shell's handler is blocked before its picker. ` +
    (process.platform === "darwin"
      ? "On macOS that is the Screen Recording explainer (or the no-sources box), a native dialog this test cannot click: the app under test does not hold the Screen Recording grant. "
      : "") +
    `Shell log:\n${tail}`
  );
}

/** What audio the share must carry, from what the person was offered. */
function expectedAudio(result, picker) {
  if (result.nativeAudio) {
    return picker?.checkedAtShare ? "native" : "none";
  }
  if (result.askedForAudio && picker?.audioRow?.hasSwitch) {
    return picker.checkedAtShare ? "loopback" : "none";
  }
  return result.askedForAudio ? "any" : "none";
}

const SCENARIOS = [
  {
    name: "a plain share, sound switch as the picker draws it",
    nativeShareAudio: false,
    sound: "as-drawn",
  },
  ...(process.platform === "win32"
    ? [
        {
          name: "a share with the picker's sound switch turned off",
          nativeShareAudio: false,
          sound: "off",
        },
        {
          name: "a share with native share audio on (per-server flag), sound on",
          nativeShareAudio: true,
          sound: "on",
        },
      ]
    : []),
];

for (const scenario of SCENARIOS) {
  test(scenario.name, async () => {
    if (EXPECT_VERSION) {
      const version = await page.evaluate(() => window.pqpDesktop?.capabilities?.version ?? null);
      expect(version, "the app under test is not the version this run was asked to verify").toBe(
        EXPECT_VERSION,
      );
    }
    const started = Date.now();
    const { result, picker } = await share(scenario);
    const elapsed = Date.now() - started;
    if (!result || result.pending) {
      record(scenario.name, { ok: false, elapsed, picker, problems: ["stuck"] });
      throw new Error(stuckMessage(picker));
    }
    const audio = expectedAudio(result, picker);
    let problems = judgeShare(result, { audio });
    let notVerified = [];
    if (macWithoutScreenGrant(picker) && ACCEPT_MAC_WITHOUT_GRANT) {
      notVerified = problems.filter((p) => FRAME_PROBLEMS.some((re) => re.test(p)));
      problems = problems.filter((p) => !notVerified.includes(p));
    }
    record(scenario.name, {
      ok: problems.length === 0,
      elapsed,
      picker,
      expectedAudio: audio,
      problems,
      notVerified,
      macWithoutScreenGrant: macWithoutScreenGrant(picker),
      result,
    });
    if (notVerified.length > 0) {
      test.info().annotations.push({
        type: "not verified",
        description: `macOS without a Screen Recording grant: ${notVerified.join("; ")}`,
      });
    }
    expect(
      problems,
      `share failed. Picker: ${JSON.stringify(picker)}` +
        (macWithoutScreenGrant(picker)
          ? ". This Mac lists no screen and no previews: the app has no effective Screen Recording grant (set PQP_SHARE_SMOKE_MAC_WITHOUT_GRANT=accept to check everything short of frames)"
          : ""),
    ).toEqual([]);
  });
}

// If the judgement above called THESE working shares, every green run above
// would be worthless. Same page, same judgement, one impossible member merged
// over what the app built.
for (const [breakName, expectedName] of [
  ["width-zero", "OverconstrainedError"],
  ["min-width", "TypeError"],
]) {
  test(`an impossible constraint (${breakName}) turns this gate red`, async () => {
    test.skip(Boolean(BREAK_ALL), "every scenario is already broken on purpose in this run");
    const scenario = {
      name: `known-bad constraint ${breakName}`,
      nativeShareAudio: false,
      sound: "off",
      breakConstraints: breakName,
    };
    const started = Date.now();
    const { result, picker } = await share(scenario);
    const elapsed = Date.now() - started;
    if (!result || result.pending) {
      record(scenario.name, { ok: false, elapsed, picker, problems: ["stuck"] });
      throw new Error(stuckMessage(picker));
    }
    const problems = judgeShare(result, { audio: "none" });
    record(scenario.name, {
      ok: problems.length > 0,
      elapsed,
      picker,
      problems,
      classification: classifyRejection(result.error),
      result,
    });
    expect(problems.length, "a share with an impossible constraint was judged to work").toBeGreaterThan(0);
    expect(result.error?.name, "Chromium did not refuse the impossible constraint as expected").toBe(
      expectedName,
    );
  });
}
