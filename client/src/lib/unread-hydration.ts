/**
 * Filling the unread map for every server, not only the one on screen.
 *
 * WHY THIS EXISTS. `GET /api/servers/:id/unread` was only ever asked for the
 * SELECTED server (a first open, a switch, an invite). The live
 * `channel-activity` frame is the only other thing that writes the map, and it
 * is a one-shot: nothing replays it. So a badge for any server you were not
 * looking at existed only if the frame happened to reach THIS tab while its
 * socket was up. Reload the page, wake the laptop, ride out an API restart
 * (every merge to main closes every `/ws`), come back to a tab that spent the
 * night backgrounded: the rail came up clean and the unread sitting in the
 * other servers was invisible until you clicked into each one. Production
 * showed it plainly: the open server read as caught up and nothing on the rail
 * lit, while other servers held unread the server could count.
 *
 * Kept as plain functions so the rules (which servers, how many at once, when a
 * gap is long enough to be worth asking again) are testable without a socket.
 */

/**
 * Servers hydrated per pass at most, in rail order. Each is one request, so the
 * cap is what bounds the cost for an account in many servers; the ones past it
 * light up from live frames and when opened, as every server did before.
 */
export const UNREAD_HYDRATION_MAX_SERVERS = 15;

/** The pause before the one retry of a server whose read failed. */
export const UNREAD_HYDRATION_RETRY_MS = 4_000;

/** Requests in flight at once: the rail fills in over a second or two, quietly. */
export const UNREAD_HYDRATION_CONCURRENCY = 2;

/**
 * A socket down for less than this is not worth a re-read: the frames missed are
 * a handful, and a deploy drains every tab within seconds of each other, so an
 * unconditional re-read would turn a restart into one query per server per tab.
 */
export const UNREAD_RECONNECT_MIN_GAP_MS = 15_000;

/** A tab hidden for at least this long re-reads when it comes back. */
export const UNREAD_VISIBLE_MIN_HIDDEN_MS = 60_000;

/** Whether a reconnect after `closedAt` is long enough to re-read the badges. */
export function reconnectNeedsUnreadRefresh(
  closedAt: number | null,
  now: number,
): boolean {
  if (closedAt === null) {
    // Never saw it close (the first connect, or a build that did not record
    // it): the safe answer for a reconnect is to ask once.
    return true;
  }
  return now - closedAt >= UNREAD_RECONNECT_MIN_GAP_MS;
}

/** Whether a tab that was hidden since `hiddenAt` should re-read now. */
export function visibleNeedsUnreadRefresh(
  hiddenAt: number | null,
  now: number,
): boolean {
  return hiddenAt !== null && now - hiddenAt >= UNREAD_VISIBLE_MIN_HIDDEN_MS;
}

/**
 * The servers to ask about, in rail order. A muted server is skipped: its icon
 * says nothing and its channels are left out of the tab count, so the answer
 * could not change anything on screen.
 */
export function serversToHydrate(
  servers: readonly { id: string }[],
  {
    skipServerId = null,
    isMuted,
  }: {
    skipServerId?: string | null;
    isMuted: (serverId: string) => boolean;
  },
): string[] {
  const ids: string[] = [];
  for (const server of servers) {
    if (server.id === skipServerId || isMuted(server.id)) {
      continue;
    }
    ids.push(server.id);
    if (ids.length >= UNREAD_HYDRATION_MAX_SERVERS) {
      break;
    }
  }
  return ids;
}

/**
 * Run `load` for each id, `concurrency` at a time, stopping early when
 * `shouldStop` turns true (the app shell unmounted, or a newer pass started).
 * `load` swallows its own errors, as `loadUnread` does: a badge is cosmetic.
 */
export async function hydrateInBatches(
  ids: readonly string[],
  load: (serverId: string) => Promise<boolean | void>,
  {
    concurrency = UNREAD_HYDRATION_CONCURRENCY,
    shouldStop = () => false,
    retryDelayMs = UNREAD_HYDRATION_RETRY_MS,
  }: {
    concurrency?: number;
    shouldStop?: () => boolean;
    retryDelayMs?: number;
  } = {},
): Promise<void> {
  const failed: string[] = [];
  const run = async (list: readonly string[]) => {
    let next = 0;
    const worker = async () => {
      while (!shouldStop()) {
        const index = next;
        next += 1;
        if (index >= list.length) {
          return;
        }
        // `false` is a failed read; `void`/`true` is fine.
        if ((await load(list[index]!)) === false) {
          failed.push(list[index]!);
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(concurrency, list.length) }, worker),
    );
  };
  await run(ids);
  // One more try for the servers that failed, after a pause: a transient error
  // would otherwise leave that icon dark until the next reconnect.
  if (failed.length > 0 && !shouldStop()) {
    const again = failed.splice(0);
    await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    if (!shouldStop()) {
      await run(again);
    }
  }
}
