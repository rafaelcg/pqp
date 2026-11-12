import type { JamInstrument } from "@pqp/shared";
import { ArrowLeft } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { ReportDialog, type ReportTarget } from "@/components/chat/report-dialog";
import { Button } from "@/components/ui/button";
import { useTranslation } from "@/lib/i18n";
import { fetchJamSong } from "@/lib/jam-api";
import type { JamIntent } from "@/lib/jam-intent";
import { likePublicJam } from "@/lib/jam-public-api";
import { takePublicJamIntent } from "@/lib/jam-public-nav";
import { useJamPublicMe } from "@/lib/jam-public-store";
import { pickInstrument } from "@/lib/jam-record";
import { releaseJamEngine } from "@/lib/jam-session";
import {
  jamStoreEpoch,
  loadJamDetail,
  publicJamKey,
  putJamSongOnWall,
  readJamChannel,
  useJamStoreVersion,
} from "@/lib/jam-store";
import { JAM_INSTRUMENT_ORDER } from "@/lib/jam-instruments";
import { escapeOwnedByOverlay } from "@/lib/escape-unless-overlay";
import { JamSongPanel } from "./jam-song-panel";
import { JamStartSheet, type JamStartResult } from "./jam-start-sheet";
import { JamStudio } from "./jam-studio";
import type { NewSongDraft } from "@/hooks/use-jam-studio";
import "./jam.css";

/**
 * A public jam, opened inside the app with no channel around it
 * (`/app/jam/<songId>`), and the door to start one (`/app/jam/new`).
 *
 * It is the same song panel, the same stage and lanes and the same studio the
 * channels use, held in the jam store under a key that is not a channel
 * (`publicJamKey`). What is different is only what a visitor may do: like it,
 * report it or one part, copy its address, and record a part, which arrives
 * out of the mix as a request its starter decides on.
 *
 * Covers the app (the sidebar means nothing to a song that belongs to no
 * server) and gives the screen back with its own close.
 */

type Studio =
  | { mode: "over"; instrument: JamInstrument }
  | { mode: "new"; draft: NewSongDraft; instrument: JamInstrument };

export interface JamPublicViewProps {
  /** A song id, or `new`. */
  target: string;
  viewerId: string | null;
  onClose: () => void;
  /** A new jam got its first part: the address becomes the song's. */
  onSongStarted: (songId: string) => void;
}

export function JamPublicView({ target, viewerId, onClose, onSongStarted }: JamPublicViewProps) {
  const { t } = useTranslation();
  const me = useJamPublicMe();
  const rootRef = useRef<HTMLDivElement | null>(null);
  const [studio, setStudio] = useState<Studio | null>(null);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [startOpen, setStartOpen] = useState(target === "new");
  const [freshTrackId, setFreshTrackId] = useState<string | null>(null);

  useEffect(() => () => void releaseJamEngine(), []);

  // Escape leaves, unless a dialog or the studio owns the key.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || studio !== null || escapeOwnedByOverlay(event) || document.fullscreenElement) {
        return;
      }
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [studio, onClose]);

  const isNew = target === "new";
  const songId = isNew ? null : target;
  const key = publicJamKey(target);
  useJamStoreVersion();
  const held = readJamChannel(key);
  const song = songId ? (held.songs.find((one) => one.id === songId) ?? null) : null;
  const detail = songId ? held.details[songId] : undefined;

  const [load, setLoad] = useState<"loading" | "ready" | "gone" | "error">("loading");
  const [tries, setTries] = useState(0);
  const intentRef = useRef<JamIntent | null>(null);
  const handledIntent = useRef<string | null>(null);

  // The song, and the one thing a link from outside asked to do with it.
  useEffect(() => {
    if (!songId || !me.enabled) {
      return;
    }
    let cancelled = false;
    setLoad("loading");
    const asked = jamStoreEpoch();
    void (async () => {
      try {
        const answer = await fetchJamSong(songId);
        if (cancelled) return;
        putJamSongOnWall(key, answer.song, asked);
        const intent = takePublicJamIntent(songId);
        intentRef.current = intent;
        if (intent && intent.kind === "song" && intent.act === "like") {
          // The heart somebody pressed before they had an account, once, now.
          await likePublicJam(songId, true).catch(() => undefined);
        }
        if (!cancelled) setLoad("ready");
      } catch (failure) {
        if (cancelled) return;
        const status = (failure as { status?: unknown } | null)?.status;
        setLoad(status === 404 || status === 403 ? "gone" : "error");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [songId, me.enabled, key, tries]);

  // Record or report: once the detail says what this person may do.
  useEffect(() => {
    const intent = intentRef.current;
    if (!songId || !song || !detail || !intent || intent.kind !== "song" || handledIntent.current === songId) {
      return;
    }
    handledIntent.current = songId;
    intentRef.current = null;
    if (intent.act === "report") {
      setReport({ kind: "jam_public", songId, trackId: intent.trackId ?? null, subjectName: song.title });
      return;
    }
    if (intent.record && me.uploads) {
      const addable = detail.viewer.addableInstruments;
      const instrument =
        intent.instrument && addable.includes(intent.instrument)
          ? intent.instrument
          : pickInstrument(song, addable, []);
      if (instrument) {
        setStudio({ mode: "over", instrument });
      }
    }
  }, [songId, song, detail, me.uploads]);

  function onStart(result: JamStartResult) {
    setStartOpen(false);
    setStudio({ mode: "new", draft: result.draft, instrument: result.instrument });
  }

  function record(instrument: JamInstrument) {
    setFreshTrackId(null);
    setStudio({ mode: "over", instrument });
  }

  const frame = (children: React.ReactNode) => (
    <div ref={rootRef} className="fixed inset-0 z-40 flex bg-surface-0" data-jam-public-view={target}>
      <div className="relative mx-auto flex min-h-0 w-full max-w-[64rem] flex-col bg-surface-1 lg:border-x lg:border-border">
        {children}
      </div>
    </div>
  );

  const message = (text: string, action?: { label: string; onClick: () => void }) =>
    frame(
      <>
        <header className="flex items-center gap-2 border-b border-border px-2 py-2">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("jam.song.back")}
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
          <h1 className="font-display text-lg font-extrabold text-text">{t("jam.public.view.title")}</h1>
        </header>
        <div className="grid flex-1 place-items-center px-6 text-center" role="status">
          <div className="flex max-w-xs flex-col items-center gap-3">
            <p className="text-sm text-text-secondary [text-wrap:pretty]">{text}</p>
            {action && (
              <Button variant="secondary" onClick={action.onClick}>
                {action.label}
              </Button>
            )}
          </div>
        </div>
      </>,
    );

  if (me.loaded && !me.enabled) {
    return message(t("jam.public.view.off"));
  }

  // Starting one: the sheet, then the studio. Nothing else of the screen yet.
  if (isNew) {
    return frame(
      <>
        <JamStartSheet
          open={startOpen}
          onClose={() => {
            setStartOpen(false);
            onClose();
          }}
          onStart={onStart}
        />
        {studio?.mode === "new" && (
          <JamStudio
            channelId={key}
            song={null}
            tracks={[]}
            draft={studio.draft}
            viewerId={viewerId}
            canSwitchMix
            songDeleted={false}
            addable={JAM_INSTRUMENT_ORDER}
            initialInstrument={studio.instrument}
            publicAccess
            onClose={() => {
              setStudio(null);
              setStartOpen(false);
              onClose();
            }}
            onLeaveToWall={() => {
              setStudio(null);
              onClose();
            }}
            onPosted={({ songId: made }) => {
              setStudio(null);
              onSongStarted(made);
            }}
          />
        )}
      </>,
    );
  }

  if (load === "gone") {
    return message(t("jam.public.view.gone"));
  }
  if (load === "error") {
    return message(t("jam.public.view.error"), { label: t("jam.wall.retry"), onClick: () => setTries((n) => n + 1) });
  }
  if (!song || load === "loading") {
    return frame(
      <div className="grid flex-1 place-items-center" aria-busy="true" aria-label={t("jam.wall.loading")}>
        <div className="h-24 w-24 rounded-[var(--radius-panel)] bg-surface-2 motion-safe:animate-pulse" />
      </div>,
    );
  }

  return frame(
    <>
      <div className="min-h-0 flex-1" inert={studio !== null}>
        <JamSongPanel
          key={song.id}
          channelId={key}
          song={song}
          detail={detail}
          viewerId={viewerId}
          enabled={me.enabled}
          uploads={me.uploads}
          freshTrackId={freshTrackId}
          autoplay={false}
          publicView
          onRecord={(instrument) => record(instrument)}
          onClose={onClose}
        />
      </div>
      {studio?.mode === "over" && (
        <JamStudio
          channelId={key}
          song={song}
          tracks={detail?.tracks ?? []}
          draft={null}
          viewerId={viewerId}
          canSwitchMix={detail ? detail.viewer.isAuthor : false}
          songDeleted={false}
          addable={detail?.viewer.addableInstruments ?? [studio.instrument]}
          initialInstrument={studio.instrument}
          publicAccess
          onClose={() => setStudio(null)}
          onLeaveToWall={() => setStudio(null)}
          onPosted={({ trackId }) => {
            setFreshTrackId(trackId);
            setStudio(null);
            void loadJamDetail(key, song.id, { force: true });
          }}
        />
      )}
      {report && <ReportDialog target={report} onClose={() => setReport(null)} />}
    </>,
  );
}
