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
 * Should the close button hide to the tray instead of closing?
 * Only during a call, only when the preference is on, never while quitting.
 */
function shouldHideToTray({ inCall, keepInTray, quitting }) {
  return quitting !== true && inCall === true && keepInTray === true;
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
  normalizeVoiceState,
};
