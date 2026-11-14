/** A count in a pill: the number, or "99+" past ninety-nine. */
export function formatBadgeCount(value: number): string {
  return value > 99 ? "99+" : String(value);
}
