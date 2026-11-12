import type { PublicJamSong } from "@pqp/shared";
import { HeartIcon as Heart, MicIcon as Mic, PlayIcon as Play } from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { detectLocale } from "@/lib/locale";
import { SongArt } from "./art";
import { useAsk } from "./auth-sheet";
import { useHead } from "./head";
import { INSTRUMENT_LOOK, INSTRUMENTS, asInstrument, type Instrument } from "./instruments";
import { unlockAudioInGesture, warmJamEngine } from "./player";
import { Link, useJamRoute } from "./router";
import { jamPath } from "./route";
import { CONTAINER } from "./shell";
import { Badge } from "./tiles";
import { button, focusRing, Skeleton } from "./ui";
import { useFeatured, useJamList, type JamTab } from "./use-jam-data";
import { cn, compactCount, instrumentName, listOf, personLabel } from "./util";

const TABS: readonly JamTab[] = ["top", "needs", "new", "done"];

/** "Falta um baixo." / "Faltam baixo e voz.": what a song still asks for, as a sentence. */
function needSentence(needs: readonly string[]): string {
  const locale = detectLocale();
  const first = needs[0];
  if (!first) return "";
  if (needs.length === 1) {
    return jt(`needs.${asInstrument(first)}` as Parameters<typeof jt>[0]);
  }
  return jt("needs.many", { list: listOf(needs.map(instrumentName), locale) });
}

function useSongPath() {
  const { mount } = useJamRoute();
  return (song: Pick<PublicJamSong, "id">) => jamPath(mount, { kind: "song", songId: song.id });
}

function Meta({ song, className, stacked = false }: { song: PublicJamSong; className?: string; stacked?: boolean }) {
  const locale = detectLocale();
  const origin = song.origin?.name ?? (song.startedBy.handle ? `@${song.startedBy.handle}` : personLabel(song.startedBy));
  const stats = (
    <span className="flex shrink-0 items-center gap-x-1.5 whitespace-nowrap">
      <span>{jt("card.plays", { count: song.plays, countLabel: compactCount(song.plays, locale) })}</span>
      {song.likes > 1 && (
        <>
          <span aria-hidden="true">·</span>
          <span className="inline-flex items-center gap-1" aria-label={jt("card.likes", { count: song.likes })}>
            <Heart className="h-3 w-3" aria-hidden />
            {song.likes}
          </span>
        </>
      )}
    </span>
  );
  if (stacked) {
    // A card: the origin on its own line so a long server name never eats the numbers.
    return (
      <div className={cn("min-w-0 text-[13px] leading-5 text-text-tertiary", className)}>
        <p className="truncate">{origin}</p>
        {stats}
      </div>
    );
  }
  return (
    <p className={cn("flex min-w-0 items-center gap-x-1.5 text-[13px] text-text-tertiary", className)}>
      <span className="min-w-0 truncate">{origin}</span>
      <span aria-hidden="true">·</span>
      {stats}
    </p>
  );
}

/** Opens the song and starts it: the audio is unlocked inside this very click. */
function PlayButton({ song, size, label }: { song: PublicJamSong; size: "card" | "hero"; label: string }) {
  const path = useSongPath()(song);
  return (
    <Link
      href={path}
      state={{ autoplay: true }}
      aria-label={label}
      data-jam-play={song.id}
      onPointerEnter={() => void warmJamEngine()}
      onFocus={() => void warmJamEngine()}
      onClick={() => unlockAudioInGesture()}
      className={cn(
        "relative z-10 grid shrink-0 place-items-center rounded-full bg-accent text-on-accent transition-transform duration-[var(--duration-fast)] hover:scale-105 motion-reduce:transition-none motion-reduce:hover:scale-100",
        focusRing,
        size === "hero" ? "h-16 w-16" : "h-11 w-11",
      )}
    >
      <Play className={size === "hero" ? "h-7 w-7" : "h-5 w-5"} fill="currentColor" aria-hidden />
    </Link>
  );
}

function Card({ song }: { song: PublicJamSong }) {
  const path = useSongPath()(song);
  return (
    <article data-jam-card={song.id} className="group relative flex min-w-0 flex-col">
      <div className="overflow-hidden rounded-[var(--radius-panel)]">
        <SongArt song={song} variant="card" />
      </div>
      <div className="mt-3 flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-bold leading-snug">
            <Link
              href={path}
              className="rounded-sm outline-none after:absolute after:inset-0 after:z-0 after:rounded-[var(--radius-panel)] focus-visible:after:ring-2 focus-visible:after:ring-focus-ring"
            >
              {song.title}
            </Link>
          </h3>
          <Meta song={song} className="mt-0.5" stacked />
        </div>
        <PlayButton song={song} size="card" label={jt("home.play", { title: song.title })} />
      </div>
    </article>
  );
}

function CardSkeleton() {
  return (
    <div aria-hidden="true">
      <Skeleton className="aspect-[4/5] rounded-[var(--radius-panel)]" />
      <Skeleton className="mt-3 h-4 w-3/4" />
      <Skeleton className="mt-2 h-3 w-1/2" />
    </div>
  );
}

function Hero() {
  const { song, status } = useFeatured();
  const path = useSongPath();
  const locale = detectLocale();
  if (status === "loading") {
    return (
      <div className="grid gap-6 pb-2 pt-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-center lg:gap-12 lg:pt-10" aria-hidden="true">
        <Skeleton className="aspect-[16/10] w-full rounded-[var(--radius-panel)]" />
        <div>
          <Skeleton className="h-3 w-24" />
          <Skeleton className="mt-4 h-14 w-3/4" />
          <Skeleton className="mt-4 h-4 w-1/2" />
        </div>
      </div>
    );
  }
  if (!song) return null;
  const people = song.parts.map((part) => part.person.name).filter(Boolean);
  return (
    <section aria-label={jt("home.featured")} data-jam-hero={song.id} className="grid gap-6 pb-2 pt-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-center lg:gap-12 lg:pt-10">
      <div className="overflow-hidden rounded-[var(--radius-panel)]">
        <SongArt song={song} variant="hero" />
      </div>
      <div className="min-w-0">
        <p className="text-sm font-semibold text-text-tertiary">{jt("home.featured")}</p>
        <h2 className="mt-2 break-words font-display text-[clamp(2.5rem,7vw,4.25rem)] font-extrabold leading-[0.98] tracking-[-0.025em]">
          {song.title}
        </h2>
        {people.length > 0 && (
          <p className="mt-4 text-[15px] text-text-secondary">{listOf(people, locale)}</p>
        )}
        {song.needs.length > 0 && (
          <p className={cn("mt-3 text-xl font-extrabold", INSTRUMENT_LOOK[asInstrument(song.needs[0]!)].ink)}>
            {needSentence(song.needs)}
          </p>
        )}
        <div className="mt-6 flex flex-wrap items-center gap-3">
          <PlayButton song={song} size="hero" label={jt("home.play", { title: song.title })} />
          <Link href={path(song)} className={button("secondary", "lg")}>
            {jt("home.open")}
          </Link>
        </div>
        <Meta song={song} className="mt-6 text-sm" />
      </div>
    </section>
  );
}

function StartStrip() {
  const ask = useAsk();
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-4 sm:px-5">
      <span className="grid h-11 w-11 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
        <Mic className="h-5 w-5" aria-hidden />
      </span>
      <div className="min-w-0 flex-1 basis-56">
        <p className="text-base font-extrabold leading-tight">{jt("start.title")}</p>
        <p className="mt-0.5 text-sm text-text-secondary">{jt("start.body")}</p>
      </div>
      <button type="button" onClick={() => ask({ kind: "start" })} data-jam-start-strip="" className={button("secondary")}>
        {jt("start.cta")}
      </button>
    </div>
  );
}

function Tabs({
  tab,
  onTab,
  need,
  onNeed,
}: {
  tab: JamTab;
  onTab: (tab: JamTab) => void;
  need: Instrument | null;
  onNeed: (need: Instrument | null) => void;
}) {
  return (
    <div>
      <div role="group" aria-label={jt("tabs.label")} className="-mx-1 flex gap-1 overflow-x-auto px-1 pb-1 [scrollbar-width:none]">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            data-jam-tab={id}
            onClick={() => onTab(id)}
            className={cn(
              "relative h-11 shrink-0 rounded-[var(--radius-control)] px-3 text-base font-extrabold outline-none transition-colors focus-visible:ring-2 focus-visible:ring-focus-ring motion-reduce:transition-none",
              tab === id ? "text-text" : "text-text-tertiary hover:text-text",
              "after:absolute after:inset-x-3 after:bottom-0 after:h-[3px] after:rounded-full",
              tab === id ? "after:bg-accent" : "after:bg-transparent",
            )}
          >
            {jt(`tabs.${id}` as Parameters<typeof jt>[0])}
          </button>
        ))}
      </div>
      {tab === "needs" && (
        <div role="group" aria-label={jt("filter.label")} className="mt-3 flex flex-wrap gap-2">
          {[null, ...INSTRUMENTS].map((id) => {
            const active = need === id;
            const look = id ? INSTRUMENT_LOOK[id] : null;
            return (
              <button
                key={id ?? "any"}
                type="button"
                aria-pressed={active}
                data-jam-need={id ?? "any"}
                onClick={() => onNeed(id)}
                className={cn(
                  "inline-flex h-9 items-center gap-2 rounded-full px-3.5 text-sm font-bold outline-none ring-1 ring-inset focus-visible:ring-2 focus-visible:ring-focus-ring",
                  active ? "bg-text text-surface-0 ring-transparent" : "bg-surface-1 text-text-secondary ring-border hover:bg-surface-2",
                )}
              >
                {id && look && <Badge instrument={id} className="h-4 w-4" />}
                {id ? instrumentName(id) : jt("filter.any")}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function Empty({ tab, need }: { tab: JamTab; need: Instrument | null }) {
  const ask = useAsk();
  const key = tab === "top" || tab === "new" ? "empty.all" : tab === "needs" ? "empty.needs" : "empty.done";
  return (
    <div className="rounded-[var(--radius-panel)] border border-dashed border-border-strong px-6 py-14 text-center" data-jam-empty="">
      <p className="text-lg font-extrabold">{jt(`${key}.title` as Parameters<typeof jt>[0], { instrument: need ? instrumentName(need) : "" })}</p>
      <p className="mx-auto mt-1 max-w-md text-[15px] text-text-secondary">{jt(`${key}.body` as Parameters<typeof jt>[0])}</p>
      <button type="button" onClick={() => ask({ kind: "start" })} className={button("primary", "md", "mt-5")}>
        {jt("start.cta")}
      </button>
    </div>
  );
}

export function HomePage() {
  const [tab, setTab] = useState<JamTab>("top");
  const [need, setNeed] = useState<Instrument | null>(null);
  const list = useJamList(tab, need);
  const sentinel = useRef<HTMLDivElement | null>(null);
  const fromApp = useJamRoute().search.get("from") === "app";

  useHead({
    title: jt("meta.homeTitle"),
    description: jt("meta.homeDescription"),
    canonical: "https://jam.pqp.gg/",
  });

  // The next page loads when the end of the list nears the screen; the button
  // under it is the same action for a keyboard, a browser without the observer,
  // and a page that failed.
  const { loadMore, more, status, loadingMore } = list;
  useEffect(() => {
    const node = sentinel.current;
    if (!node || !more || status !== "ready" || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) loadMore();
      },
      { rootMargin: "600px 0px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [more, status, loadMore, list.songs.length]);

  const cards = useMemo(() => list.songs.map((song) => <Card key={song.id} song={song} />), [list.songs]);

  return (
    <div className={CONTAINER}>
      <h1 className="sr-only">{jt("meta.homeTitle")}</h1>
      {fromApp && (
        <div className="mt-6 rounded-[var(--radius-card)] border border-border bg-surface-1 px-4 py-3" role="status" data-jam-from-app="">
          <p className="font-bold">{jt("fromApp.title")}</p>
          <p className="mt-0.5 text-sm text-text-secondary">{jt("fromApp.start")}</p>
        </div>
      )}
      <Hero />
      <div className="mt-10 sm:mt-14">
        <Tabs tab={tab} onTab={setTab} need={need} onNeed={setNeed} />
      </div>
      <div className="mt-6">
        <StartStrip />
      </div>
      <div className="mt-8" aria-live="polite" aria-busy={status === "loading"}>
        {status === "error" ? (
          <div className="rounded-[var(--radius-panel)] border border-border bg-surface-1 px-6 py-10 text-center" role="alert" data-jam-error="">
            <p className="text-base font-bold">{jt("list.error")}</p>
            <button type="button" onClick={list.retry} className={button("secondary", "md", "mt-4")}>
              {jt("retry")}
            </button>
          </div>
        ) : status === "loading" ? (
          <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-6" data-jam-skeleton="">
            {Array.from({ length: 8 }, (_, index) => (
              <CardSkeleton key={index} />
            ))}
          </div>
        ) : list.songs.length === 0 ? (
          <Empty tab={tab} need={need} />
        ) : (
          <>
            <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-6" data-jam-grid="">
              {cards}
            </div>
            {more && (
              <div ref={sentinel} className="mt-10 flex justify-center">
                <button type="button" onClick={loadMore} disabled={loadingMore} data-jam-more="" className={cn(button("secondary", "md"), loadingMore && "opacity-60")}>
                  {loadingMore ? jt("list.loading") : jt("list.more")}
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
