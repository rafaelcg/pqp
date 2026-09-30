import { useEffect, useState } from "react";
import { getApiBaseUrl } from "@/lib/utils";

/**
 * Whether this deployment has the communities directory turned on, as the
 * SERVER says it: `GET /api/public/communities/config` answering
 * `{ "enabled": boolean }` with no auth (`COMMUNITIES_ENABLED`).
 *
 * The landing's "Find a room" band, and the header and footer links to it,
 * advertise a directory. An instance without one (the flag is off by default,
 * every self-host starts there) must not advertise it, and the client must not
 * guess from a build variable: it asks. The authenticated twin
 * `/api/communities/config` is deliberately NOT used: a signed-out visitor,
 * which is who a landing page is for, gets 401 from it.
 *
 * FAILS CLOSED, BUT NOT FOREVER. Anything but a clean 200 with
 * `enabled: true` is "hidden": an older API that has no such route (401 or
 * 404), a network error, a malformed body. A failure is never cached for the
 * page load, though: it is only remembered for `RETRY_AFTER_MS`, so a blip does
 * not hide the band until the next full reload, and the next mount after that
 * window asks again. A success (true or false) is cached, and every caller (the
 * landing, the header, the footer) shares one request.
 */
export const RETRY_AFTER_MS = 5_000;

let answer: boolean | null = null;
let inflight: Promise<boolean> | null = null;
let failedAt = 0;

export function resetCommunitiesProbe(): void {
  answer = null;
  inflight = null;
  failedAt = 0;
}

async function ask(): Promise<boolean> {
  try {
    const response = await fetch(
      `${getApiBaseUrl()}/api/public/communities/config`,
      { headers: { accept: "application/json" } },
    );
    if (response.status !== 200) throw new Error(`status ${response.status}`);
    const body = (await response.json()) as { enabled?: unknown };
    if (typeof body.enabled !== "boolean") throw new Error("malformed");
    answer = body.enabled;
    failedAt = 0;
    return answer;
  } catch {
    failedAt = Date.now();
    return false;
  }
}

export function probeCommunitiesEnabled(): Promise<boolean> {
  if (answer !== null) return Promise.resolve(answer);
  if (inflight) return inflight;
  if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) {
    return Promise.resolve(false);
  }
  inflight = ask().finally(() => {
    inflight = null;
  });
  return inflight;
}

export function useCommunitiesEnabled(): boolean {
  const [enabled, setEnabled] = useState(answer === true);
  useEffect(() => {
    let live = true;
    void probeCommunitiesEnabled().then((value) => {
      if (live) setEnabled(value);
    });
    return () => {
      live = false;
    };
  }, []);
  return enabled;
}
