import type { JamPublicSongForViewer, JamSongSummary, JamTrack } from "@pqp/shared";
import { Flag, Globe, Heart, Link2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ReportTarget } from "@/components/chat/report-dialog";
import { ReportDialog } from "@/components/deferred-panels";
import type { ContextMenuItemDef } from "@/components/ui/context-menu";
import { useJamPublication } from "@/hooks/use-jam-publication";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { fetchPublicSongForViewer, likePublicJam } from "@/lib/jam-public-api";
import { publicJamShareUrl } from "@/lib/jam-public-links";
import {
  answerConsent,
  useJamPublicMe,
  useJamPublicWaiting,
} from "@/lib/jam-public-store";
import { cn } from "@/lib/utils";
import { JamConsentChoices, useConsentAnswer } from "./jam-public-parts";
import { JamPublicSheet } from "./jam-public-sheet";

/**
 * What a song panel knows about public jams, in one place so the panel itself
 * only has to ask. Used by both ways in: a channel's song (its starter may make
 * it public; a person with a part may be asked to agree) and a public jam
 * opened from outside any channel (anybody may like it, report it, copy its
 * link; its starter looks after outside takes).
 *
 * Everything returned is empty while the flag is off.
 */

export interface UseJamPublicPanelArgs {
  song: JamSongSummary;
  viewerId: string | null;
  isStarter: boolean;
  tracks: readonly JamTrack[];
  /** Opened from outside any channel (`/app/jam/<id>`). */
  publicView: boolean;
  /** The channel's server, for the "shown as coming from" line and the sheet. */
  originName: string | null;
  /** Told whenever the song's auto-accept switch is known or changes, for a sibling (the studio) that words an outside take by it. */
  onAutoAcceptChange?: (on: boolean) => void;
}

export interface JamPublicPanelPieces {
  /** Entries for the song's `...` menu. */
  menuItems: ContextMenuItemDef[];
  /** The quiet lines under the title. Null when there is nothing to say. */
  strip: ReactNode;
  /** The starter's outside takes, which the panel lists apart from the band. */
  pendingTakeIds: ReadonlySet<string>;
  /** Dialogs (the sheet, a report). */
  overlays: ReactNode;
  /** Report one part of the song. Undefined when this viewer has nothing to report (their own part, a private song). */
  reportTrack: ((trackId: string) => void) | undefined;
  /** In a public view the share button copies the public address. */
  copyLink: (() => void) | undefined;
  /** The viewer started this song and public jams are on: the song's public state changed (refresh what depends on it). */
  refreshPublication: () => void;
  /** The starter turned on auto-accept: outside parts go in the mix by themselves once the platform's checks clear. */
  autoAccept: boolean;
}

export function useJamPublicPanel(args: UseJamPublicPanelArgs): JamPublicPanelPieces {
  const { song, viewerId, isStarter, tracks, publicView, originName, onAutoAcceptChange } = args;
  const { t } = useTranslation();
  const me = useJamPublicMe();
  const waiting = useJamPublicWaiting();
  const mineCount = tracks.filter((track) => viewerId !== null && track.authorId === viewerId).length;
  const involved = isStarter || mineCount > 0;
  const state = useJamPublication(song.id, me.enabled && involved);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [report, setReport] = useState<ReportTarget | null>(null);
  const [copied, setCopied] = useState(false);
  const copyTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
    },
    [],
  );

  // What a visitor sees of a public jam: its counts, where it came from, whether they liked it.
  const [meta, setMeta] = useState<JamPublicSongForViewer | null>(null);
  const [liked, setLiked] = useState(false);
  const [likes, setLikes] = useState(0);
  const [likeBusy, setLikeBusy] = useState(false);
  useEffect(() => {
    if (!publicView || !me.enabled) {
      setMeta(null);
      return;
    }
    let cancelled = false;
    void fetchPublicSongForViewer(song.id).then(
      (answer) => {
        if (cancelled) return;
        setMeta(answer);
        setLiked(answer.viewer.liked);
        setLikes(answer.song.likes);
      },
      () => {
        // Not listed yet (a song nobody has a public part in): no counts to show.
        if (!cancelled) setMeta(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [publicView, me.enabled, song.id]);

  async function toggleLike() {
    if (likeBusy) return;
    const next = !liked;
    setLikeBusy(true);
    setLiked(next);
    setLikes((before) => Math.max(0, before + (next ? 1 : -1)));
    try {
      const answer = await likePublicJam(song.id, next);
      setLiked(answer.liked);
      setLikes(answer.likes);
    } catch {
      setLiked(!next);
      setLikes((before) => Math.max(0, before + (next ? -1 : 1)));
    } finally {
      setLikeBusy(false);
    }
  }

  const copyLink = useCallback(() => {
    const url = publicJamShareUrl(song.id);
    const done = () => {
      setCopied(true);
      if (copyTimer.current !== null) window.clearTimeout(copyTimer.current);
      copyTimer.current = window.setTimeout(() => setCopied(false), 2600);
    };
    void navigator.clipboard?.writeText(url).then(done, () => undefined);
  }, [song.id]);

  // Answers arrive while the song is open: the sheet reads again every time it opens.
  const refreshPublication = state.refresh;
  useEffect(() => {
    if (sheetOpen) {
      void refreshPublication();
    }
  }, [sheetOpen, refreshPublication]);

  const publication = state.publication;
  // The starter's and a participant's read says it; so does the public read a visitor holds.
  const autoAccept = (publication ? publication.autoAcceptOutside : meta?.song.autoAcceptOutside) === true;
  useEffect(() => {
    onAutoAcceptChange?.(autoAccept);
  }, [autoAccept, onAutoAcceptChange]);
  const on = publication !== null && ["live", "review", "hidden"].includes(publication.status);
  const canPublish = me.enabled && isStarter && me.publishing !== "blocked" && song.channelId !== null;
  const showSheet = me.enabled && isStarter && (canPublish || on);
  const pendingConsent = waiting.consents.some((one) => one.songId === song.id);
  const consent = useConsentAnswer(answerConsent);
  const [changing, setChanging] = useState(false);
  const pendingTakeIds = useMemo(
    () => new Set(waiting.inbox.filter((one) => one.songId === song.id).map((one) => one.track.id)),
    [waiting.inbox, song.id],
  );

  const menuItems: ContextMenuItemDef[] = [];
  if (me.enabled) {
    if (showSheet) {
      menuItems.push({
        id: "public",
        label: on ? t("jam.public.menu.manage") : t("jam.public.menu.publish"),
        icon: Globe,
        onSelect: () => setSheetOpen(true),
      });
    }
    if (publicView) {
      menuItems.push({ id: "copy-link", label: t("jam.public.menu.copyLink"), icon: Link2, onSelect: copyLink });
      if (!isStarter) {
        menuItems.push({
          id: "report",
          label: t("jam.public.menu.report"),
          icon: Flag,
          onSelect: () => setReport({ kind: "jam_public", songId: song.id, trackId: null, subjectName: song.title }),
        });
      }
    }
  }

  // ---- the quiet lines under the title ---------------------------------------
  const lines: ReactNode[] = [];
  if (me.enabled && isStarter && on && publication) {
    // One fact and the way in. Who answered is in the sheet; the outside requests are listed below the stage.
    const bits = [t(`jam.public.status.short.${publication.status}` as MessageKey)];
    if (publication.autoAcceptOutside) {
      bits.push(t("jam.public.status.autoAccept"));
    }
    lines.push(
      <p key="status" data-jam-public-line="status" className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-text-secondary">
        <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>{bits.join(" · ")}</span>
        <button
          type="button"
          onClick={() => setSheetOpen(true)}
          data-jam-public-manage=""
          className="inline-flex min-h-8 items-center rounded-full bg-surface-2 px-3 text-xs font-bold text-text outline-none ring-1 ring-border transition-colors duration-[var(--duration-fast)] hover:bg-border focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:min-h-11"
        >
          {t("jam.public.menu.manageShort")}
        </button>
      </p>,
    );
  }
  if (me.enabled && pendingConsent && !isStarter) {
    lines.push(
      <div
        key="consent"
        data-jam-public-line="consent"
        className="flex flex-col gap-2 rounded-[var(--radius-card)] bg-surface-2 px-3.5 py-3"
      >
        <p className="text-sm font-semibold leading-snug text-text">{t("jam.public.consent.ask", { title: song.title })}</p>
        <p className="text-[13px] leading-snug text-text-secondary">{t("jam.public.consent.askHint")}</p>
        <JamConsentChoices busy={consent.busy} onChoose={(choice) => void consent.choose(song.id, choice).then(() => state.refresh())} />
        {consent.error && (
          <p role="alert" className="text-[13px] text-danger">
            {consent.error}
          </p>
        )}
      </div>,
    );
  }
  // My answer, once given: shown, and changeable any time (the starter does it in the sheet).
  const myParts = publication ? publication.parts.filter((part) => viewerId !== null && part.authorId === viewerId && part.inMix && part.consent !== "pending" && !isStarter) : [];
  const myAnswer = myParts.length > 0 && myParts.every((part) => part.consent === myParts[0]!.consent) ? myParts[0]!.consent : null;
  if (me.enabled && !isStarter && on && !pendingConsent && myParts.length > 0) {
    lines.push(
      <div key="answer" data-jam-public-line="answer" className="flex flex-col gap-2">
        <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold text-text-secondary">
          <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>
            {t("jam.public.status.short.live")} · {t("jam.public.consent.mine", { answer: myAnswer ? t(`jam.public.consent.state.${myAnswer}` as MessageKey) : t("jam.public.consent.mixed") })}
          </span>
          <button
            type="button"
            onClick={() => setChanging((open) => !open)}
            aria-expanded={changing}
            data-jam-public-change=""
            className="rounded-sm font-bold text-accent underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {t("jam.public.consent.change")}
          </button>
        </p>
        {changing && (
          <JamConsentChoices
            current={myAnswer && myAnswer !== "pending" ? myAnswer : undefined}
            busy={consent.busy}
            onChoose={(choice) =>
              void consent.choose(song.id, choice).then((taken) => {
                if (taken) {
                  setChanging(false);
                  void state.refresh();
                }
              })
            }
          />
        )}
        {consent.error && (
          <p role="alert" className="text-[13px] text-danger">
            {consent.error}
          </p>
        )}
      </div>,
    );
  }
  const waitsForStarter = publicView && !isStarter && tracks.some((track) => track.authorId === viewerId && !track.inMix);
  if (me.enabled && waitsForStarter) {
    lines.push(
      <p key="waiting" data-jam-public-line="waiting" role="status" className="text-[13px] font-semibold text-text-secondary">
        {autoAccept ? t("jam.public.outside.waitingAuto") : t("jam.public.outside.waiting")}
      </p>,
    );
  }
  if (me.enabled && publicView && !isStarter && autoAccept && !waitsForStarter) {
    lines.push(
      <p key="auto" data-jam-public-line="auto-accept" className="text-[13px] font-semibold text-text-secondary">
        {t("jam.public.status.autoAcceptPublic")}
      </p>,
    );
  }
  if (me.enabled && publicView && (meta || copied)) {
    const origin = meta?.song.origin ?? null;
    lines.push(
      <p key="meta" data-jam-public-line="meta" className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] font-semibold text-text-secondary">
        {meta && (
          <button
            type="button"
            aria-pressed={liked}
            onClick={() => void toggleLike()}
            data-jam-like=""
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-2.5 outline-none transition-colors duration-[var(--duration-fast)] hover:bg-surface-2 focus-visible:ring-2 focus-visible:ring-focus-ring pointer-coarse:h-11",
              liked ? "text-accent" : "text-text-secondary hover:text-text",
            )}
          >
            <Heart className={cn("h-4 w-4", liked && "fill-current")} aria-hidden />
            <span>{liked ? t("jam.public.liked") : t("jam.public.like")}</span>
            {likes > 1 && <span className="tabular-nums" data-jam-likes="">{likes}</span>}
          </button>
        )}
        {meta && meta.song.plays > 0 && (
          <span data-jam-plays="">{t("jam.public.plays", { count: meta.song.plays, countLabel: meta.song.plays })}</span>
        )}
        {origin &&
          (origin.slug ? (
            <a
              href={`/c/${origin.slug}`}
              target="_blank"
              rel="noreferrer"
              data-jam-origin=""
              className="rounded-sm underline-offset-2 hover:text-text hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-focus-ring"
            >
              {t("jam.public.origin", { name: origin.name })}
            </a>
          ) : (
            <span data-jam-origin="">{t("jam.public.origin", { name: origin.name })}</span>
          ))}
        {copied && (
          <span role="status" data-jam-copied="">
            {t("jam.public.linkCopied")}
          </span>
        )}
      </p>,
    );
  }

  const strip = lines.length > 0 ? <div className="flex flex-col gap-2 px-3 pt-3 sm:px-5" data-jam-public-strip="">{lines}</div> : null;

  const reportTrack = me.enabled && publicView
    ? (trackId: string) => {
        const track = tracks.find((one) => one.id === trackId);
        setReport({ kind: "jam_public", songId: song.id, trackId, subjectName: track?.authorName ?? null });
      }
    : undefined;

  const overlays = (
    <>
      {showSheet && (
        <JamPublicSheet
          open={sheetOpen}
          onClose={() => setSheetOpen(false)}
          songId={song.id}
          viewerId={viewerId}
          songTitle={song.title}
          originName={originName}
          state={state}
          publicUrl={publicJamShareUrl(song.id)}
        />
      )}
      {report && <ReportDialog target={report} onClose={() => setReport(null)} />}
    </>
  );

  return {
    menuItems,
    strip,
    pendingTakeIds,
    overlays,
    reportTrack,
    copyLink: publicView && me.enabled ? copyLink : undefined,
    refreshPublication: () => void state.refresh(),
    autoAccept,
  };
}
