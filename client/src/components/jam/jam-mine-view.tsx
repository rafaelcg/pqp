import type { JamPublicMineResponse, JamPublicMyPart } from "@pqp/shared";
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

type Load =
  | { status: "loading" }
  | { status: "error" }
  | { status: "ready"; started: JamPublicMineResponse["songs"]; parts: JamPublicMyPart[] };

export function JamMineView({ onClose }: { onClose: () => void }) {
  const { t, locale } = useTranslation();
  const { inbox } = useJamPublicWaiting();
  const [load, setLoad] = useState<Load>({ status: "loading" });
  const [tries, setTries] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoad({ status: "loading" });
    void Promise.all([fetchJamPublicMine(), fetchJamPublicMyParts()]).then(
      ([mine, parts]) => {
        if (!cancelled) setLoad({ status: "ready", started: mine.songs, parts: orderMineParts(parts.parts) });
      },
      () => {
        if (!cancelled) setLoad({ status: "error" });
      },
    );
    return () => {
      cancelled = true;
    };
  }, [tries]);

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
          {load.status === "loading" && (
            <div aria-busy="true" aria-label={t("jam.mine.loading")} className="flex flex-col gap-3" data-jam-mine-loading="">
              {[0, 1, 2].map((index) => (
                <div key={index} className="h-[4.5rem] rounded-[var(--radius-card)] bg-surface-2 motion-safe:animate-pulse" />
              ))}
            </div>
          )}

          {load.status === "error" && (
            <div role="status" className="mt-10 flex flex-col items-center gap-3 text-center" data-jam-mine-error="">
              <p className="text-sm text-text-secondary">{t("jam.mine.error")}</p>
              <Button variant="secondary" onClick={() => setTries((n) => n + 1)}>
                {t("jam.wall.retry")}
              </Button>
            </div>
          )}

          {load.status === "ready" && mineIsEmpty(load.started, load.parts) && (
            <div className="mt-6 flex flex-col items-start gap-3 rounded-[var(--radius-card)] bg-surface-2 p-4" data-jam-mine-empty="">
              <h2 className="font-display text-lg font-extrabold text-text">{t("jam.mine.empty.title")}</h2>
              <p className="text-sm leading-snug text-text-secondary [text-wrap:pretty]">{t("jam.mine.empty.body")}</p>
              <Button onClick={startPublicJam}>{t("jam.mine.empty.start")}</Button>
            </div>
          )}

          {load.status === "ready" && load.started.length > 0 && (
            <section aria-labelledby="jam-mine-started" data-jam-mine-started="" className="mb-8">
              <h2 id="jam-mine-started" className="mb-2.5 font-display text-base font-extrabold text-text">
                {t("jam.mine.started")}
              </h2>
              <ul className="flex flex-col gap-2">
                {load.started.map(({ song, publication }) => {
                  const waiting = waitingOn(song.id, inbox);
                  return (
                    <li key={song.id}>
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
            </section>
          )}

          {load.status === "ready" && load.parts.length > 0 && (
            <section aria-labelledby="jam-mine-parts" data-jam-mine-parts="" className="mb-4">
              <h2 id="jam-mine-parts" className="mb-2.5 font-display text-base font-extrabold text-text">
                {t("jam.mine.parts")}
              </h2>
              <ul className="flex flex-col gap-2">
                {load.parts.map((part) => (
                  <MinePartRow key={part.trackId} part={part} />
                ))}
              </ul>
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
      {cover.src !== null && cover.status !== "failed" ? <JamCoverPhoto cover={cover} eager /> : <Music2 className="h-5 w-5" />}
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
    <li>
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
