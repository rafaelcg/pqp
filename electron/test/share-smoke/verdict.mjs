/**
 * Is a share result a working share? One function, so the scenario that must
 * pass and the scenario that must fail are judged by the same rules: a gate
 * whose "red" was judged by a different check would prove nothing about the
 * check that guards the release.
 *
 * `result` is what `client/e2e/desktop-share/harness-page.ts` reports.
 * Returns the list of reasons it is NOT a working share; empty means it is.
 */

/** What a rejection's name says about where in the pipeline it happened. */
export function classifyRejection(error) {
  if (!error) {
    return null;
  }
  if (error.name.startsWith("harness:")) {
    return "the test page itself threw before or after the capture (a harness bug, not a share result)";
  }
  switch (error.name) {
    case "TypeError":
      return "Chromium refused the SHAPE of the request before the shell's handler ran";
    case "OverconstrainedError":
      return "Chromium refused a constraint it cannot meet (the 0.2.8 class)";
    case "AbortError":
      // Desktop 0.2.8 on every platform: the shell's picker page could not
      // load from the packaged app, the handler gave up, and Chromium words
      // that "Invalid capture constraints". The shell log says which.
      return "the capture was aborted after the shell's handler was asked (Chromium words it \"Invalid capture constraints\"; on 0.2.8 the shell's picker page failed to load, see the shell log)";
    case "NotAllowedError":
      return "the shell answered no: picker cancelled, macOS Screen Recording not granted, or no source";
    case "NotReadableError":
      return "the chosen source could not be opened (a capturer or audio device failed to start)";
    case "NotSupportedError":
      return "this engine does not support the request at all";
    default:
      return /constraint/i.test(error.message)
        ? "Chromium refused the constraints (the 0.2.8 class)"
        : "unclassified rejection";
  }
}

/**
 * @param {object} result the harness report
 * @param {{ audio: "loopback" | "native" | "none" | "any" }} expect
 */
export function judgeShare(result, expect) {
  const problems = [];
  if (!result || result.pending) {
    return ["the share never settled"];
  }
  if (result.error) {
    const { name, message, constraint } = result.error;
    problems.push(
      `getDisplayMedia rejected: ${name}: ${message}${constraint ? ` (constraint: ${constraint})` : ""}. ` +
        `${classifyRejection(result.error)}. Options sent: ${JSON.stringify(result.options)}`,
    );
    return problems;
  }
  const video = result.video;
  if (!video) {
    return ["the capture resolved with no video track"];
  }
  if (video.readyState !== "live") {
    problems.push(`video track readyState is ${video.readyState}, not live`);
  }
  if (!(video.width > 0 && video.height > 0)) {
    problems.push(`video has no size (${video.width}x${video.height})`);
  }
  if (!(video.framesBefore > 0)) {
    problems.push("no frame arrived within 5 s of the capture starting");
  } else if (!(video.framesAfter > video.framesBefore)) {
    problems.push(`frames stopped advancing (${video.framesBefore} then ${video.framesAfter} a second later)`);
  }
  if (!video.endedAfterStop) {
    problems.push("stopping the tracks did not end them");
  }
  const live = result.audio.filter((t) => t.readyState === "live");
  if (expect.audio === "loopback" || expect.audio === "native") {
    if (live.length !== 1) {
      problems.push(
        `expected one live ${expect.audio} audio track, got ${result.audio.length} (${live.length} live)` +
          (expect.audio === "native" && result.nativeAttach
            ? `; native attach: ${JSON.stringify(result.nativeAttach)}`
            : ""),
      );
    }
  } else if (expect.audio === "none" && result.audio.length > 0) {
    problems.push(`expected a silent share, got ${result.audio.length} audio track(s)`);
  }
  return problems;
}
