"use strict";

/**
 * The main process's half of native share audio on Windows: when to offer
 * it, which share it belongs to, and the one audio process that does the work.
 *
 * THE HANDSHAKE, because the display-media handler cannot carry it. Chromium
 * tells the handler only whether the page asked for audio, never why, and a
 * page that asks for audio in this shell gets Chromium's own loopback, which
 * is the mixer and therefore the call on Windows 10. So the page asks for NO
 * audio, and says "offer the native box" out of band first:
 *
 *   1. page  -> arm()          the runtime flag is on and the page can play PCM
 *   2. page  -> getDisplayMedia({ audio: false })
 *   3. main  -> consumeArm()   the picker shows the sound box because of 1
 *   4. main  -> startForSource(id) if the box was ticked; video-only callback
 *   5. page  -> claim()        waits for 4 to start, receives the PCM port
 *
 * An arm is good for one request and two minutes, so a page that armed and
 * then never asked cannot turn the box on for somebody else's share later.
 *
 * `fork` and `createChannel` are injected (`utilityProcess.fork`,
 * `new MessageChannelMain()` in `main.js`) so every branch below runs under
 * `node --test` with fakes, on any OS.
 */

const { formatHresult } = require("./win-share-audio");

const ARM_TTL_MS = 120_000;
/**
 * Two deadlines, both this long, and both end in the same place: the capture
 * is stopped and its port closed, deterministically, not merely "settled".
 *
 *   - from `start`: the host has to report `started` (activation answers in
 *     milliseconds; this is the share waiting on a hung one);
 *   - from `started`: the page has to `claim` the port. A capture nobody
 *     claims would otherwise post a 10 ms chunk a hundred times a second
 *     into a port nobody reads, for as long as the window lives.
 */
const CLAIM_TIMEOUT_MS = 4000;
/** First status call forks the host and self-tests; later calls are cached. */
const STATUS_TIMEOUT_MS = 6000;
/** A native crash twice in one run is a machine this should stop trying on. */
const MAX_HOST_CRASHES = 2;

function createShareAudioController({
  fork,
  createChannel,
  ownPid,
  platform = process.platform,
  now = Date.now,
  log = () => {},
  // Told when a capture the page HAS claimed ends without the page asking
  // (`{ sessionId, reason }`): the stream failed, the device went away, the
  // audio process died. Main forwards it to the window so the page can stop
  // its track and release its audio graph; the page's own stop is not it.
  onSessionEnded = () => {},
}) {
  let host = null;
  let crashes = 0;
  let selfTest = null;
  let resolveSelfTest = null;
  let armedUntil = 0;
  let session = null;
  let counter = 0;

  function settleSession(target, outcome) {
    if (!target || target.outcome) {
      return;
    }
    clearTimeout(target.timer);
    target.outcome = outcome;
    target.resolve(outcome);
  }

  /**
   * A capture that stopped on its own, for any reason the host reports: make
   * the session's end complete, however far it had got. The host has already
   * dropped its session and closed its port (see `stopSession` in the host);
   * this drops ours, closes the port main still holds if the page never took
   * it, and, when the page HAD the capture, tells the page. A failure that
   * comes before the capture started does not come through here: `claim`
   * reports it, with its stage and HRESULT, and stops the session itself.
   */
  function captureEnded(target, reason) {
    if (!target || session !== target) {
      return;
    }
    const wasActive = target.outcome?.active === true;
    stop(target.id);
    if (!wasActive || !target.handed) {
      // Nobody holds it: a capture the page never claimed has no listener to tell.
      return;
    }
    try {
      onSessionEnded({ sessionId: target.id, reason });
    } catch (err) {
      log(`could not tell the page its capture ended: ${err?.message ?? err}`);
    }
  }

  function onHostMessage(message) {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "selftest") {
      resolveSelfTest?.(message);
      resolveSelfTest = null;
      return;
    }
    if (message.type === "log") {
      log(`host: ${message.message}`);
      return;
    }
    if (message.type !== "session") {
      return;
    }
    if (!session || message.sessionId !== session.id) {
      // A capture that started after its share gave up on it (claim timeout,
      // a newer share): nobody will read it, so it must not keep running.
      if (message.state === "started") {
        try {
          host?.child.postMessage({ type: "stop", sessionId: message.sessionId });
        } catch {
          // The host is gone, and took the capture with it.
        }
      }
      return;
    }
    if (message.state === "started" && session.outcome) {
      // The session was settled before its capture reported in (a failure, a
      // host that was thought gone): nobody is going to claim this capture,
      // so it is stopped now, and its port closed, instead of left to post
      // into nothing.
      stop(session.id);
      return;
    }
    if (message.state === "started") {
      log(
        `capturing ${message.target?.mode} (${message.target?.reason}${
          message.target?.exe ? `, ${message.target.exe}` : ""
        })`,
      );
      settleSession(session, {
        active: true,
        target: message.target ?? null,
        autoConvert: message.autoConvert === true,
      });
      // Started is not claimed: the page has CLAIM_TIMEOUT_MS to take the port.
      const unclaimed = session;
      unclaimed.unclaimedTimer = setTimeout(() => {
        if (session === unclaimed && !unclaimed.handed) {
          log("the page never claimed the capture; stopping it");
          stop(unclaimed.id);
        }
      }, CLAIM_TIMEOUT_MS);
    } else if (message.state === "failed") {
      log(
        `capture failed at ${message.stage} ${formatHresult(message.hr)}${
          message.reason ? ` (${message.reason})` : ""
        }`,
      );
      const failing = session;
      const failedLive = failing.outcome?.active === true;
      settleSession(failing, {
        active: false,
        reason: message.reason ?? "failed",
        stage: message.stage ?? null,
        hr: message.hr ?? null,
      });
      // A failure AFTER the capture started (the stream broke mid-share) is
      // the end of a capture the page holds; before it, `claim` reports the
      // failure and stops the session itself.
      if (failedLive) {
        captureEnded(failing, message.reason ?? "failed");
      }
    } else if (message.state === "ended") {
      log(`capture ended ${JSON.stringify(message.stats ?? {})}`);
      // The host closed its end; the page hears silence from here unless it
      // is told, which `captureEnded` does.
      const ending = session;
      settleSession(ending, { active: false, reason: "ended", stage: null, hr: null });
      captureEnded(ending, "ended");
    }
  }

  function ensureHost() {
    if (platform !== "win32" || crashes >= MAX_HOST_CRASHES) {
      return null;
    }
    if (host) {
      return host;
    }
    let child;
    try {
      child = fork();
    } catch (err) {
      log(`could not start the audio process: ${err?.message ?? err}`);
      crashes = MAX_HOST_CRASHES;
      return null;
    }
    const current = { child };
    child.on("message", onHostMessage);
    child.on("exit", (code) => {
      if (host !== current) {
        return;
      }
      host = null;
      if (code !== 0) {
        crashes += 1;
        log(`audio process exited with ${code}`);
      }
      // Asked again next time rather than trusting a result from a process
      // that no longer exists. After MAX_HOST_CRASHES `ensureHost` says no.
      selfTest = null;
      resolveSelfTest?.({ ok: false, stage: "host-exit", hr: null });
      resolveSelfTest = null;
      const orphaned = session;
      const heldLive = orphaned?.outcome?.active === true;
      settleSession(orphaned, { active: false, reason: "host-exit", stage: null, hr: null });
      // The process that owned the capture is gone, and its end of the port
      // with it: a page that held the capture is told, and the session goes.
      if (heldLive) {
        captureEnded(orphaned, "host-exit");
      }
    });
    host = current;
    return host;
  }

  /**
   * Can this machine do it? `{ available, reason, stage, hr }`. Never
   * rejects: a machine that cannot is `available: false`, and the page then
   * does exactly what it did before this existed.
   */
  function status() {
    if (platform !== "win32") {
      return Promise.resolve({ available: false, reason: "platform", stage: null, hr: null });
    }
    if (!selfTest) {
      selfTest = new Promise((resolve) => {
        const target = ensureHost();
        if (!target) {
          resolve({ ok: false, stage: "host", hr: null, reason: "host-unavailable" });
          return;
        }
        const timer = setTimeout(() => {
          resolveSelfTest = null;
          resolve({ ok: false, stage: "timeout", hr: null });
        }, STATUS_TIMEOUT_MS);
        resolveSelfTest = (message) => {
          clearTimeout(timer);
          resolve(message);
        };
        try {
          target.child.postMessage({ type: "selftest", ownPid });
        } catch {
          clearTimeout(timer);
          resolveSelfTest = null;
          resolve({ ok: false, stage: "host", hr: null });
        }
      });
    }
    return selfTest.then((result) => ({
      available: result.ok === true,
      reason: result.ok === true ? null : (result.reason ?? result.stage ?? "unknown"),
      stage: result.ok === true ? null : (result.stage ?? null),
      hr: typeof result.hr === "number" ? result.hr : null,
    }));
  }

  function arm() {
    if (platform !== "win32") {
      return false;
    }
    armedUntil = now() + ARM_TTL_MS;
    return true;
  }

  /** True once per arm, within its TTL. The picker's sound box hangs on this. */
  function consumeArm() {
    const armed = armedUntil > now();
    armedUntil = 0;
    return armed;
  }

  /**
   * Stop the running capture. With `sessionId`, only if it is still that one:
   * the page stops the share it knows about, and must not take down a newer
   * share it has not attached yet.
   */
  function stop(sessionId) {
    const current = session;
    if (!current || (typeof sessionId === "string" && sessionId !== current.id)) {
      return;
    }
    session = null;
    clearTimeout(current.timer);
    clearTimeout(current.unclaimedTimer);
    settleSession(current, { active: false, reason: "stopped", stage: null, hr: null });
    try {
      host?.child.postMessage({ type: "stop", sessionId: current.id });
    } catch {
      // The host is gone, and took the capture with it.
    }
    if (!current.handed) {
      try {
        current.port?.close();
      } catch {
        // Already closed.
      }
    }
  }

  /**
   * Begin capturing for the picked surface (`sourceId`) or, for the probe,
   * an explicit `{ mode, pid }`. Returns at once; `claim()` waits for the
   * outcome.
   */
  function start({ sourceId = null, target = null } = {}) {
    stop();
    const hostNow = ensureHost();
    const id = `share-${++counter}`;
    let resolve;
    const outcome = new Promise((done) => {
      resolve = done;
    });
    const current = {
      id,
      resolve,
      promise: outcome,
      outcome: null,
      timer: null,
      unclaimedTimer: null,
      port: null,
      handed: false,
    };
    session = current;
    if (!hostNow) {
      settleSession(current, { active: false, reason: "host-unavailable", stage: null, hr: null });
      return id;
    }
    let channel;
    try {
      channel = createChannel();
    } catch {
      settleSession(current, { active: false, reason: "channel", stage: null, hr: null });
      return id;
    }
    current.port = channel.port2;
    current.timer = setTimeout(() => {
      settleSession(current, { active: false, reason: "timeout", stage: null, hr: null });
      // Told it failed, so it must not go on capturing into a port nobody
      // reads. A `started` arriving later is stopped by `onHostMessage`.
      stop(current.id);
    }, CLAIM_TIMEOUT_MS);
    try {
      hostNow.child.postMessage(
        { type: "start", sessionId: id, ownPid, sourceId, target },
        [channel.port1],
      );
    } catch {
      settleSession(current, { active: false, reason: "host", stage: null, hr: null });
    }
    return id;
  }

  /**
   * The outcome of the last `start`, and its PCM port the first time it is
   * asked for. A port can be transferred once; a second claim gets
   * `reason: "claimed"` rather than a port that is already somewhere else.
   */
  async function claim() {
    const current = session;
    if (!current) {
      return { active: false, reason: "none", stage: null, hr: null };
    }
    const outcome = await current.promise;
    if (!outcome.active) {
      stop(current.id);
      return outcome;
    }
    if (session !== current) {
      return { active: false, reason: "stopped", stage: null, hr: null };
    }
    if (current.handed) {
      return { active: false, reason: "claimed", stage: null, hr: null };
    }
    current.handed = true;
    clearTimeout(current.unclaimedTimer);
    return { ...outcome, sessionId: current.id, port: current.port };
  }

  function dispose() {
    stop();
    const current = host;
    host = null;
    try {
      current?.child.kill();
    } catch {
      // Already gone.
    }
  }

  return { status, arm, consumeArm, start, claim, stop, dispose };
}

module.exports = {
  ARM_TTL_MS,
  CLAIM_TIMEOUT_MS,
  MAX_HOST_CRASHES,
  createShareAudioController,
};
