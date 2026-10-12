/**
 * `channelLayout` on `GET /api/admin/metrics`: what the mixed channel list is
 * doing in this process since it started. Per process, like the push and
 * nudge counters: with two instances, read each.
 *
 * Its own module so `servers.ts` (the legacy move and create rules) and
 * `channel-layout.ts` (migrate, revert, the full-order PUT) can both count
 * without importing each other.
 */

export interface ChannelLayoutMetrics {
  /** Servers whose loose channels went into a new default category. */
  migrated: number;
  /** Servers found already in the mixed shape (nothing loose), recorded as done. */
  migratedNoop: number;
  /** Operator reverts that restored a snapshot. */
  reverted: number;
  /** Full-order PUTs that committed. */
  reorders: number;
  /** Full-order PUTs refused because the list moved since the client read it. */
  staleRejected: number;
  /** `PATCH /move` to the loose area, read as an old client's per-type index. */
  legacyMoveTranslated: number;
  /** Creates with no `parentId` key on a mixed server, sent to the first category. */
  legacyCreateRedirected: number;
  /** Migration job ticks that threw. */
  jobFailures: number;
}

const counters: ChannelLayoutMetrics = {
  migrated: 0,
  migratedNoop: 0,
  reverted: 0,
  reorders: 0,
  staleRejected: 0,
  legacyMoveTranslated: 0,
  legacyCreateRedirected: 0,
  jobFailures: 0,
};

export function countChannelLayout(key: keyof ChannelLayoutMetrics): void {
  counters[key] += 1;
}

export function channelLayoutMetrics(): ChannelLayoutMetrics {
  return { ...counters };
}

export function resetChannelLayoutMetricsForTests(): void {
  for (const key of Object.keys(counters) as Array<keyof ChannelLayoutMetrics>) {
    counters[key] = 0;
  }
}
