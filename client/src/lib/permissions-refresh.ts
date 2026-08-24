/**
 * A permissions-update frame is applied only when it is newer than the
 * snapshot we already hold. Missing version means "refetch anyway".
 */
export function shouldApplyPermissionsVersion(
  held: number,
  incoming: number | undefined,
): boolean {
  return incoming === undefined || incoming > held;
}
