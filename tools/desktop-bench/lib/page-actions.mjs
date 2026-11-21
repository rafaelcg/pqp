// Things a person does in the client, driven through the page.
//
// On a channel holding thousands of rows these use plain DOM walks, never
// Playwright's getByRole: Playwright computes an accessible name for every node
// on the page to answer it, which costs seconds of ITS time on a transcript and
// would be billed to the app.
import { HEAVY_FIRST_MARKER, HEAVY_LAST_MARKER, LIGHT_MARKER } from "../seed.mjs";

export { HEAVY_FIRST_MARKER, HEAVY_LAST_MARKER, LIGHT_MARKER };

/** Wait for text in the page (rAF-polled, textContent: innerText forces layout of the whole transcript). */
export function waitForText(page, text, timeout = 60_000, scope = "body") {
  return page
    .waitForFunction(
      ([t, s]) => ((document.querySelector(s) ?? document.body).textContent.includes(t) ? Date.now() : false),
      [text, scope],
      { polling: "raf", timeout },
    )
    .then((h) => h.jsonValue());
}

export async function clickSidebar(page, name) {
  const ok = await page.evaluate((n) => {
    const els = [...document.querySelectorAll("a, button")];
    const hit = els.find((e) => (e.textContent ?? "").trim().startsWith(n) && !e.closest("main"));
    hit?.click();
    return Boolean(hit);
  }, name);
  if (!ok) throw new Error(`no sidebar entry for ${name}`);
}

/** Switch channel from the sidebar and time it to the channel's newest message. */
export async function switchTo(page, name, marker) {
  const t0 = await page.evaluate(() => Date.now());
  await clickSidebar(page, name);
  const t1 = await waitForText(page, marker, 30_000, "main");
  return t1 - t0;
}

/** Scroll the transcript top to bottom, rAF by rAF, and time every frame. */
export async function scrollSweep(page) {
  return page.evaluate(async () => {
    let el = document.querySelector("article")?.parentElement;
    while (el && !(el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY !== "visible")) {
      el = el.parentElement;
    }
    if (!el) return null;
    const longTasks = [];
    let obs;
    try {
      obs = new PerformanceObserver((l) => l.getEntries().forEach((e) => longTasks.push(e.duration)));
      obs.observe({ type: "longtask", buffered: false });
    } catch {
      // not supported
    }
    el.scrollTop = 0;
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    const frames = [];
    const step = 120;
    let last = performance.now();
    await new Promise((resolve) => {
      const tick = (now) => {
        frames.push(now - last);
        last = now;
        if (el.scrollTop + el.clientHeight >= el.scrollHeight - 2) return resolve();
        el.scrollTop += step;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    obs?.disconnect();
    frames.shift();
    const s = [...frames].sort((a, b) => a - b);
    const pct = (p) => Math.round(s[Math.min(s.length - 1, Math.floor(s.length * p))] * 10) / 10;
    return {
      frames: frames.length,
      p50: pct(0.5),
      p95: pct(0.95),
      max: Math.round(s[s.length - 1] * 10) / 10,
      over33ms: frames.filter((f) => f > 33.4).length,
      longTasks: longTasks.length,
      longTaskMaxMs: longTasks.length ? Math.round(Math.max(...longTasks)) : 0,
    };
  });
}

/**
 * Pull the whole history: scroll to the top until the channel's oldest row is
 * on screen. Counts by that row's text, not by rows in the DOM, because the
 * windowed transcript (#1556) mounts only the rows near the viewport.
 */
export async function loadHistory(page, maxIterations = 200) {
  const t0 = Date.now();
  let iterations = 0;
  for (; iterations < maxIterations; iterations++) {
    const reached = await page.evaluate(
      (marker) => {
        let el = document.querySelector("article")?.parentElement;
        while (el && !(el.scrollHeight > el.clientHeight + 10 && getComputedStyle(el).overflowY !== "visible")) {
          el = el.parentElement;
        }
        if (el) el.scrollTop = 0;
        return (document.querySelector("main") ?? document.body).textContent.includes(marker);
      },
      HEAVY_FIRST_MARKER,
    );
    if (reached) return { loaded: true, iterations, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 250));
  }
  return { loaded: false, iterations, ms: Date.now() - t0 };
}

export async function rendererStats(page) {
  return page.evaluate(() => ({
    domNodes: document.getElementsByTagName("*").length,
    jsHeapMB: performance.memory ? Math.round((performance.memory.usedJSHeapSize / 1048576) * 10) / 10 : null,
  }));
}

/** Frames the biggest playing <video> has shown and dropped so far, and its picture size. */
export async function videoStats(page) {
  return page.evaluate(() => {
    const vids = [...document.querySelectorAll("video")].filter((v) => v.videoWidth > 0);
    vids.sort((a, b) => b.videoWidth * b.videoHeight - a.videoWidth * a.videoHeight);
    const v = vids[0];
    if (!v) return null;
    const q = v.getVideoPlaybackQuality?.();
    return {
      width: v.videoWidth,
      height: v.videoHeight,
      paused: v.paused,
      currentTime: v.currentTime,
      totalFrames: q?.totalVideoFrames ?? null,
      droppedFrames: q?.droppedVideoFrames ?? null,
    };
  });
}
