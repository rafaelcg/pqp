/**
 * Which ICE servers an SFU (LiveKit) connection is handed, if any.
 *
 * The LiveKit server sends its own ICE list in the join response, and every
 * client used to take that list and nothing else. On the hosted deployment
 * that list is the media box's built-in TURN (UDP on the box itself, and a TLS
 * relay on a port Caddy owns, so dead), while `/api/ice-servers` carries the
 * relays the product actually pays for (Cloudflare first, then Metered, then
 * the static fallback). The mesh path has used that list all along; the SFU
 * path never saw it.
 *
 * Handing the app's list to the SDK is a REPLACEMENT on the web: livekit-client
 * 2.21.0 applies the server's servers only when `rtcConfig.iceServers` is
 * absent (`RTCEngine.makeRTCConfiguration`). So a list without a relay would
 * be strictly worse than today, which is why this returns `undefined`, meaning
 * "pass nothing, keep the server's list", unless the list carries at least one
 * TURN entry. The default STUN-only list in `peer-connection-manager.ts`, an
 * empty list, and a failed fetch all fall in that bucket.
 */
export function sfuIceServers(
  servers: readonly RTCIceServer[] | null | undefined,
): RTCIceServer[] | undefined {
  if (!servers || servers.length === 0) {
    return undefined;
  }
  const hasRelay = servers.some((server) =>
    urlsOf(server).some(isTurnUrl),
  );
  return hasRelay ? [...servers] : undefined;
}

function urlsOf(server: RTCIceServer): string[] {
  const { urls } = server;
  if (typeof urls === "string") {
    return [urls];
  }
  return Array.isArray(urls) ? urls : [];
}

function isTurnUrl(url: string): boolean {
  const scheme = url.trim().toLowerCase();
  return scheme.startsWith("turn:") || scheme.startsWith("turns:");
}
