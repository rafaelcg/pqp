import { useCallback, useEffect, useState } from "react";
import { ChevronDown, Download } from "lucide-react";
import { Dialog, DialogBody } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { HlsWatchPlayer } from "@/components/voice/hls-watch-player";
import { formatCallDuration } from "@/components/dm/call-stage-state";
import { ApiError } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { cn, formatTime } from "@/lib/utils";
import {
  fetchWatchPartyHistory,
  fetchWatchPartyHistoryDownloads,
  fetchWatchPartyHistoryReplay,
  setWatchPartyHistoryKeepReplay,
  WATCH_PARTY_DOWNLOAD_KINDS,
  type WatchPartyDownloadKind,
  type WatchPartyDownloads,
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

/** What the row knows about a broadcast's files. `undefined` is "not asked
 * yet"; the panel asks on first open. */
export type WatchPartyDownloadsState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      downloads: WatchPartyDownloads;
      /** Kinds being made right now (an LL film); the dialog asks again. */
      preparing?: WatchPartyDownloadKind[];
    };

/** How often an open dialog asks again about a file that is being made. The
 * box re-encodes a two-hour show in a quarter of an hour or so; a short show
 * in well under a minute. */
export const DOWNLOAD_PREPARING_POLL_MS = 20_000;

/** Literal keys rather than a template, so a grep for a key still finds it. */
const DOWNLOAD_LABEL_KEYS: Record<WatchPartyDownloadKind, MessageKey> = {
  film: "watchParty.history.download.film",
  camera: "watchParty.history.download.camera",
  voice: "watchParty.history.download.voice",
};

/** Why a file is not there. Each one is a different fact about the night,
 * not an error: nobody turned the camera on, or the voice archive was off. */
const DOWNLOAD_MISSING_KEYS: Record<WatchPartyDownloadKind, MessageKey> = {
  film: "watchParty.history.download.filmMissing",
  camera: "watchParty.history.download.cameraMissing",
  voice: "watchParty.history.download.voiceMissing",
};

function formatDownloadSize(bytes: number | null): string | null {
  if (bytes === null || bytes <= 0) {
    return null;
  }
  const units: [number, string][] = [
    [1_000_000_000, "GB"],
    [1_000_000, "MB"],
    [1_000, "kB"],
  ];
  for (const [scale, unit] of units) {
    if (bytes >= scale) {
      const value = bytes / scale;
      return `${value.toLocaleString(undefined, {
        maximumFractionDigits: value >= 100 ? 0 : 1,
      })} ${unit}`;
    }
  }
  return `${bytes} B`;
}

/**
 * The three files, as plain links.
 *
 * A PLAIN `<a href download>`, NOT A `fetch`. Saving a `fetch` response
 * means holding the whole broadcast in the tab as a Blob first, which is
 * gigabytes of a moderator's memory for a file the browser can stream to
 * disk on its own. The API answers `Content-Disposition: attachment`, which
 * is what actually makes the navigation a download -- the `download`
 * attribute alone is ignored cross-origin, and in production the SPA and the
 * API are different origins. The capability the API checks rides in the
 * URL's `?t=`, because a navigation carries no `Authorization` header.
 */
export function WatchPartyDownloadPanel({
  state,
}: {
  state: WatchPartyDownloadsState | undefined;
}) {
  const { t } = useTranslation();
  if (state === undefined || state.status === "loading") {
    return (
      <p
        role="status"
        aria-live="polite"
        className="mt-2 text-xs text-text-tertiary"
      >
        {t("common.loading")}
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p role="alert" className="mt-2 text-xs text-danger">
        {state.message}
      </p>
    );
  }
  return (
    <div
      data-testid="watch-party-history-downloads"
      className="mt-2 flex flex-col gap-1 rounded-[var(--radius-control)] bg-surface-1 p-2"
    >
      {WATCH_PARTY_DOWNLOAD_KINDS.map((kind) => {
        const item = state.downloads[kind];
        const label = t(DOWNLOAD_LABEL_KEYS[kind]);
        const size = item ? formatDownloadSize(item.bytes) : null;
        if (!item && state.preparing?.includes(kind)) {
          return (
            <span
              key={kind}
              role="status"
              data-testid={`watch-party-history-download-${kind}-preparing`}
              className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm text-text-secondary"
            >
              <span className="truncate">{label}</span>
              <span className="shrink-0 text-xs">
                {t("watchParty.history.download.preparing")}
              </span>
            </span>
          );
        }
        return item ? (
          <a
            key={kind}
            data-testid={`watch-party-history-download-${kind}`}
            href={item.url}
            download
            className="flex items-center justify-between gap-3 rounded-[var(--radius-control)] px-2 py-1.5 text-sm text-text hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal/60"
          >
            <span className="flex min-w-0 items-center gap-2">
              <Download className="h-3.5 w-3.5 shrink-0" aria-hidden />
              <span className="truncate">{label}</span>
            </span>
            {size && (
              <span className="shrink-0 text-xs text-text-tertiary">{size}</span>
            )}
          </a>
        ) : (
          <span
            key={kind}
            data-testid={`watch-party-history-download-${kind}-missing`}
            className="flex items-center justify-between gap-3 px-2 py-1.5 text-sm text-text-tertiary opacity-60"
          >
            <span className="truncate">{label}</span>
            <span className="shrink-0 text-xs">
              {t(DOWNLOAD_MISSING_KEYS[kind])}
            </span>
          </span>
        );
      })}
      <p className="px-2 pt-1 text-xs text-text-tertiary">
        {t("watchParty.history.download.hint")}
      </p>
    </div>
  );
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
  downloads,
  onToggleKeepReplay,
  onWatch,
  onRequestDownloads,
}: {
  entry: WatchPartyHistoryEntry;
  busy: boolean;
  foldedReason?: FoldedReason;
  downloads?: WatchPartyDownloadsState;
  onToggleKeepReplay: (entry: WatchPartyHistoryEntry, next: boolean) => void;
  onWatch: (entry: WatchPartyHistoryEntry) => void;
  onRequestDownloads: (entry: WatchPartyHistoryEntry) => void;
}) {
  const { t } = useTranslation();
  const [downloadsOpen, setDownloadsOpen] = useState(false);
  const showControls = foldedReason === undefined && entry.replayAvailable;
  return (
    <li data-testid="watch-party-history-row" className="px-3 py-2.5">
      <div className="flex items-center justify-between gap-3">
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
            <Button
              size="sm"
              variant="ghost"
              data-testid="watch-party-history-download-toggle"
              aria-expanded={downloadsOpen}
              onClick={() => {
                setDownloadsOpen((open) => !open);
                if (!downloadsOpen) {
                  // Asked on first open, never on render: pricing the files is
                  // a bucket listing per broadcast on the server.
                  onRequestDownloads(entry);
                }
              }}
            >
              {t("watchParty.history.download.open")}
            </Button>
          </div>
        )}
      </div>
      {showControls && downloadsOpen && (
        <WatchPartyDownloadPanel state={downloads} />
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
  downloads = {},
  onToggleKeepReplay,
  onWatch,
  onRequestDownloads = () => {},
}: {
  broadcasts: WatchPartyHistoryEntry[];
  loading: boolean;
  error: string | null;
  busySessionId: string | null;
  /** By `sessionId`. Missing means "nobody has opened that row's panel". */
  downloads?: Record<string, WatchPartyDownloadsState | undefined>;
  onToggleKeepReplay: (entry: WatchPartyHistoryEntry, next: boolean) => void;
  onWatch: (entry: WatchPartyHistoryEntry) => void;
  onRequestDownloads?: (entry: WatchPartyHistoryEntry) => void;
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
              downloads={downloads[entry.sessionId]}
              onToggleKeepReplay={onToggleKeepReplay}
              onWatch={onWatch}
              onRequestDownloads={onRequestDownloads}
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
                downloads={downloads[entry.sessionId]}
                onToggleKeepReplay={onToggleKeepReplay}
                onWatch={onWatch}
                onRequestDownloads={onRequestDownloads}
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
  const [downloads, setDownloads] = useState<
    Record<string, WatchPartyDownloadsState | undefined>
  >({});

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
      setDownloads({});
      return;
    }
    load();
  }, [open, load]);

  const fetchDownloads = useCallback(
    (sessionId: string) => {
      void fetchWatchPartyHistoryDownloads(channelId, sessionId)
        .then((result) =>
          setDownloads((next) => ({
            ...next,
            [sessionId]: {
              status: "ready",
              downloads: result.downloads,
              preparing: result.preparing,
            },
          })),
        )
        .catch((err: unknown) =>
          setDownloads((next) => ({
            ...next,
            [sessionId]: {
              status: "error",
              message:
                err instanceof ApiError && err.status === 409
                  ? t("watchParty.history.replayGone")
                  : messageOf(err, t("watchParty.history.download.failed")),
            },
          })),
        );
    },
    [channelId, t],
  );

  // A file being made is asked about again until it exists, for as long as
  // the dialog is open (closing it clears `downloads`, which ends this).
  useEffect(() => {
    const waiting = Object.entries(downloads).filter(
      ([, state]) =>
        state?.status === "ready" && (state.preparing?.length ?? 0) > 0,
    );
    if (waiting.length === 0) {
      return;
    }
    const timer = setTimeout(() => {
      for (const [sessionId] of waiting) {
        fetchDownloads(sessionId);
      }
    }, DOWNLOAD_PREPARING_POLL_MS);
    return () => clearTimeout(timer);
  }, [downloads, fetchDownloads]);

  const requestDownloads = useCallback(
    (entry: WatchPartyHistoryEntry) => {
      setDownloads((current) => {
        // Already asked, and a finished broadcast's files do not change while
        // the dialog is open -- re-opening the panel must not re-list. An
        // EARLIER FAILURE IS NOT AN ANSWER, though: storage being down for a
        // moment must not leave the row stuck on its error message until the
        // whole dialog is closed and reopened, so re-opening the panel after
        // one asks again.
        const asked = current[entry.sessionId];
        if (asked && asked.status !== "error") {
          return current;
        }
        fetchDownloads(entry.sessionId);
        return { ...current, [entry.sessionId]: { status: "loading" } };
      });
    },
    [fetchDownloads],
  );

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
              downloads={downloads}
              onToggleKeepReplay={(entry, next) =>
                void toggleKeepReplay(entry, next)
              }
              onWatch={(entry) => void watch(entry)}
              onRequestDownloads={requestDownloads}
            />
          </>
        )}
      </DialogBody>
    </Dialog>
  );
}
