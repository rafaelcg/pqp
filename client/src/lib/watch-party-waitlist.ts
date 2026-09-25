import { useEffect, useState } from "react";
import type {
  JoinWatchPartyWaitlistRequest,
  WatchPartyWaitlistApproval,
  WatchPartyWaitlistEntry,
  WatchPartyWaitlistState,
} from "@pqp/shared";
import { apiFetch } from "@/lib/api";

/**
 * The watch party waitlist, client side. See `docs/WATCH_PARTY.md`
 * §"The waitlist".
 *
 * WHERE IT SHOWS, AND WHERE IT NEVER DOES. The sidebar's teaser is drawn only
 * when `GET /api/live-hls/config?serverId=` has answered `enabled: false` for
 * the open server (`shouldOfferWatchPartyTeaser`). A server that runs watch
 * parties answers `true` and gets exactly the create control it had before;
 * an unanswered config is `null` and gets nothing, the same fail-closed rule
 * `canOfferWatchPartyCreate` follows. So nothing here can appear on a server
 * where a party can run, which is the one property that matters the night
 * before a big one.
 */

export const fetchWatchPartyWaitlist = (serverId: string | null) =>
  apiFetch<WatchPartyWaitlistState>(
    serverId
      ? `/api/watch-party/waitlist?serverId=${encodeURIComponent(serverId)}`
      : "/api/watch-party/waitlist",
  );

export const joinWatchPartyWaitlist = (body: JoinWatchPartyWaitlistRequest) =>
  apiFetch<{ entry: WatchPartyWaitlistEntry }>("/api/watch-party/waitlist", {
    method: "POST",
    body: JSON.stringify(body),
  });

export const fetchWatchPartyApprovals = () =>
  apiFetch<{ approvals: WatchPartyWaitlistApproval[] }>(
    "/api/watch-party/waitlist/approvals",
  );

export const ackWatchPartyApproval = (serverId: string) =>
  apiFetch<{ ok: true }>("/api/watch-party/waitlist/approvals/ack", {
    method: "POST",
    body: JSON.stringify({ serverId }),
  });

/**
 * Whether the sidebar shows the teaser for this server. `hlsEnabled` is the
 * live-hls config answer, and only an explicit `false` counts: `true` means
 * the real control is there, `null` means nobody has answered yet.
 */
export function shouldOfferWatchPartyTeaser({
  hlsEnabled,
  state,
}: {
  hlsEnabled: boolean | null;
  state: WatchPartyWaitlistState | null;
}): boolean {
  return (
    hlsEnabled === false &&
    state !== null &&
    state.campaign &&
    !state.available
  );
}

// ------------------------------------------------------------ the store

/**
 * One answer per server for the page's lifetime, shared by the sidebar and
 * the dialog, so joining in the dialog turns the sidebar's badge into "Na
 * lista" without a refetch. Key `""` is the serverless row.
 */
const answers = new Map<string, WatchPartyWaitlistState>();
const inflight = new Map<string, Promise<WatchPartyWaitlistState>>();
/** Servers whose last read failed, so the dialog can say so and retry. */
const failures = new Set<string>();
const listeners = new Set<() => void>();
/**
 * Bumped by every reset. An answer that arrives for an older generation is
 * dropped, so a read started by the previous account can never land in the
 * next one's cache (these rows are the caller's own: a note, a channel).
 */
let generation = 0;
/** Whose answers these are. Changing it empties the store. */
let owner: string | null = null;

function keyOf(serverId: string | null): string {
  return serverId ?? "";
}

function notify(): void {
  for (const listener of listeners) {
    listener();
  }
}

export function loadWatchPartyWaitlist(
  serverId: string | null,
): Promise<WatchPartyWaitlistState> {
  const key = keyOf(serverId);
  const cached = answers.get(key);
  if (cached) {
    return Promise.resolve(cached);
  }
  let pending = inflight.get(key);
  if (!pending) {
    const started = generation;
    pending = fetchWatchPartyWaitlist(serverId).then(
      (answer) => {
        if (started === generation) {
          answers.set(key, answer);
          failures.delete(key);
          inflight.delete(key);
          notify();
        }
        return answer;
      },
      (error: unknown) => {
        if (started === generation) {
          inflight.delete(key);
          failures.add(key);
          notify();
        }
        throw error;
      },
    );
    inflight.set(key, pending);
  }
  return pending;
}

/** The last read for this server failed and nothing has answered since. */
export function watchPartyWaitlistFailed(serverId: string | null): boolean {
  return failures.has(keyOf(serverId));
}

/** Ask again after a failure (the dialog's "Tentar de novo"). */
export function retryWatchPartyWaitlist(serverId: string | null): void {
  failures.delete(keyOf(serverId));
  notify();
  void loadWatchPartyWaitlist(serverId).catch(() => {});
}

/**
 * The signed-in account, told by `App`. A different one empties the store:
 * a sign-out and sign-in in the same page must not hand the second person
 * the first one's cached rows.
 */
export function setWatchPartyWaitlistOwner(userId: string | null): void {
  if (userId === owner) {
    return;
  }
  owner = userId;
  resetWatchPartyWaitlistStore();
}

/** The dialog's submit landed: store the row it answered with. */
export function rememberWatchPartyWaitlistEntry(
  serverId: string | null,
  entry: WatchPartyWaitlistEntry,
): void {
  const key = keyOf(serverId);
  const current = answers.get(key);
  answers.set(key, {
    campaign: current?.campaign ?? true,
    canRequest: current?.canRequest ?? false,
    available: current?.available ?? false,
    entry,
  });
  notify();
}

/** Forget a server's answer, so the next read asks again (an approval landed). */
export function forgetWatchPartyWaitlist(serverId: string | null): void {
  answers.delete(keyOf(serverId));
  notify();
}

/** Test seam. */
export function resetWatchPartyWaitlistStore(): void {
  generation += 1;
  answers.clear();
  inflight.clear();
  failures.clear();
  notify();
}

export function peekWatchPartyWaitlist(
  serverId: string | null,
): WatchPartyWaitlistState | null {
  return answers.get(keyOf(serverId)) ?? null;
}

/**
 * The caller's waitlist answer for a server, or null. `active: false` asks
 * nothing, which is what a server whose config said yes (or has not said
 * anything) gets: no request is made for a server that runs parties.
 */
export function useWatchPartyWaitlist(
  serverId: string | null,
  active: boolean,
): WatchPartyWaitlistState | null {
  const [, setVersion] = useState(0);
  useEffect(() => {
    const listener = () => setVersion((value) => value + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  // The generation is a dependency so a reset (another account signed in)
  // asks again instead of leaving an empty store empty.
  const currentGeneration = generation;
  useEffect(() => {
    if (!active) {
      return;
    }
    void loadWatchPartyWaitlist(serverId).catch(() => {
      // Unknown stays unknown: no teaser is the safe answer. The dialog reads
      // `watchPartyWaitlistFailed` and offers a retry.
    });
  }, [serverId, active, currentGeneration]);
  return active ? peekWatchPartyWaitlist(serverId) : null;
}
