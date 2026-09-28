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
/** Activation answers in milliseconds; this is the share waiting on a hung one. */
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
    if (message.type !== "session" || !session || message.sessionId !== session.id) {
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
    } else if (message.state === "failed") {
      log(
        `capture failed at ${message.stage} ${formatHresult(message.hr)}${
          message.reason ? ` (${message.reason})` : ""
        }`,
      );
      settleSession(session, {
        active: false,
        reason: message.reason ?? "failed",
        stage: message.stage ?? null,
        hr: message.hr ?? null,
      });
    } else if (message.state === "ended") {
      log(`capture ended ${JSON.stringify(message.stats ?? {})}`);
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
      settleSession(session, { active: false, reason: "host-exit", stage: null, hr: null });
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
    const current = { id, resolve, promise: outcome, outcome: null, timer: null, port: null, handed: false };
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
    if (session !== current) {
      return { active: false, reason: "stopped", stage: null, hr: null };
    }
    if (!outcome.active) {
      return outcome;
    }
    if (current.handed) {
      return { active: false, reason: "claimed", stage: null, hr: null };
    }
    current.handed = true;
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
