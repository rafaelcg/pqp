import type { JamSongSummary } from "@pqp/shared";
import { Check, Hash, Loader2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { songNeed } from "@/lib/jam-wall";
import { JamCoverPhoto, useJamCover } from "./jam-cover";
import { useNeedLabel } from "./jam-need";
import { bandOrder } from "./jam-art";
import { Dialog } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { fetchForwardDestinations } from "@/lib/api";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { foldForSearch } from "@/lib/conversation-list";
import { jamSongShareUrl } from "@/lib/jam-share";
import { sendShareMessage, type ShareResult } from "@/lib/jam-share-send";
import { cn } from "@/lib/utils";

/**
 * "Mandar no chat": the text channels of this song's server that the person may
 * write in, one tap each. The server already says which those are (the same list
 * "Encaminhar" offers: visible and speakable, never a category or a channel the
 * person cannot see), and decides again when the message is sent, so a refusal
 * (slow mode, AutoMod, a rate limit) is shown on the row it belongs to.
 *
 * The message is the song's link and nothing else: a chat that understands the
 * link draws the song as a card, and one that does not (a person who is not in
 * the Jam, an app that predates the card) shows an ordinary link.
 */

interface Place {
  id: string;
  name: string;
}

type Row = { status: "idle" } | { status: "sending" } | { status: "sent" } | { status: "failed"; reason: Extract<ShareResult, { ok: false }>["reason"] };

const SEARCH_FROM = 8;

const ERROR_KEY: Record<Extract<ShareResult, { ok: false }>["reason"], MessageKey> = {
  offline: "jam.share.error.offline",
  timeout: "jam.share.error.timeout",
  "rate-limited": "jam.share.error.rateLimited",
  "slow-mode": "jam.share.error.slowMode",
  "no-access": "jam.share.error.noAccess",
  automod: "jam.share.error.automod",
  other: "jam.share.error.other",
};

export function JamSharePicker({ song, open, onClose }: { song: JamSongSummary; open: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [places, setPlaces] = useState<Place[] | null>(null);
  const [loadFailed, setLoadFailed] = useState(false);
  const [rows, setRows] = useState<Record<string, Row>>({});
  const [query, setQuery] = useState("");
  const [attempt, setAttempt] = useState(0);

  const serverId = song.serverId;
  useEffect(() => {
    // A standalone public jam has no server to share into.
    if (!open || !serverId) {
      return;
    }
    let cancelled = false;
    setPlaces(null);
    setLoadFailed(false);
    setRows({});
    setQuery("");
    fetchForwardDestinations(serverId).then(
      (answer) => {
        if (!cancelled) {
          setPlaces(answer.channels.filter((channel) => channel.type === "text").map((channel) => ({ id: channel.id, name: channel.name })));
        }
      },
      () => {
        if (!cancelled) {
          setLoadFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [open, serverId, attempt]);

  const shown = useMemo(() => {
    const needle = foldForSearch(query.replace(/^#/, ""));
    return (places ?? []).filter((place) => !needle || foldForSearch(place.name).includes(needle));
  }, [places, query]);

  const send = useCallback(
    async (place: Place) => {
      if (!song.serverId || !song.channelId) {
        return;
      }
      setRows((before) => ({ ...before, [place.id]: { status: "sending" } }));
      const origin = typeof window === "undefined" ? "" : window.location.origin;
      const result = await sendShareMessage(
        place.id,
        jamSongShareUrl(origin, { serverId: song.serverId, channelId: song.channelId, songId: song.id }),
      );
      setRows((before) => ({
        ...before,
        [place.id]: result.ok ? { status: "sent" } : { status: "failed", reason: result.reason },
      }));
    },
    [song.channelId, song.id, song.serverId],
  );

  return (
    <Dialog
      open={open}
      title={t("jam.share.title")}
      size="sm"
      onClose={onClose}
    >
      <div data-jam-share-picker="" className="flex flex-col gap-3 px-5 py-4">
        <SongLine song={song} />
        {places !== null && places.length >= SEARCH_FROM && (
          <Input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("jam.share.search")}
            aria-label={t("jam.share.search")}
            autoComplete="off"
            spellCheck={false}
          />
        )}
        {loadFailed ? (
          <div className="flex flex-col items-start gap-2 py-2">
            <p className="text-sm text-text-secondary">{t("jam.share.loadFailed")}</p>
            <Button variant="secondary" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              {t("forward.retry")}
            </Button>
          </div>
        ) : places === null ? (
          <p className="flex items-center gap-2 py-3 text-sm text-text-secondary" role="status">
            <Loader2 className="h-4 w-4 animate-spin motion-reduce:animate-none" aria-hidden="true" />
            {t("jam.share.loading")}
          </p>
        ) : places.length === 0 ? (
          <p className="py-3 text-sm text-text-secondary">{t("jam.share.empty")}</p>
        ) : shown.length === 0 ? (
          <p className="py-3 text-sm text-text-secondary">{t("jam.share.noMatch")}</p>
        ) : (
          <ul className="-mx-2 flex max-h-[min(50vh,22rem)] flex-col overflow-y-auto">
            {shown.map((place) => {
              const row = rows[place.id] ?? { status: "idle" as const };
              return (
                <li key={place.id}>
                  <button
                    type="button"
                    data-jam-share-channel={place.id}
                    disabled={row.status === "sending" || row.status === "sent"}
                    onClick={() => void send(place)}
                    className={cn(
                      "flex min-h-11 w-full items-center gap-3 rounded-[var(--radius-control)] px-2 py-1.5 text-left outline-none",
                      "hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring disabled:cursor-default disabled:hover:bg-transparent",
                    )}
                  >
                    <Hash className="h-4 w-4 shrink-0 text-text-tertiary" aria-hidden="true" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-text">{place.name}</span>
                      {row.status === "failed" && (
                        <span className="block text-xs text-danger" role="alert">
                          {t(ERROR_KEY[row.reason])}
                        </span>
                      )}
                    </span>
                    {row.status === "idle" && (
                      <span className="shrink-0 text-xs font-semibold text-text-tertiary">{t("jam.share.send")}</span>
                    )}
                    {row.status === "failed" && (
                      <span className="shrink-0 text-xs font-semibold text-text-tertiary">{t("jam.share.retry")}</span>
                    )}
                    {row.status === "sending" && <Loader2 className="h-4 w-4 shrink-0 animate-spin text-text-tertiary motion-reduce:animate-none" aria-hidden="true" />}
                    {row.status === "sent" && (
                      <span className="flex shrink-0 items-center gap-1 text-xs font-semibold text-text-secondary" role="status">
                        <Check className="h-4 w-4" aria-hidden="true" />
                        {t("jam.share.sent")}
                      </span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </Dialog>
  );
}

/** What is being sent: the song's picture, its title and, in words, what it is missing. */
function SongLine({ song }: { song: JamSongSummary }) {
  const { t } = useTranslation();
  const needLabel = useNeedLabel();
  const cover = useJamCover(song.coverUrl);
  const need = songNeed(song);
  const band = bandOrder(song.instruments);
  return (
    <div className="flex items-center gap-3" data-jam-share-song="">
      <span aria-hidden="true" className="relative h-10 w-10 shrink-0 overflow-hidden rounded-[var(--radius-control)] bg-surface-2">
        {cover.src !== null && cover.status !== "failed" ? (
          <JamCoverPhoto cover={cover} eager />
        ) : (
          <span className="absolute inset-0 flex flex-col justify-center gap-[2px] p-[5px]">
            {band.slice(0, 5).map((instrument) => (
              <span key={instrument} className={`min-h-[4px] flex-1 rounded-full ${JAM_INSTRUMENT_LOOK[instrument].fill}`} />
            ))}
          </span>
        )}
      </span>
      <span className="min-w-0">
        <span className="block truncate text-sm font-semibold text-text">{song.title}</span>
        <span className="block truncate text-xs text-text-secondary first-letter:uppercase">
          {need.kind === "missing" ? needLabel(need) : (song.artist ?? t("jam.original"))}
        </span>
      </span>
    </div>
  );
}
