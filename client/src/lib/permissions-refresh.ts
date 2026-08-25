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

/**
 * A failed refetch of the same server must keep the last snapshot. Zeroing
 * would strip send and manage UI until the next ping. A failed first load,
 * or a failed load after switching servers, still wipes: there is nothing
 * honest to show for that serverId.
 */
export function shouldWipePermissionsOnFetchFailure(
  heldServerId: string | null,
  requestedServerId: string | null,
): boolean {
  return heldServerId !== requestedServerId;
}
