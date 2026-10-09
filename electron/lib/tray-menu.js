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
 * Is a system tray likely to exist where we are?
 *
 * Windows and macOS always have one. On Linux `new Tray()` does not throw on a
 * desktop with no tray host, it just draws nothing, and a window hidden "to the
 * tray" there cannot be got back. Stock GNOME ships no tray, so it counts as
 * none unless the session says it is Ubuntu (which ships the appindicator
 * extension). A GNOME with the extension added by hand loses only the
 * signed-in hide, never anything it had before.
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
 * Should the close button hide to the tray instead of closing?
 *
 * Never while quitting, never with the preference off. During a call on any
 * platform (quitting hangs up). While signed in, on Windows and Linux only:
 * that is where closing the last window quits the app, and macOS keeps its
 * own convention of living on in the dock. Linux additionally needs a tray
 * that can be seen, or the window would be hidden with no way back.
 * `signedIn` unset (a renderer that predates the signal) counts as false.
 */
function shouldHideToTray({
  inCall,
  keepInTray,
  quitting,
  signedIn,
  platform,
  trayAvailable,
}) {
  if (quitting === true || keepInTray !== true) {
    return false;
  }
  if (inCall === true) {
    return true;
  }
  if (signedIn !== true) {
    return false;
  }
  if (platform === "win32") {
    return true;
  }
  return platform === "linux" && trayAvailable !== false;
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
  shouldHideToTray,
  trayLikelyAvailable,
  normalizeVoiceState,
};
