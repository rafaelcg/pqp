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
