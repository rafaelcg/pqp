import type { JamPublicMyPart } from "@pqp/shared";
import { ArrowLeft, Check, Clock, ExternalLink, Music2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { bidiClean } from "@/lib/bidi";
import { useTranslation, type MessageKey } from "@/lib/i18n";
import { JAM_INSTRUMENT_LOOK } from "@/lib/jam-instruments";
import { escapeOwnedByOverlay } from "@/lib/escape-unless-overlay";
import { fetchJamPublicMine, fetchJamPublicMyParts } from "@/lib/jam-public-api";
import { jamSiteHomeUrl } from "@/lib/jam-public-links";
import { openPublicJamById, startPublicJam } from "@/lib/jam-public-nav";
import { useJamPublicWaiting } from "@/lib/jam-public-store";
import { mineIsEmpty, minePartState, orderMineParts, waitingOn } from "@/lib/jam-mine";
import { cn } from "@/lib/utils";
import { JamCoverPhoto, useJamCover } from "./jam-cover";

/**
 * "Tuas músicas" (`/app/jam/mine`): the one place a returning person finds the
 * songs they started and the parts they sent, each with where it stands. It is
 * the door the site's account chip opens (user test round 3, N-3: the chip took
 * a returning visitor to the chat home, and she learned her part had been
 * accepted only because two notices happened to be on screen), and the Jam wall
 * and the compass carry the same door.
 *
 * It covers the app like a public jam does and has its own way back to the
 * site, so a visitor who arrived from there is never left in the chat product
 * with nothing to go back to (finding M1) and no strip is needed for it.
 */

/**
 * Each list has its own read, its own error and its own retry: with one endpoint down the other
 * still shows (Farol, PR 1778), and a person is told which half is missing.
 */
type Section<T> = { status: "loading" } | { status: "error" } | { status: "ready"; items: T[] };

/** How many rows of a list are drawn before "Ver mais": a long history is not a hundred covers at once. */
export const MINE_PAGE = 12;

function useSection<T>(read: () => Promise<T[]>): { section: Section<T>; retry: () => void } {
  const [section, setSection] = useState<Section<T>>({ status: "loading" });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setSection({ status: "loading" });
    read().then(
      (items) => {
        if (!cancelled) setSection({ status: "ready", items });
      },
      () => {
        if (!cancelled) setSection({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
    // `read` is a module function: one read per try.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tries]);
  return { section, retry: () => setTries((n) => n + 1) };
}

const readStarted = async () => (await fetchJamPublicMine()).songs;
const readParts = async () => orderMineParts((await fetchJamPublicMyParts()).parts);

function SectionError({ onRetry, kind }: { onRetry: () => void; kind: "started" | "parts" }) {
  const { t } = useTranslation();
  return (
    <div role="status" className="flex flex-col items-start gap-2 rounded-[var(--radius-card)] bg-surface-2 p-3" data-jam-mine-error={kind}>
      <p className="text-sm text-text-secondary">{t("jam.mine.error")}</p>
      <Button variant="secondary" size="sm" className="pointer-coarse:h-11" onClick={onRetry}>
        {t("jam.wall.retry")}
      </Button>
    </div>
  );
}

function Skeleton() {
  const { t } = useTranslation();
  return (
    <div aria-busy="true" aria-label={t("jam.mine.loading")} className="flex flex-col gap-3" data-jam-mine-loading="">
      {[0, 1].map((index) => (
        <div key={index} className="h-[4.5rem] rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse" />
      ))}
    </div>
  );
}

function MoreButton({ shown, total, onMore }: { shown: number; total: number; onMore: () => void }) {
  const { t } = useTranslation();
  if (shown >= total) {
    return null;
  }
  return (
    <Button variant="secondary" className="mt-3 w-full" onClick={onMore} data-jam-mine-more="">
      {t("jam.wall.more")}
    </Button>
  );
}

export function JamMineView({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const { inbox } = useJamPublicWaiting();
  const started = useSection(readStarted);
  const parts = useSection(readParts);
  const [startedShown, setStartedShown] = useState(MINE_PAGE);
  const [partsShown, setPartsShown] = useState(MINE_PAGE);

  // Escape leaves, unless a dialog owns the key.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || escapeOwnedByOverlay(event)) {
        return;
      }
      onClose();
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const siteHref = jamSiteHomeUrl(window.location, locale);

  return (
    <div className="fixed inset-0 z-40 flex bg-surface-0" data-jam-mine="">
      <div className="relative mx-auto flex min-h-0 w-full max-w-[40rem] flex-col bg-surface-1 sm:border-x sm:border-border">
        <header className="flex items-center gap-2 border-b border-border px-2 py-2">
          <button
            type="button"
            onClick={onClose}
            aria-label={t("jam.mine.back")}
            data-jam-mine-back=""
            className="grid h-11 w-11 shrink-0 place-items-center rounded-full text-text-secondary outline-none hover:bg-surface-2 hover:text-text focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            <ArrowLeft className="h-5 w-5" aria-hidden />
          </button>
          <h1 className="min-w-0 flex-1 truncate font-display text-lg font-extrabold text-text">{t("jam.mine.title")}</h1>
          <a
            href={siteHref}
            data-jam-mine-site=""
            className="inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-bold text-accent outline-none hover:underline focus-visible:ring-2 focus-visible:ring-focus-ring"
          >
            {t("jam.mine.site")}
            <ExternalLink className="h-3.5 w-3.5" aria-hidden />
          </a>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-8 pt-4 sm:px-5">
          {started.section.status === "ready" && parts.section.status === "ready" && mineIsEmpty(started.section.items, parts.section.items) && (
            <div className="mt-6 flex flex-col items-start gap-3 rounded-[var(--radius-card)] bg-surface-2 p-4" data-jam-mine-empty="">
              <h2 className="font-display text-lg font-extrabold text-text">{t("jam.mine.empty.title")}</h2>
              <p className="text-sm leading-snug text-text-secondary [text-wrap:pretty]">{t("jam.mine.empty.body")}</p>
              <Button onClick={startPublicJam}>{t("jam.mine.empty.start")}</Button>
            </div>
          )}

          {/* What I started: shown whenever its own read says something, an empty list draws no header. */}
          {started.section.status === "loading" && <Skeleton />}
          {started.section.status === "error" && (
            <div className="mb-6">
              <SectionError kind="started" onRetry={started.retry} />
            </div>
          )}
          {started.section.status === "ready" && started.section.items.length > 0 && (
            <section aria-labelledby="jam-mine-started" data-jam-mine-started="" className="mb-8">
              <h2 id="jam-mine-started" className="mb-2.5 font-display text-base font-extrabold text-text">
                {t("jam.mine.started")}
              </h2>
              <ul className="flex flex-col gap-2">
                {started.section.items.slice(0, startedShown).map(({ song, publication }) => {
                  const waiting = waitingOn(song.id, inbox);
                  return (
                    <li key={song.id} className="[content-visibility:auto] [contain-intrinsic-size:auto_4.5rem]">
                      <button
                        type="button"
                        onClick={() => openPublicJamById(song.id)}
                        data-jam-mine-song={song.id}
                        data-waiting={waiting}
                        className="flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-surface-2 p-3 text-left outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
                      >
                        <MineCover url={song.coverUrl} />
                        <span className="flex min-w-0 flex-1 flex-col leading-snug">
                          <span className="truncate text-[15px] font-bold text-text">{bidiClean(song.title)}</span>
                          <span className="truncate text-[13px] text-text-secondary">
                            {t(`jam.public.status.short.${publication.status}` as MessageKey)}
                          </span>
                          {waiting > 0 && (
                            <span className="mt-1 inline-flex w-fit items-center rounded-full bg-accent-soft px-2 py-0.5 text-[12px] font-bold text-on-accent-soft" data-jam-mine-waiting="">
                              {t("jam.mine.waitingCount", { count: waiting, countLabel: waiting })}
                            </span>
                          )}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ul>
              <MoreButton shown={startedShown} total={started.section.items.length} onMore={() => setStartedShown((n) => n + MINE_PAGE)} />
            </section>
          )}

          {/* What I sent. */}
          {parts.section.status === "loading" && <Skeleton />}
          {parts.section.status === "error" && <SectionError kind="parts" onRetry={parts.retry} />}
          {parts.section.status === "ready" && parts.section.items.length > 0 && (
            <section aria-labelledby="jam-mine-parts" data-jam-mine-parts="" className="mb-4">
              <h2 id="jam-mine-parts" className="mb-2.5 font-display text-base font-extrabold text-text">
                {t("jam.mine.parts")}
              </h2>
              <ul className="flex flex-col gap-2">
                {parts.section.items.slice(0, partsShown).map((part) => (
                  <MinePartRow key={part.trackId} part={part} />
                ))}
              </ul>
              <MoreButton shown={partsShown} total={parts.section.items.length} onMore={() => setPartsShown((n) => n + MINE_PAGE)} />
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function MineCover({ url }: { url: string | null }) {
  const cover = useJamCover(url);
  return (
    <span aria-hidden="true" className="relative grid h-12 w-12 shrink-0 place-items-center overflow-hidden rounded-[var(--radius-control)] bg-surface-3 text-text-secondary">
      {cover.src !== null && cover.status !== "failed" ? <JamCoverPhoto cover={cover} /> : <Music2 className="h-5 w-5" />}
    </span>
  );
}

function MinePartRow({ part }: { part: JamPublicMyPart }) {
  const { t } = useTranslation();
  const look = JAM_INSTRUMENT_LOOK[part.instrument];
  const Icon = look.icon;
  const { key, name } = minePartState(part);
  const StateIcon = part.state === "in" ? Check : part.state === "refused" ? X : Clock;
  return (
    <li className="[content-visibility:auto] [contain-intrinsic-size:auto_4.5rem]">
      <button
        type="button"
        onClick={() => openPublicJamById(part.songId)}
        data-jam-mine-part={part.trackId}
        data-state={part.state}
        className="flex w-full items-center gap-3 rounded-[var(--radius-card)] bg-surface-2 p-3 text-left outline-none transition-colors hover:bg-surface-3 focus-visible:ring-2 focus-visible:ring-focus-ring"
      >
        <span className={cn("grid h-12 w-12 shrink-0 place-items-center rounded-[var(--radius-control)]", look.fill)}>
          <Icon className="h-5 w-5" aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col leading-snug">
          <span className="truncate text-[15px] font-bold text-text">{bidiClean(part.title)}</span>
          <span className="truncate text-[13px] text-text-secondary">
            {t("jam.mine.part", { instrument: t(look.nameKey as MessageKey).toLowerCase() })}
          </span>
          <span
            className={cn(
              "mt-1 inline-flex w-fit max-w-full items-center gap-1 rounded-full px-2 py-0.5 text-[12px] font-bold",
              part.state === "waiting" && "bg-accent-soft text-on-accent-soft",
              part.state === "in" && "bg-surface-3 text-text",
              part.state === "refused" && "bg-surface-3 text-text-secondary",
            )}
            data-jam-mine-state=""
          >
            <StateIcon className="h-3 w-3 shrink-0" aria-hidden />
            <span className="truncate">{t(key as MessageKey, { name: bidiClean(name ?? "") })}</span>
          </span>
        </span>
      </button>
    </li>
  );
}
