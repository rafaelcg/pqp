/**
 * Names on the collapsed call strip.
 *
 * The channel name already lives in the header. This line is the people in
 * the call: one or two names, or a count past that.
 */
export function collapsedPeopleLabel(
  names: readonly string[],
  inCall: (count: number) => string,
): string {
  const present = names.filter((name) => name.trim().length > 0);
  if (present.length === 0) {
    return "";
  }
  if (present.length <= 2) {
    return present.join(", ");
  }
  return inCall(present.length);
}

/**
 * What the line actually prints. Once the room is connected and there is
 * somebody to name, the names win over any status line still hanging about
 * ("Connecting…" outliving the join). The one exception is an outgoing ring:
 * "Calling…" is a connected-room status, and the only name it would replace
 * is our own. Before that, the status speaks, and the names are the fallback.
 */
export function collapsedPeopleLine({
  connected,
  callingOut,
  statusLine,
  peopleLabel,
}: {
  connected: boolean;
  callingOut: boolean;
  statusLine: string | null;
  peopleLabel: string;
}): string {
  if (connected && !callingOut && peopleLabel.length > 0) {
    return peopleLabel;
  }
  return statusLine ?? peopleLabel;
}
