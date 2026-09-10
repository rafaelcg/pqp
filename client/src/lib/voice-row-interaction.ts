/**
 * What a click, a double click, or a key on a channel row means, kept as pure
 * decisions so they can be pinned without a DOM.
 *
 * A CLICK ONLY EVER SELECTS. It shows the channel: its chat, and for a voice
 * room its stage. It never joins, however many times it lands and whether or
 * not the row was already the selected one. PR 360 shipped a "second tap on the
 * selected row joins" fallback as touch's stand-in for a double click, and in
 * practice that made one click plus one more click enter a call by accident.
 * Joining is a deliberate act and now takes a deliberate gesture.
 *
 * JOINING IS: a double click on the row, the Entrar button on a watch party,
 * the join item in the row's context menu, the call button in the channel
 * header (which is what a phone uses, and what iOS and Android have always
 * used), or Enter with the row focused.
 *
 * The double click no longer asks whether the row was selected. It used to,
 * because the click branch had already joined on the second click of the very
 * same gesture and firing again here would have joined twice. With the click
 * branch gone there is nothing to double up on.
 *
 * `joinable` is `isVoiceRowJoinable` at the call site: no join handler (a
 * text channel), a channel the caller is already in, or a *live* watch party
 * (the Watch pill already selects; a double-click that dropped you into the
 * call with your mic was the bug). Every branch here degrades to "select" or
 * "do nothing" — the same shape a plain text row has always had. Join on a
 * live party still lives on the header call button and the context menu.
 */
export type VoiceRowAction = "select" | "join" | null;

/**
 * Whether a double-click or Enter on this row should join the voice room.
 *
 * A live watch party is watched from the row, not joined. The Entrar button
 * (when the party is not live) and the header call button stay deliberate.
 */
export function isVoiceRowJoinable(options: {
  hasJoinHandler: boolean;
  connected: boolean;
  liveWatchParty?: boolean;
}): boolean {
  return (
    options.hasJoinHandler && !options.connected && !options.liveWatchParty
  );
}

export function resolveVoiceRowClick(_options: {
  selected: boolean;
  joinable: boolean;
}): VoiceRowAction {
  return "select";
}

export function resolveVoiceRowDoubleClick(options: {
  joinable: boolean;
}): VoiceRowAction {
  return options.joinable ? "join" : null;
}

export function resolveVoiceRowKey(
  key: string,
  options: { joinable: boolean },
): VoiceRowAction {
  if (key === "Enter") {
    return options.joinable ? "join" : "select";
  }
  if (key === " " || key === "Spacebar") {
    return "select";
  }
  return null;
}
