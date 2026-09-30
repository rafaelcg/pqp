import { useEffect, useState } from "react";
import { fetchCommunityConfig } from "@/lib/api";

/**
 * Whether this deployment has the communities directory turned on, as the
 * SERVER says it (`GET /api/communities/config`, `COMMUNITIES_ENABLED`).
 *
 * The landing page's "Find a room" band, and the two links that point at it,
 * advertise a directory. A directory that does not exist on an instance (the
 * flag is off by default, and every self-host starts there) must not be
 * advertised, and the client must not guess the answer from a build variable:
 * it asks.
 *
 * FAILS CLOSED. Anything but a clean `enabled: true` is "no": a network blip,
 * a 404 from an older server, a malformed body, and, worth knowing, a 401.
 * That endpoint sits behind sign-in like every other `/api` route (CLAUDE.md
 * pitfall 8 says there is no public-route allowlist), so a signed-out visitor
 * gets 401 today and the band stays hidden for them until the server answers
 * that one read without an account. The hook needs no change when it does.
 *
 * One request per page load, shared by every caller: the landing, the header
 * and the footer all ask, and a miss is remembered too, so a failing endpoint
 * is not retried by each of them.
 */
let probe: Promise<boolean> | null = null;

function communitiesEnabled(): Promise<boolean> {
  probe ??= fetchCommunityConfig()
    .then((config) => config.enabled === true)
    .catch(() => false);
  return probe;
}

export function useCommunitiesEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    void communitiesEnabled().then((answer) => {
      if (live) setEnabled(answer);
    });
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
