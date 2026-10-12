/**
 * The tray menu, as data.
 *
 * Pure: takes the call state, the "keep in tray" preference and a translator,
 * returns a template `Menu.buildFromTemplate` accepts. Every `click` calls one
 * of the `actions`, so main.js owns what a click does and this file owns what
 * the menu says. The order is fixed on purpose: a muscle-memory menu that
 * reorders itself between "in a call" and "not in a call" is the thing people
 * hit Quit on by accident.
 *
 * @param {{ inCall: boolean, muted: boolean, deafened: boolean }} state
 * @param {{ keepInTray: boolean }} prefs
 * @param {(key: string, vars?: object) => string} t
 * @param {{ toggleMute(): void, toggleDeafen(): void, leave(): void, show(): void, setKeepInTray(value: boolean): void, quit(): void }} actions
 */
function buildTrayTemplate(state, prefs, t, actions) {
  const inCall = state.inCall === true;
  return [
    {
      label: inCall ? t("tray.inCall") : t("tray.idle"),
      enabled: false,
    },
    { type: "separator" },
    {
      label: state.muted ? t("tray.unmute") : t("tray.mute"),
      enabled: inCall,
      click: () => actions.toggleMute(),
    },
    {
      label: state.deafened ? t("tray.undeafen") : t("tray.deafen"),
      enabled: inCall,
      click: () => actions.toggleDeafen(),
    },
    {
      label: t("tray.leave"),
      enabled: inCall,
      click: () => actions.leave(),
    },
    { type: "separator" },
    {
      label: t("tray.show"),
      click: () => actions.show(),
    },
    {
      label: t("tray.keepInTray"),
      type: "checkbox",
      checked: prefs.keepInTray === true,
      click: (item) => actions.setKeepInTray(item.checked === true),
    },
    { type: "separator" },
    {
      label: t("tray.quit"),
      click: () => actions.quit(),
    },
  ];
}

/** The hover text: one line that says whether you are live. */
function trayTooltip(state, t) {
  if (!state.inCall) {
    return t("tray.tooltipIdle");
  }
  if (state.deafened) {
    return t("tray.tooltipDeafened");
  }
  if (state.muted) {
    return t("tray.tooltipMuted");
  }
  return t("tray.tooltipLive");
}

/**
 * Is a system tray likely to exist where we are, judged from the session name
 * alone?
 *
 * Only the fallback now: on Linux the shell asks the session bus whether a
 * tray host is there (`lib/tray-host.js`), and this guess is used when that
 * question cannot be asked at all (no `gdbus` and no `dbus-send`).
 *
 * Windows and macOS always have one. On Linux `new Tray()` does not throw on a
 * desktop with no tray host, it just draws nothing, and a window hidden "to the
 * tray" there cannot be got back. Stock GNOME ships no tray, so it counts as
 * none unless the session says it is Ubuntu (which ships the appindicator
 * extension).
 */
function trayLikelyAvailable(platform, env = process.env) {
  if (platform !== "linux") {
    return true;
  }
  const tokens = String(env.XDG_CURRENT_DESKTOP || "")
    .toLowerCase()
    .split(":")
    .filter(Boolean);
  return !(tokens.includes("gnome") && !tokens.includes("ubuntu"));
}

/**
 * What the close button does: `"hide"` to the tray, `"minimize"`, or
 * `"close"` like any window.
 *
 * Never anything but close while quitting or with the preference off. The app
 * wants to stay up during a call on any platform (quitting hangs up), and
 * while signed in on Windows and Linux only: that is where closing the last
 * window quits the app, and macOS keeps its own convention of living on in the
 * dock. `signedIn` unset (a renderer that predates the signal) counts as false.
 *
 * Staying up needs a tray to come back from. `trayAvailable: false` (Linux with
 * no tray host, or a tray that could not be created) never hides: during a
 * call the window is minimized instead, which keeps it in the taskbar or the
 * dash and keeps the call; out of a call it closes. Hiding there would leave
 * an app running with no window and no icon.
 */
function closeAction({
  inCall,
  keepInTray,
  quitting,
  signedIn,
  platform,
  trayAvailable,
}) {
  if (quitting === true || keepInTray !== true) {
    return "close";
  }
  const staysUp =
    inCall === true ||
    (signedIn === true && (platform === "win32" || platform === "linux"));
  if (!staysUp) {
    return "close";
  }
  if (trayAvailable === false) {
    return inCall === true ? "minimize" : "close";
  }
  return "hide";
}

/** Should the close button hide to the tray? `closeAction` says `"hide"`. */
function shouldHideToTray(input) {
  return closeAction(input) === "hide";
}

/** Narrow whatever the renderer sent to the three booleans the tray reads. */
function normalizeVoiceState(value) {
  const inCall = Boolean(value && value.inCall === true);
  return {
    inCall,
    muted: inCall && value.muted === true,
    deafened: inCall && value.deafened === true,
  };
}

module.exports = {
  buildTrayTemplate,
  trayTooltip,
  closeAction,
  shouldHideToTray,
  trayLikelyAvailable,
  normalizeVoiceState,
};
