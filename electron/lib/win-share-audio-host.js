"use strict";

/**
 * The utility process that owns the Windows share-audio add-on.
 *
 * WHY A SEPARATE PROCESS. The add-on is native code talking to the audio
 * engine on a thread of its own. If it crashes, it should cost one share its
 * sound, not the app its window and everybody their call. `utilityProcess`
 * is Electron's answer to exactly that: a Node child the main process can
 * lose. It also keeps a hundred 10 ms chunks a second off the main process's
 * event loop, which is the one that draws the tray and answers every IPC.
 *
 * PCM never passes through main. Main hands this process one end of a
 * `MessageChannelMain` and the renderer the other, so each chunk goes from
 * here straight to the page's AudioWorklet.
 *
 * Protocol (all from main, all answered on `parentPort`):
 *   { type: "selftest", ownPid }               -> { type: "selftest", ok, stage, hr }
 *   { type: "start", sessionId, ownPid,
 *     sourceId | target }  + ports[0]           -> { type: "session", sessionId, state, ... }
 *   { type: "stop", sessionId }
 * `state` is "started", "failed" or "ended". `target` ({ mode, pid }) is only
 * sent by the probe, which aims at its own tree on purpose.
 */

const {
  MODE_INCLUDE,
  MODE_EXCLUDE,
  captureTargetForSource,
  loadWinShareAudioAddon,
} = require("./win-share-audio");

/** How long activation plus Initialize may take before the self-test gives up. */
const SELFTEST_TIMEOUT_MS = 4000;

const parent = process.parentPort;
const loaded = loadWinShareAudioAddon();
/** sessionId -> { capture, port } */
const sessions = new Map();

function send(message) {
  try {
    parent.postMessage(message);
  } catch {
    // Main is gone; so is everything this process was for.
  }
}

function stopSession(sessionId) {
  const session = sessions.get(sessionId);
  if (!session) {
    return;
  }
  sessions.delete(sessionId);
  try {
    session.capture?.stop();
  } catch {
    // Already stopped.
  }
  try {
    session.port?.close();
  } catch {
    // Already closed.
  }
}

/**
 * Can this machine open a process loopback stream at all? Activation plus
 * Initialize, no reading. This is the runtime answer to "which Windows 10
 * builds?", asked of the machine rather than of a table: a build that cannot
 * do it fails here and the picker never offers a box that would not work.
 */
function selfTest(ownPid) {
  if (!loaded.addon) {
    send({ type: "selftest", ok: false, stage: "load", hr: null, reason: loaded.reason });
    return;
  }
  let finished = false;
  let capture = null;
  const finish = (result) => {
    if (finished) {
      return;
    }
    finished = true;
    clearTimeout(timer);
    try {
      capture?.stop();
    } catch {
      // Stopping a capture that failed to start is a no-op.
    }
    send({ type: "selftest", reason: null, ...result });
  };
  const timer = setTimeout(
    () => finish({ ok: false, stage: "timeout", hr: null }),
    SELFTEST_TIMEOUT_MS,
  );
  try {
    capture = loaded.addon.startCapture(
      ownPid,
      MODE_EXCLUDE,
      () => {},
      (event) => {
        if (event.type === "started") {
          finish({ ok: true, stage: null, hr: 0, autoConvert: event.autoConvert === true });
        } else if (event.type === "error") {
          finish({ ok: false, stage: event.stage, hr: event.hr });
        }
      },
    );
  } catch (err) {
    finish({ ok: false, stage: "thread", hr: null, reason: String(err?.message ?? err) });
  }
}

function start(message, port) {
  const { sessionId, ownPid } = message;
  const fail = (extra) => {
    send({ type: "session", sessionId, state: "failed", ...extra });
    try {
      port?.close();
    } catch {
      // Nothing to close.
    }
  };
  if (!loaded.addon) {
    fail({ stage: "load", hr: null, reason: loaded.reason });
    return;
  }
  if (!port) {
    fail({ stage: "port", hr: null });
    return;
  }
  const target =
    message.target &&
    (message.target.mode === MODE_INCLUDE || message.target.mode === MODE_EXCLUDE) &&
    Number.isInteger(message.target.pid)
      ? { ...message.target, reason: "explicit", exe: null }
      : captureTargetForSource(message.sourceId, ownPid, loaded.addon);
  if (!target) {
    fail({ stage: "target", hr: null });
    return;
  }

  // One share at a time, like the picker. A leftover is stopped, not joined.
  for (const id of [...sessions.keys()]) {
    stopSession(id);
  }

  const session = { capture: null, port };
  sessions.set(sessionId, session);
  // The page reloading or the share ending closes its end; stop capturing
  // for nobody.
  port.on("close", () => stopSession(sessionId));
  port.start();

  const described = { mode: target.mode, reason: target.reason, exe: target.exe };
  try {
    session.capture = loaded.addon.startCapture(
      target.pid,
      target.mode,
      (chunk) => {
        try {
          port.postMessage(chunk);
        } catch {
          stopSession(sessionId);
        }
      },
      (event) => {
        if (event.type === "started") {
          send({
            type: "session",
            sessionId,
            state: "started",
            target: described,
            autoConvert: event.autoConvert === true,
          });
        } else if (event.type === "error") {
          send({
            type: "session",
            sessionId,
            state: "failed",
            target: described,
            stage: event.stage,
            hr: event.hr,
          });
          stopSession(sessionId);
        } else if (event.type === "ended") {
          // Ended on its own (the stream failed, the device went away): close
          // the port so the page's worklet stops waiting on it, and say so.
          // After a stop this is a no-op; the session is already gone.
          stopSession(sessionId);
          send({
            type: "session",
            sessionId,
            state: "ended",
            stats: {
              packets: event.packets,
              frames: event.frames,
              silentPackets: event.silentPackets,
              discontinuities: event.discontinuities,
              dropped: event.dropped,
            },
          });
        }
      },
    );
  } catch (err) {
    sessions.delete(sessionId);
    fail({ stage: "thread", hr: null, reason: String(err?.message ?? err), target: described });
  }
}

parent.on("message", (event) => {
  const message = event?.data;
  if (!message || typeof message !== "object") {
    return;
  }
  try {
    if (message.type === "selftest") {
      selfTest(message.ownPid);
    } else if (message.type === "start") {
      start(message, event.ports?.[0] ?? null);
    } else if (message.type === "stop") {
      stopSession(message.sessionId);
    }
  } catch (err) {
    send({ type: "log", message: String(err?.message ?? err) });
  }
});

send({ type: "ready", available: loaded.addon !== null, reason: loaded.reason });
