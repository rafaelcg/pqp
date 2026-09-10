/**
 * The cold paths: every periodic job that needs nothing from this process
 * except a database pool (and, for two of them, object storage or Clerk).
 *
 * They used to live in `index.ts` next to the WebSocket heartbeat. They are
 * here so the same code can run either inside the API (`WORKER_MODE` unset,
 * today's behaviour) or alone in `worker.ts` on a second machine, so that a
 * bucket listing or a retention DELETE never competes with voice signalling
 * for the one CPU the API has. `lib/process-role.ts` decides which; nothing
 * in this file reads the env for that.
 *
 * What is deliberately NOT here, and why (docs/plans/COLD_PATHS.md has the
 * full inventory):
 *   * the WS heartbeat, rate-limit / auth-cache / audience sweeps: they walk
 *     in-process Maps that only exist where the sockets are;
 *   * the LiveKit eviction re-sweeps (voice/admin.ts): keyed timers created
 *     by a request, in-process until a claims table exists;
 *   * the Community Home schedule publish: it must nudge connected members
 *     over the WS after flipping rows, so it stays with the sockets. Its media
 *     orphan sweep has no such dependency and is here;
 *   * the status sampler: its `api` probe is "this process answered", which
 *     is only true when the process it samples from is the API.
 *
 * Every job here is idempotent and claims its rows in SQL (grace windows,
 * `SKIP LOCKED`, `expires_at` filters), so a window in which both the API and
 * the worker run them does duplicate work, not wrong work.
 */
import {
  isAttachmentsConfigured,
  sweepOrphanedAttachments,
  sweepQuarantinedAttachments,
} from "./services/attachments.js";
import { sweepOrphanedCommunityHomeMedia } from "./services/community-home.js";
import { sweepPendingAccountDeletions } from "./services/account.js";
import { pruneAuditLog } from "./services/audit.js";
import { pruneResolvedReports } from "./services/reports.js";
import { pruneExpiredTimeouts } from "./services/sanctions.js";
import { sweepMessageRetention } from "./services/retention.js";
import { sweepSlowModeClocks } from "./services/slow-mode.js";
import { sweepExpiredConnectionStates } from "./services/connections.js";
import {
  deliverDueOutgoingWebhooks,
  pruneDeliveredOutgoingWebhooks,
} from "./services/outgoing-webhooks.js";
import {
  OCCUPANCY_SAMPLE_INTERVAL_MS,
  recordVoiceOccupancySample,
  rollUpAndPruneVoiceOccupancy,
} from "./services/voice-occupancy.js";
import { sendDueChannelSessionReminders } from "./services/channel-sessions.js";
import { sweepWatchPartyHosts } from "./services/watch-parties.js";
import { broadcastWatchParty } from "./ws/watch-party-events.js";
import { sweepHlsSessions } from "./voice/hls-cleanup.js";

/**
 * Hourly, because the grace period is an hour: running more often only finds
 * rows it is not yet allowed to touch.
 */
export const ATTACHMENT_SWEEP_INTERVAL_MS = 60 * 60_000;

/**
 * Every minute: sessions are scheduled in minutes, not hours, so this is the
 * coarsest tick that never misses the T-10 window it exists to catch.
 */
export const CHANNEL_SESSION_REMINDER_INTERVAL_MS = 60_000;

/** Daily is plenty for a 90-day retention window; a failure here costs
 * nothing but disk, and resolves on the next run. */
export const DAILY_MS = 24 * 60 * 60_000;

/**
 * Five minutes rather than daily, and unlike every other sweep in this file
 * it is not about disk: each pending row is an account whose owner has been
 * told their data is gone and whose sign-in already is. A day of that is a
 * day of being wrong about a statutory promise.
 */
export const PENDING_DELETION_SWEEP_INTERVAL_MS = 5 * 60_000;

/** Same cadence the Community Home schedule sweep has always had. */
export const COMMUNITY_HOME_MEDIA_SWEEP_INTERVAL_MS = 30_000;

/**
 * Outgoing webhook outbox. First attempt is also kicked from enqueue, in
 * whichever process enqueued; this loop owns retries, reclaim of a
 * `delivering` row whose process died, and pruning delivered receipts.
 */
export const OUTGOING_WEBHOOK_TICK_MS = 2_000;
export const OUTGOING_WEBHOOK_PRUNE_INTERVAL_MS = 60 * 60_000;

/**
 * Every minute: the default retention window is ten minutes, so this needs
 * to run often enough that a session's objects do not linger far past it.
 */
export const HLS_SESSION_SWEEP_INTERVAL_MS = 60_000;

/**
 * Collect attachments no message claimed: uploads that were never sent, and
 * rows orphaned when a message, channel or server was deleted.
 *
 * Skipped outright without storage so a deployment that never enabled the
 * feature does no work at all, and every failure is swallowed. A bucket
 * being unreachable is a cost problem that resolves on the next run, and must
 * never be able to bring the process down.
 */
export async function sweepAttachments(): Promise<void> {
  // Quarantine expiry runs whether or not storage is configured, and outside
  // the guard below on purpose: a quarantined row can be a remote GIF, which
  // has no bucket anywhere in its life cycle, and a deployment that turned S3
  // off after scanning had already refused something would otherwise hold
  // those rows forever. `sweepQuarantinedAttachments` never touches an
  // illegal-content row at any age; see its comment.
  try {
    await sweepQuarantinedAttachments();
  } catch (error) {
    console.error("[content-safety] quarantine sweep failed:", error);
  }

  if (!isAttachmentsConfigured()) {
    return;
  }
  try {
    await sweepOrphanedAttachments();
  } catch (error) {
    console.error("[attachments] sweep failed:", error);
  }
}

async function sweepCommunityHomeMedia(): Promise<void> {
  try {
    await sweepOrphanedCommunityHomeMedia();
  } catch (error) {
    console.error("[community-home] media sweep failed:", error);
  }
}

function every(
  ms: number,
  label: string,
  run: () => Promise<unknown>,
): ReturnType<typeof setInterval> {
  const timer = setInterval(() => {
    void run().catch((error) => {
      console.error(`[${label}] failed:`, error);
    });
  }, ms);
  // A timer this long must not be the reason the process refuses to exit.
  timer.unref?.();
  return timer;
}

export interface ColdJobs {
  /** Clear every timer. Idempotent. */
  stop(): void;
  /** For tests and logs: how many timers are live. */
  readonly count: number;
}

/**
 * Schedule every cold job and run the boot-time sweeps once.
 *
 * The boot sweeps exist because a process that redeploys or crash-restarts
 * more often than hourly never reaches the first tick. Call after `initDb`
 * (or, in the worker, after the API has migrated) so nothing races schema
 * creation; the boot sweeps are deliberately not awaited so an unreachable
 * bucket cannot hold up whatever the caller does next.
 */
export function startColdJobs(): ColdJobs {
  const timers: ReturnType<typeof setInterval>[] = [
    every(ATTACHMENT_SWEEP_INTERVAL_MS, "attachments", sweepAttachments),
    every(DAILY_MS, "audit", pruneAuditLog),
    // A resolved report holds a copy of reported content, so this is a privacy
    // sweep rather than a disk one. Open reports are never touched.
    every(DAILY_MS, "reports", pruneResolvedReports),
    // Expired timeouts: the one sweep NOTHING DEPENDS ON. Every read in
    // services/sanctions.ts filters on `expires_at > NOW()`, so a timeout ends
    // when it says it ends whether or not this timer ever fires. Disk only.
    every(DAILY_MS, "sanctions", pruneExpiredTimeouts),
    every(DAILY_MS, "retention", sweepMessageRetention),
    // Spent slow-mode clocks. Nothing depends on this running: a stale row is
    // inert, because enforcement compares it against the channel's current
    // interval. Rows, not disk pages, is the point.
    every(DAILY_MS, "slow-mode", sweepSlowModeClocks),
    every(DAILY_MS, "connections", sweepExpiredConnectionStates),
    every(PENDING_DELETION_SWEEP_INTERVAL_MS, "account", async () => {
      const finished = await sweepPendingAccountDeletions();
      if (finished > 0) {
        console.warn(`[account] finished ${finished} interrupted deletion(s)`);
      }
    }),
    every(
      COMMUNITY_HOME_MEDIA_SWEEP_INTERVAL_MS,
      "community-home",
      sweepCommunityHomeMedia,
    ),
    every(OUTGOING_WEBHOOK_TICK_MS, "outgoing-webhooks", deliverDueOutgoingWebhooks),
    every(
      OUTGOING_WEBHOOK_PRUNE_INTERVAL_MS,
      "outgoing-webhooks",
      pruneDeliveredOutgoingWebhooks,
    ),
    every(
      CHANNEL_SESSION_REMINDER_INTERVAL_MS,
      "channel-sessions",
      sendDueChannelSessionReminders,
    ),
    every(HLS_SESSION_SWEEP_INTERVAL_MS, "hls-sessions", sweepHlsSessions),
    // Voice occupancy: the one job here that reads live state rather than
    // rows. It is here rather than next to the WS heartbeat because with
    // `VOICE_REGISTRY=postgres` the truth is in `voice_peers`, which the
    // worker can read as well as the API can, better in fact, since it sees
    // the whole cluster instead of one machine's map. With the registry off it
    // falls back to the local map, which is exact in the single process that
    // both serves traffic and runs these jobs, and refuses to invent zeros in
    // a dedicated worker. See services/voice-occupancy.ts.
    every(
      OCCUPANCY_SAMPLE_INTERVAL_MS,
      "voice-occupancy",
      recordVoiceOccupancySample,
    ),
    every(DAILY_MS, "voice-occupancy", rollUpAndPruneVoiceOccupancy),
    // A live watch party whose host has been gone longer than the grace
    // window ends here. Same minute tick as the reminders on purpose: a party
    // that has lost its host is a scheduling fact, not a media one, and the
    // stream (which has its own, much faster, egress monitor) is unaffected
    // either way.
    every(CHANNEL_SESSION_REMINDER_INTERVAL_MS, "watch-parties", async () => {
      const { ended } = await sweepWatchPartyHosts();
      for (const party of ended) {
        console.log(
          `[watch-party] ended ${party.sessionId}: the host never came back`,
        );
        await broadcastWatchParty(party.sessionId);
      }
    }),
  ];

  void sweepAttachments();
  void sweepCommunityHomeMedia();

  let stopped = false;
  return {
    stop() {
      if (stopped) {
        return;
      }
      stopped = true;
      for (const timer of timers) {
        clearInterval(timer);
      }
    },
    get count() {
      return stopped ? 0 : timers.length;
    },
  };
}
