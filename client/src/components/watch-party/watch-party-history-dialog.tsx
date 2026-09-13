import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { formatCallDuration } from "@/components/dm/call-stage-state";
import { ApiError } from "@/lib/api";
import { useTranslation } from "@/lib/i18n";
import { formatRecency, formatTime } from "@/lib/utils";
import {
  fetchWatchPartyHistory,
  fetchWatchPartyHistoryReplay,
  setWatchPartyHistoryKeepReplay,
  type WatchPartyHistoryEntry,
} from "@/lib/watch-party-history-api";

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

/**
 * The list itself, split out from the fetching shell below so it renders the
 * same way `WatchPartyOptionsPanel` does: a plain function of its props, easy
 * to snapshot without a network mock (`watch-party-history-dialog.test.tsx`).
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
      {broadcasts.length > 0 && (
        <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl border border-border bg-surface-0">
          {broadcasts.map((entry) => {
            const busy = busySessionId === entry.sessionId;
            return (
              <li
                key={entry.sessionId}
                data-testid="watch-party-history-row"
                className="flex items-center justify-between gap-3 px-3 py-2.5"
              >
                <div className="min-w-0">
                  <p className="flex items-center gap-2 truncate text-sm text-text">
                    <span>
                      {formatRecency(entry.startedAt)}
                      {" · "}
                      {formatTime(entry.startedAt)}
                    </span>
                    {entry.endedAt === null && (
                      <span className="shrink-0 rounded-full bg-danger-soft px-1.5 py-0.5 text-[11px] font-semibold text-on-danger-soft">
                        {t("watchParty.history.live")}
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-text-tertiary">
                    {entry.durationSeconds !== null
                      ? formatCallDuration(entry.durationSeconds * 1000)
                      : t("watchParty.history.inProgress")}
                    {" · "}
                    {entry.presenter?.displayName ??
                      t("watchParty.history.presenterUnknown")}
                    {!entry.replayAvailable && entry.endedAt !== null && (
                      <>
                        {" · "}
                        {t("watchParty.history.unavailable")}
                      </>
                    )}
                  </p>
                </div>
                {entry.replayAvailable && (
                  <div className="flex shrink-0 items-center gap-3">
                    <Switch
                      label={t("watchParty.history.keepReplay")}
                      hideLabel
                      title={t("watchParty.history.keepReplay")}
                      checked={entry.keepReplay}
                      disabled={busy}
                      onCheckedChange={(checked) =>
                        onToggleKeepReplay(entry, checked)
                      }
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
          })}
        </ul>
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
