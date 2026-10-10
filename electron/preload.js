const { contextBridge, ipcRenderer } = require("electron");

/**
 * Minimal, allowlisted bridge for the web client.
 * Do not expose ipcRenderer or Node APIs directly.
 */

/**
 * This build's version, handed over by main through `additionalArguments`.
 *
 * Null when the argument is absent, which is any window this preload is
 * attached to that main did not configure. Null is "unknown", never "old": the
 * capability booleans below are what the client decides anything on.
 */
function argvValue(prefix) {
  const argv = Array.isArray(process.argv) ? process.argv : [];
  for (const arg of argv) {
    if (typeof arg === "string" && arg.startsWith(prefix)) {
      return arg.slice(prefix.length).trim();
    }
  }
  return null;
}

function shellVersion() {
  return argvValue("--pqp-shell-version=") || null;
}

/**
 * Main parsed `os.release()` and handed us the answer. A sandboxed preload
 * cannot require `os` or `./lib/display-sources`. Missing on Windows is
 * fail-closed: an old argument list must not unlock the mixer.
 */
function canExcludeOwnAudioFromArg() {
  const value = argvValue("--pqp-can-exclude-own-audio=");
  if (value === "1") {
    return true;
  }
  if (value === "0") {
    return false;
  }
  return process.platform !== "win32";
}

/**
 * WHAT THIS SHELL CAN ACTUALLY DO WITH A SCREEN CAPTURE.
 *
 * One object instead of the next five `canDoThing: true` version flags, and it
 * exists because the web client had to GUESS two of these from
 * `process.platform`. Guessing worked while "desktop" meant one binary, and it
 * is exactly the reading that broke a watch party on this app: the page asked
 * for a browser-tab surface, because in a browser that is the clean audio path,
 * and this shell has no tab surfaces at all to satisfy it.
 *
 * Every field is a build-time fact about THIS binary, decided here rather than
 * inferred over there:
 *
 * - `displayMedia`: the main process answers `setDisplayMediaRequestHandler`
 *   with a real picker. Same signal as `canShareScreen`, which stays for the
 *   shells already installed that have no `capabilities` at all.
 * - `systemAudio`: `"loopback"` only where Chromium has a loopback device,
 *   which is WASAPI and therefore Windows. Everywhere else `"none"`, and the
 *   page must not ask for an audio track, because a display audio request the
 *   embedder cannot satisfy fails the WHOLE capture, video included.
 * - `restrictOwnAudio`: this Electron honours
 *   `getDisplayMedia({ audio: { restrictOwnAudio: true } })` by remapping
 *   Windows loopback to `loopbackWithoutChrome`, which is what keeps the call
 *   playing in this window out of the tap (the 23 Aug 2026 echo). True from
 *   Electron 43.4 on Windows 11 (NT build ≥ 22000). False on Windows 10:
 *   the remap cannot run and offering the mixer is the echo. package.json
 *   pins 44 and `lib/share-capabilities.test.mjs` fails if that pin ever
 *   drops below the version that honours the constraint.
 * - `pickerOffersAudio`: the picker window asks "share this computer's sound?"
 *   itself, so the page does not have to ask first. Off on Windows 10.
 *
 * `loopbackWithMute` is deliberately NOT used anywhere. It captures the same
 * tap and silences the machine's own output while it does, so the presenter
 * stops hearing both the call and the thing they are presenting. Excluding our
 * own output from the tap is `restrictOwnAudio`, and that is a different device.
 */
const canExcludeOwnAudio = canExcludeOwnAudioFromArg();

const SHARE_CAPABILITIES = Object.freeze({
  displayMedia: true,
  systemAudio:
    process.platform === "win32" && canExcludeOwnAudio ? "loopback" : "none",
  restrictOwnAudio: process.platform !== "win32" || canExcludeOwnAudio,
  pickerOffersAudio: process.platform === "win32" && canExcludeOwnAudio,
  /**
   * This binary can capture a share's sound itself, per process, through
   * WASAPI process loopback (`lib/win-share-audio*.js`): the shared window's
   * app, or everything but pqp for a screen. Windows 10 included, where the
   * Chromium path above cannot keep the call out. A SEPARATE field from
   * `systemAudio`, because the sound does not arrive on the display stream:
   * the page asks Chromium for none and receives PCM on a port instead, so a
   * client that does not know this field must never be told "loopback".
   * Whether the add-on loaded and this Windows build can open the stream is
   * `nativeShareAudioStatus()`; whether it is ON is the runtime flag's.
   */
  nativeShareAudio: process.platform === "win32",
  /**
   * This binary can build the Linux "everything but pqp" bus
   * (`lib/linux-share-audio.js`) and hand its source to the page by name.
   * A SEPARATE field, never `systemAudio: "loopback"`: every client already
   * deployed reads that one as "ask for audio and it arrives on the display
   * stream", and on Linux it would not (it arrives on a second capture only
   * the new client opens). Whether it is ON is the runtime flag's business,
   * and whether this machine has `pactl` is `linuxShareAudioStatus()`'s.
   */
  linuxShareAudio: process.platform === "linux",
  /**
   * This binary can answer `fullscreenAppState()`: whether Windows says a
   * Direct3D app holds the display in exclusive fullscreen
   * (`SHQueryUserNotificationState`, `lib/fullscreen-state.js`). The page's
   * dead-share card (`share_game_capture_hint`) never shows without it.
   */
  fullscreenAppState: process.platform === "win32",
  version: shellVersion(),
});

/**
 * PCM ports from main, by session, until the page's `claim` collects them.
 * The port and the `invoke` answer travel separately and may arrive in either
 * order, so whichever comes second completes the handshake.
 */
const shareAudioPorts = new Map();
const shareAudioWaiters = new Map();
const SHARE_AUDIO_PORT_WAIT_MS = 3000;

ipcRenderer.on("pqp:native-share-audio-port", (event, payload) => {
  const port = event.ports?.[0];
  const sessionId = typeof payload?.sessionId === "string" ? payload.sessionId : null;
  if (!port || !sessionId) {
    return;
  }
  const waiter = shareAudioWaiters.get(sessionId);
  if (waiter) {
    shareAudioWaiters.delete(sessionId);
    waiter(port);
    return;
  }
  // One share at a time: a port nobody claimed belongs to a share that is over.
  for (const stale of shareAudioPorts.values()) {
    stale.close();
  }
  shareAudioPorts.clear();
  shareAudioPorts.set(sessionId, port);
});

function waitForShareAudioPort(sessionId) {
  const ready = shareAudioPorts.get(sessionId);
  if (ready) {
    shareAudioPorts.delete(sessionId);
    return Promise.resolve(ready);
  }
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      shareAudioWaiters.delete(sessionId);
      resolve(null);
    }, SHARE_AUDIO_PORT_WAIT_MS);
    shareAudioWaiters.set(sessionId, (port) => {
      clearTimeout(timer);
      resolve(port);
    });
  });
}

contextBridge.exposeInMainWorld("pqpDesktop", {
  platform: process.platform,
  isElectron: true,
  /** True when the shell uses a custom in-app title / drag region (macOS hiddenInset). */
  hasCustomTitleBar: process.platform === "darwin",

  /**
   * This shell answers `setDisplayMediaRequestHandler` (see main.js).
   *
   * A VERSION SIGNAL, not a feature toggle — nothing reads it to decide what
   * to do, only to explain what went wrong. `getDisplayMedia` exists in every
   * Electron renderer, so the client's capability probe passes and the share
   * button is shown; without the handler in the main process the call then
   * rejects with `NotSupportedError`, which the client used to report as
   * "screen sharing isn't supported in the app". That is false, and it is the
   * exact wording a user hit on 23 Aug 2026 while running v0.1.0.
   *
   * Shells built before the handler landed simply do not define this key, so
   * `undefined` means "too old" and the client can say "update the app"
   * instead of "this is impossible". Do not remove it once the last old build
   * is gone: absence is the whole signal.
   */
  canShareScreen: true,

  /**
   * This shell's share picker asks "share this computer's audio?" itself.
   *
   * Same kind of version signal as `canShareScreen`. The hosted client runs
   * inside older binaries: without this key the page must not request audio
   * unless the person already opted in, because those pickers treat
   * `audioRequested` as the whole switch and would loop back every share.
   */
  sharePickerOffersAudio: true,

  /**
   * What a screen capture in this shell can do. See `SHARE_CAPABILITIES`.
   *
   * Absent in every shell built before this one, which is why the two flags
   * above it stay: the hosted client runs inside binaries this repo shipped
   * weeks ago and has to keep reading them.
   */
  capabilities: SHARE_CAPABILITIES,

  /**
   * `share_high_motion_guard`: a screen share is live (true) or over (false).
   * While live, on Windows, the shell raises the priority of the processes
   * that capture, encode and carry it by one notch and puts them back when
   * this says false, the page reloads or the window's renderer dies. The page
   * only calls it with the runtime flag on. Resolves
   * `{ live, boost, processes }`; `boost` is `unsupported` off Windows.
   */
  setShareLive(live) {
    return ipcRenderer.invoke("pqp:share-live", live === true);
  },

  /**
   * What the shell knows about this machine's share pipeline, for
   * `pqpShareHealth()` in the console: Chromium's GPU feature status (is video
   * encode hardware), the priority boost and the versions.
   */
  shareHealth() {
    return ipcRenderer.invoke("pqp:share-health");
  },

  /**
   * `share_game_capture_hint`: is a Direct3D app in exclusive fullscreen right
   * now, by Windows' own account? Resolves
   * `{ state, raw, exclusiveFullscreen }`; `exclusiveFullscreen` is null when
   * the shell cannot tell. Asked by the page only when a share looks dead.
   */
  fullscreenAppState() {
    return ipcRenderer.invoke("pqp:fullscreen-app-state");
  },

  /**
   * Native share audio (Windows, `capabilities.nativeShareAudio`). Can this
   * machine do it: add-on loaded, and this Windows build opened a process
   * loopback stream when asked. `{ available, reason, stage, hr, build }`.
   */
  nativeShareAudioStatus() {
    return ipcRenderer.invoke("pqp:native-share-audio-status");
  },

  /**
   * The next share's picker offers the sound box and, if it is ticked,
   * captures natively. Call right before `getDisplayMedia({ audio: false })`.
   */
  nativeShareAudioArm() {
    return ipcRenderer.invoke("pqp:native-share-audio-arm");
  },

  /**
   * After `getDisplayMedia` resolved: did the share start a capture? When it
   * did, its PCM port is posted to this window as a `message` event,
   * `{ type: "pqp:native-share-audio-port", sessionId }` with the port in
   * `ports[0]`, before this resolves. A port cannot cross the context bridge
   * as a value, and `window.postMessage` to this same window is how Electron
   * documents handing one to the page. Resolves
   * `{ active, sessionId?, target?, reason?, stage?, hr? }`.
   */
  nativeShareAudioClaim() {
    return ipcRenderer.invoke("pqp:native-share-audio-claim").then(async (outcome) => {
      if (!outcome || outcome.active !== true || typeof outcome.sessionId !== "string") {
        return outcome ?? { active: false, reason: "none" };
      }
      const port = await waitForShareAudioPort(outcome.sessionId);
      if (!port) {
        ipcRenderer.invoke("pqp:native-share-audio-stop", outcome.sessionId).catch(() => {});
        return { active: false, reason: "port-timeout" };
      }
      // "*" names no other window: the recipient is this one, the page itself.
      // `globalThis` is that window here; a preload has no `window` binding
      // this file's lint environment knows about.
      globalThis.postMessage(
        { type: "pqp:native-share-audio-port", sessionId: outcome.sessionId },
        "*",
        [port],
      );
      return outcome;
    });
  },

  /**
   * The share is over: stop capturing. With the claim's `sessionId`, only
   * that capture, so ending an old share cannot stop a newer one. Safe to
   * call when nothing runs.
   */
  nativeShareAudioStop(sessionId) {
    return ipcRenderer.invoke(
      "pqp:native-share-audio-stop",
      typeof sessionId === "string" ? sessionId : null,
    );
  },

  /**
   * The native capture ended on its own (the stream failed, the device went
   * away, the audio process died). The shell has already closed its end; this
   * is how the page learns to stop its track and free its audio graph.
   * `callback({ sessionId, reason })`; returns the unsubscribe.
   */
  onNativeShareAudioEnded(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, payload) => {
      if (payload && typeof payload.sessionId === "string") {
        callback({
          sessionId: payload.sessionId,
          reason: typeof payload.reason === "string" ? payload.reason : "ended",
        });
      }
    };
    ipcRenderer.on("pqp:native-share-audio-ended", handler);
    return () => {
      ipcRenderer.removeListener("pqp:native-share-audio-ended", handler);
    };
  },

  /**
   * Linux share audio: can this machine build the bus at all (`pactl` on
   * PATH, a PulseAudio or PipeWire server answering)? Resolves
   * `{ available, server }`, and `available: false` off Linux.
   */
  linuxShareAudioStatus() {
    return ipcRenderer.invoke("pqp:linux-share-audio-status");
  },

  /**
   * Right before a `getDisplayMedia` the page has asked the person about (flag
   * on, "share this computer's audio?" answered yes): the shell may build the
   * bus for the NEXT display request only. Without it a request that happens to
   * carry `audioRequested` builds nothing. Resolves `true` when armed.
   */
  linuxShareAudioArm() {
    return ipcRenderer.invoke("pqp:linux-share-audio-arm");
  },

  /**
   * After `getDisplayMedia` resolved: is this share's bus up, and under which
   * device label will `enumerateDevices` list its capture source?
   * Resolves `{ active, label }`.
   */
  linuxShareAudioClaim() {
    return ipcRenderer.invoke("pqp:linux-share-audio-claim");
  },

  /**
   * What the live (or last) Linux share did with every playback stream it
   * saw: app name, binary, process ids, whether it is pqp's, and the outcome
   * (linked, moved, refused with the sound server's words, kept out). Null off
   * Linux and before any share. Reads nothing from the sound server.
   */
  linuxShareAudioDiagnostics() {
    return ipcRenderer.invoke("pqp:linux-share-audio-diagnostics");
  },

  /** Subscribe to Cmd/Ctrl+Shift+M mute toggle from the app menu. */
  onToggleMute(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = () => {
      callback();
    };
    ipcRenderer.on("pqp:toggle-mute", handler);
    return () => {
      ipcRenderer.removeListener("pqp:toggle-mute", handler);
    };
  },

  /** Subscribe to Cmd/Ctrl+Shift+D deafen toggle from the app menu. */
  onToggleDeafen(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = () => {
      callback();
    };
    ipcRenderer.on("pqp:toggle-deafen", handler);
    return () => {
      ipcRenderer.removeListener("pqp:toggle-deafen", handler);
    };
  },

  /**
   * Subscribe to deep-link navigations.
   * Payload is an in-app path under `/app` (not a raw `pqp://` URL).
   */
  onDeepLink(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, appPath) => {
      callback(appPath);
    };
    ipcRenderer.on("pqp:deep-link", handler);
    return () => {
      ipcRenderer.removeListener("pqp:deep-link", handler);
    };
  },

  getPendingDeepLink() {
    return ipcRenderer.invoke("pqp:get-pending-deep-link");
  },

  /**
   * Desktop auth IPC. Main refuses these unless `event.senderFrame`
   * is the app origin (`lib/ipc-origin.js`). Game-connection hosts
   * reuse this preload while they navigate in-window.
   */
  startDesktopAuth(mode) {
    return ipcRenderer.invoke(
      "pqp:start-desktop-auth",
      mode === "sign-up" ? "sign-up" : "sign-in",
    );
  },

  cancelDesktopAuth() {
    return ipcRenderer.invoke("pqp:cancel-desktop-auth");
  },

  getDesktopAuthStatus() {
    return ipcRenderer.invoke("pqp:desktop-auth-status");
  },

  getPendingDesktopAuthTicket() {
    return ipcRenderer.invoke("pqp:get-pending-desktop-auth-ticket");
  },

  onDesktopAuthTicket(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, ticket) => {
      callback(ticket);
    };
    ipcRenderer.on("pqp:desktop-auth-ticket", handler);
    return () => {
      ipcRenderer.removeListener("pqp:desktop-auth-ticket", handler);
    };
  },

  onDesktopAuthEnded(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, reason) => {
      callback(reason === "expired" ? "expired" : "cancelled");
    };
    ipcRenderer.on("pqp:desktop-auth-ended", handler);
    return () => {
      ipcRenderer.removeListener("pqp:desktop-auth-ended", handler);
    };
  },

  /**
   * Mirror the resolved theme into the main process, which cannot read the
   * renderer's localStorage but has to paint the window background before the
   * renderer loads on the next launch.
   */
  setTheme(theme) {
    if (theme !== "dark" && theme !== "light") {
      return;
    }
    ipcRenderer.send("pqp:set-theme", theme);
  },

  setLocale(locale) {
    if (locale !== "en" && locale !== "pt-BR" && locale !== "es") {
      return Promise.resolve(null);
    }
    return ipcRenderer.invoke("pqp:set-locale", locale);
  },

  /**
   * Launch at login. macOS and Windows only (Electron has no Linux
   * implementation); the main process answers `false` to both on Linux
   * rather than pretending the toggle did something.
   */
  getStartAtLogin() {
    return ipcRenderer.invoke("pqp:get-start-at-login");
  },

  setStartAtLogin(value) {
    return ipcRenderer.invoke("pqp:set-start-at-login", value === true);
  },

  /** Dock / taskbar mention count. Zero clears it. */
  setBadgeCount(count) {
    if (!Number.isFinite(count)) {
      return;
    }
    ipcRenderer.send("pqp:set-badge", Math.max(0, Math.floor(count)));
  },

  /**
   * Notify from the main process rather than the renderer: only it can raise
   * the window from behind another application when the user clicks.
   */
  notify(payload) {
    if (!payload || typeof payload.title !== "string") {
      return;
    }
    ipcRenderer.send("pqp:notify", {
      title: payload.title,
      body: typeof payload.body === "string" ? payload.body : "",
      tag: typeof payload.tag === "string" ? payload.tag : "",
      path: typeof payload.path === "string" ? payload.path : "/app",
      // true: the app plays its own cue, keep the banner silent. false: app
      // sounds are off, let the OS sound play. Absent: older renderer, silent.
      ...(typeof payload.silent === "boolean" ? { silent: payload.silent } : {}),
    });
  },

  /** Subscribe to notification clicks; the payload is an in-app `/app` path. */
  onNotificationClick(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, appPath) => {
      callback(appPath);
    };
    ipcRenderer.on("pqp:notification-click", handler);
    return () => {
      ipcRenderer.removeListener("pqp:notification-click", handler);
    };
  },

  /**
   * Global push-to-talk. The renderer hands over an Electron accelerator (or
   * null to let go) and the main process registers it with `globalShortcut`
   * whenever this window is not focused. Resolves with whether the OS took
   * the registration. Main validates the string; this only types it.
   */
  bindPushToTalk(accelerator) {
    if (accelerator !== null && typeof accelerator !== "string") {
      return Promise.resolve(false);
    }
    return ipcRenderer.invoke("pqp:ptt-bind", accelerator);
  },

  /** Presses and releases of the global push-to-talk key. */
  onPushToTalk(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, held) => {
      callback(held === true);
    };
    ipcRenderer.on("pqp:ptt-held", handler);
    return () => {
      ipcRenderer.removeListener("pqp:ptt-held", handler);
    };
  },

  /**
   * Tier 2 push-to-talk: a native global keyboard/mouse hook, with the
   * `globalShortcut` fallback handled inside main for us (see
   * `setNativePushToTalkBinding` / `syncNativePushToTalk` in `main.js`).
   * `null` releases the binding. Main validates the shape; this only types
   * it and refuses an obviously wrong call before it crosses the bridge.
   */
  bindPushToTalkNative(binding, releaseDelayMs) {
    if (binding !== null && typeof binding !== "object") {
      return Promise.resolve({ registered: false, via: "none" });
    }
    if (typeof releaseDelayMs !== "number") {
      return Promise.resolve({ registered: false, via: "none" });
    }
    return ipcRenderer.invoke("pqp:ptt-bind-native", binding, releaseDelayMs);
  },

  /** Presses and releases of the native-path push-to-talk binding. */
  onPushToTalkNative(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, held) => {
      callback(held === true);
    };
    ipcRenderer.on("pqp:ptt-held-native", handler);
    return () => {
      ipcRenderer.removeListener("pqp:ptt-held-native", handler);
    };
  },

  /** macOS Accessibility permission status, a proxy for the hook working; see `main.js`. */
  getPttPermissionStatus() {
    return ipcRenderer.invoke("pqp:ptt-permission-status");
  },

  /** Opens the macOS Accessibility and Input Monitoring panes. No-op elsewhere. */
  openPttPermissionSettings() {
    ipcRenderer.send("pqp:ptt-open-permission-settings");
  },

  /** Whether this platform can run the native hook at all (binds nothing). */
  getPttNativeCapability() {
    return ipcRenderer.invoke("pqp:ptt-native-capability");
  },

  /**
   * Global mute/deafen toggle hotkeys. Same idea as `bindPushToTalk`, two
   * accelerators at once: the renderer hands over the current toggle-mute
   * and toggle-deafen accelerators (or `null` to let one go) and the main
   * process registers each with `globalShortcut` while the window is not
   * focused. Resolves with which of the two the OS actually took. On fire,
   * the main process sends the same `pqp:voice-command` the tray menu uses,
   * so there is one handler for "mute got toggled from outside the window".
   */
  bindGlobalVoiceHotkeys(accelerators) {
    const toggleMute =
      accelerators && typeof accelerators.toggleMute === "string"
        ? accelerators.toggleMute
        : null;
    const toggleDeafen =
      accelerators && typeof accelerators.toggleDeafen === "string"
        ? accelerators.toggleDeafen
        : null;
    return ipcRenderer.invoke("pqp:global-voice-bind", {
      toggleMute,
      toggleDeafen,
    });
  },

  /** Call state for the tray icon and menu. */
  setVoiceState(state) {
    if (!state || typeof state !== "object") {
      return;
    }
    ipcRenderer.send("pqp:voice-state", {
      inCall: state.inCall === true,
      muted: state.muted === true,
      deafened: state.deafened === true,
    });
  },

  /**
   * Whether somebody is signed in. On Windows and Linux the close button hides
   * to the tray while this is true, and closes as it always did while it is
   * not. Never sent means false.
   */
  setSignedIn(signedIn) {
    ipcRenderer.send("pqp:signed-in", signedIn === true);
  },

  /** Mute, deafen and leave from the tray menu. */
  onVoiceCommand(callback) {
    if (typeof callback !== "function") {
      return () => {};
    }
    const handler = (_event, command) => {
      if (
        command === "toggleMute" ||
        command === "toggleDeafen" ||
        command === "leave"
      ) {
        callback(command);
      }
    };
    ipcRenderer.on("pqp:voice-command", handler);
    return () => {
      ipcRenderer.removeListener("pqp:voice-command", handler);
    };
  },
});
