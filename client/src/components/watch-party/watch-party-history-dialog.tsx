import { useCallback, useEffect, useState } from "react";
import { ChevronDown } from "lucide-react";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { formatCallDuration } from "@/components/dm/call-stage-state";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { cn, formatTime } from "@/lib/utils";
import {
  fetchWatchPartyHistory,
  fetchWatchPartyHistoryReplay,
  setWatchPartyHistoryKeepReplay,
  type WatchPartyHistoryEntry,
} from "@/lib/watch-party-history-api";
import {
  groupWatchPartyHistory,
  type FoldedReason,
} from "@/lib/watch-party-history-grouping";

/**
 * "Transmissões anteriores": past broadcasts of a watch-party channel, for
 * the owner and moderators to find yesterday's stream. A wholly separate
 * mount from `watch-party-panel.tsx` / `watch-party-transmission.tsx` (both
 * being rewritten by a separate pull request) -- own dialog, own fetch, own
 * player instance.
 * Read-only: watching a replay here never touches chat, presence or the
 * live watch-party state machine.
 */
function messageOf(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback;
}

/** The muted second line: start, end (or "in progress"), duration, presenter. */
function metaLine(
  entry: WatchPartyHistoryEntry,
  t: ReturnType<typeof useTranslation>["t"],
): string {
  const parts = [formatTime(entry.startedAt)];
  if (entry.endedAt !== null) {
    parts.push(formatTime(entry.endedAt));
    if (entry.durationSeconds !== null) {
      parts.push(formatCallDuration(entry.durationSeconds * 1000));
    }
  } else {
    parts.push(t("watchParty.history.inProgress"));
  }
  parts.push(entry.presenter?.displayName ?? t("watchParty.history.presenterUnknown"));
  return parts.join(" · ");
}

/**
 * One broadcast: title bold, then the muted "start · end · duration ·
 * presenter" line. `Assistir` and the keep-replay toggle only appear on an
 * available, ordinary-length row -- a folded row (`foldedReason` set) never
 * gets them, whatever `entry.replayAvailable` says on its own, because a
 * sub-minute restart is not something to "watch" even while its segments
 * technically still exist.
 */
function WatchPartyHistoryRow({
  entry,
  busy,
  foldedReason,
  onToggleKeepReplay,
  onWatch,
}: {
  entry: WatchPartyHistoryEntry;
  busy: boolean;
  foldedReason?: FoldedReason;
  onToggleKeepReplay: (entry: WatchPartyHistoryEntry, next: boolean) => void;
  onWatch: (entry: WatchPartyHistoryEntry) => void;
}) {
  const { t } = useTranslation();
  const showControls = foldedReason === undefined && entry.replayAvailable;
  return (
    <li
      data-testid="watch-party-history-row"
      className="flex items-center justify-between gap-3 px-3 py-2.5"
    >
      <div className="min-w-0">
        <p className="flex items-center gap-2 truncate text-sm font-semibold text-text">
          <span className="truncate">{entry.title}</span>
          {entry.endedAt === null && (
            <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-0.5 text-[11px] font-semibold text-on-danger-soft">
              {t("watchParty.history.live")}
            </span>
          )}
        </p>
        <p className="mt-0.5 truncate text-xs text-text-tertiary">
          {metaLine(entry, t)}
          {foldedReason === "short" && (
            <>
              {" · "}
              {t("watchParty.history.restart")}
            </>
          )}
          {foldedReason === "unavailable" && (
            <>
              {" · "}
              {t("watchParty.history.unavailable")}
            </>
          )}
        </p>
      </div>
      {showControls && (
        <div className="flex shrink-0 items-center gap-3">
          <Switch
            label={t("watchParty.history.keepReplay")}
            hideLabel
            title={t("watchParty.history.keepReplay")}
            checked={entry.keepReplay}
            disabled={busy}
            onCheckedChange={(checked) => onToggleKeepReplay(entry, checked)}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            onClick={() => onWatch(entry)}
          >
            {t("watchParty.history.watch")}
          </Button>
        </div>
      )}
    </li>
  );
}

/**
 * The list itself, split out from the fetching shell below so it renders the
 * same way `WatchPartyOptionsPanel` does: a plain function of its props, easy
 * to snapshot without a network mock (`watch-party-history-dialog.test.tsx`).
 *
 * TWO BUCKETS, ONE LIST. `groupWatchPartyHistory` (`lib/watch-party-history-grouping.ts`)
 * decides which broadcasts read as "yesterday's stream" and which are noise
 * around it -- an expired recording, or an egress restart mid-party that
 * shows up as its own few-second "broadcast". The second bucket sits behind
 * a collapsed disclosure at the bottom, `hidden` rather than unmounted: the
 * rows exist in the DOM (a moderator's browser search, or a test snapshot,
 * still finds them) and only their visibility toggles.
 */
export function WatchPartyHistoryList({
  broadcasts,
  loading,
  error,
  busySessionId,
  onToggleKeepReplay,
  onWatch,
}: {
  broadcasts: WatchPartyHistoryEntry[];
  loading: boolean;
  error: string | null;
  busySessionId: string | null;
  onToggleKeepReplay: (entry: WatchPartyHistoryEntry, next: boolean) => void;
  onWatch: (entry: WatchPartyHistoryEntry) => void;
}) {
  const { t } = useTranslation();
  const [foldedOpen, setFoldedOpen] = useState(false);
  const { available, folded } = groupWatchPartyHistory(broadcasts);
  return (
    <div className="flex flex-col gap-3">
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loading && (
        <p
          role="status"
          aria-live="polite"
          className="text-sm text-text-tertiary"
        >
          {t("common.loading")}
        </p>
      )}
      {!loading && broadcasts.length === 0 && !error && (
        <p className="text-sm text-text-tertiary">
          {t("watchParty.history.empty")}
        </p>
      )}
      {available.length > 0 && (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-0">
          {available.map((entry) => (
            <WatchPartyHistoryRow
              key={entry.sessionId}
              entry={entry}
              busy={busySessionId === entry.sessionId}
              onToggleKeepReplay={onToggleKeepReplay}
              onWatch={onWatch}
            />
          ))}
        </ul>
      )}
      {folded.length > 0 && (
        <div>
          <button
            type="button"
            data-testid="watch-party-history-older-toggle"
            className="flex w-full items-center justify-between rounded-md py-1 text-left text-sm text-text hover:text-text focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
            aria-expanded={foldedOpen}
            onClick={() => setFoldedOpen((open) => !open)}
          >
            <span>
              {t("watchParty.history.older", { count: folded.length })}
            </span>
            <ChevronDown
              className={cn(
                "h-4 w-4 text-text-tertiary transition-transform",
                foldedOpen && "rotate-180",
              )}
              aria-hidden
            />
          </button>
          <ul
            hidden={!foldedOpen}
            data-testid="watch-party-history-older-list"
            className="mt-2 flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-0"
          >
            {folded.map(({ entry, reason }) => (
              <WatchPartyHistoryRow
                key={entry.sessionId}
                entry={entry}
                busy={busySessionId === entry.sessionId}
                foldedReason={reason}
                onToggleKeepReplay={onToggleKeepReplay}
                onWatch={onWatch}
              />
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function WatchPartyHistoryDialog({
  open,
  onClose,
  channelId,
}: {
  open: boolean;
  onClose: () => void;
  channelId: string;
}) {
  const { t } = useTranslation();
  const [broadcasts, setBroadcasts] = useState<WatchPartyHistoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busySessionId, setBusySessionId] = useState<string | null>(null);
  const [player, setPlayer] = useState<{
    sessionId: string;
    src: string;
  } | null>(null);
  const [playerError, setPlayerError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    fetchWatchPartyHistory(channelId)
      .then((res) => setBroadcasts(res.broadcasts))
      .catch((err: unknown) => {
        setError(messageOf(err, t("watchParty.history.loadFailed")));
      })
      .finally(() => setLoading(false));
  }, [channelId, t]);

  useEffect(() => {
    if (!open) {
      setPlayer(null);
      setPlayerError(null);
      return;
    }
    load();
  }, [open, load]);

  async function toggleKeepReplay(
    entry: WatchPartyHistoryEntry,
    next: boolean,
  ) {
    setBusySessionId(entry.sessionId);
    setError(null);
    try {
      const res = await setWatchPartyHistoryKeepReplay(
        channelId,
        entry.sessionId,
        next,
      );
      setBroadcasts(res.broadcasts);
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t("watchParty.history.replayGone")
          : messageOf(err, t("watchParty.history.keepReplayFailed")),
      );
    } finally {
      setBusySessionId(null);
    }
  }

  async function watch(entry: WatchPartyHistoryEntry) {
    setBusySessionId(entry.sessionId);
    setPlayerError(null);
    try {
      const res = await fetchWatchPartyHistoryReplay(
        channelId,
        entry.sessionId,
      );
      setPlayer({ sessionId: entry.sessionId, src: res.hlsUrl });
    } catch (err) {
      setError(
        err instanceof ApiError && err.status === 409
          ? t("watchParty.history.replayGone")
          : messageOf(err, t("watchParty.history.watchFailed")),
      );
    } finally {
      setBusySessionId(null);
    }
  }

  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={
        player
          ? t("watchParty.history.watch")
          : t("watchParty.history.title")
      }
      eyebrow={player ? undefined : t("watchParty.history.eyebrow")}
      description={player ? undefined : t("watchParty.history.description")}
      size="lg"
    >
      <DialogBody>
        {player ? (
          <div className="flex flex-col gap-3">
            <div className="aspect-video w-full overflow-hidden rounded-[var(--radius-card)] bg-surface-3">
              <HlsWatchPlayer
                key={player.sessionId}
                src={player.src}
                layout="cinema"
                mode="vod"
                className="h-full w-full"
              />
            </div>
            <div>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setPlayer(null)}
              >
                {t("watchParty.history.back")}
              </Button>
            </div>
          </div>
        ) : (
          <>
            {playerError && (
              <p role="alert" className="mb-3 text-sm text-danger">
                {playerError}
              </p>
            )}
            <WatchPartyHistoryList
              broadcasts={broadcasts}
              loading={loading}
              error={error}
              busySessionId={busySessionId}
              onToggleKeepReplay={(entry, next) =>
                void toggleKeepReplay(entry, next)
              }
              onWatch={(entry) => void watch(entry)}
            />
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}
