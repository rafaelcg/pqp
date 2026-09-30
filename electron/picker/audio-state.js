/**
 * What the share picker's sound row shows, as plain data.
 *
 * Pure on purpose, and loaded two ways: the picker page takes it as a script
 * (`window.pqpPickerAudio`; no bundler, no imports, see `picker.js`) and the
 * tests `require` it, so the decisions below run under `node --test` without
 * a window.
 *
 * `audioState` comes from main (`pickerAudioState` in `lib/display-sources.js`):
 *
 *   "hidden"    macOS and Linux: there is no sound to offer. Nothing is drawn.
 *   "checkbox"  a real choice: the switch is drawn, ON by default.
 *   "explain"   Windows 10 without the native capture: the choice would be a
 *               lie, so the row explains instead and has no switch.
 *
 * WHY ON BY DEFAULT. A missed box was a silent share and "(no sound)" on the
 * viewers' stage, and the box is small enough to miss. The row is prominent
 * and starts on; turning it off is one click, is honoured for that share only
 * (a new picker starts on again), and says out loud what it means.
 *
 * NOTHING STARTS HERE. A switch that is on is a value the page holds until
 * "Share" is pressed: `choose(sourceId, shareAudio)` is the only call that
 * leaves this window with it, and main starts no capture before it arrives.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) {
    module.exports = api;
  } else {
    root.pqpPickerAudio = api;
  }
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  /** The state the switch starts in, every time the picker opens. */
  function defaultAudioChecked(audioState) {
    return audioState === "checkbox";
  }

  /**
   * The row for `audioState` with the switch at `checked`.
   *
   * `note` is what the choice MEANS right now and is only set for a switch that
   * is off: a missed box was the whole problem, so the off state says what the
   * viewers will get instead of leaving it to be discovered on their stage.
   */
  function audioRowView(audioState, checked, strings) {
    if (audioState === "checkbox") {
      const on = checked === true;
      return {
        visible: true,
        hasSwitch: true,
        checked: on,
        label: strings.shareAudio,
        hint: strings.shareAudioHint,
        note: on ? "" : strings.shareAudioOffNote,
        icon: on ? "on" : "off",
      };
    }
    if (audioState === "explain") {
      return {
        visible: true,
        hasSwitch: false,
        checked: false,
        label: strings.shareAudioWin10,
        hint: strings.shareAudioWin10Hint,
        note: "",
        icon: "off",
      };
    }
    return {
      visible: false,
      hasSwitch: false,
      checked: false,
      label: "",
      hint: "",
      note: "",
      icon: "off",
    };
  }

  return { defaultAudioChecked, audioRowView };
});
