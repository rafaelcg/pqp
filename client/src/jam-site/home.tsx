import type { PublicJamSong } from "@pqp/shared";
import { HeartIcon as Heart, MicIcon as Mic, PlayIcon as Play } from "./icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { jt } from "@/lib/i18n/jam-site";
import { detectLocale } from "@/lib/locale";
import { SongArt, SongCover } from "./art";
import { pickFeatured, pickWantingParts } from "./featured";
import { HowItWorks } from "./how-it-works";
import { useAsk } from "./auth-sheet";
import { useHead } from "./head";
import { INSTRUMENT_LOOK, INSTRUMENTS, asInstrument, inkMix, type Instrument } from "./instruments";
import { warmJamEngine } from "./player";
import { Link, useJamRoute } from "./router";
import { jamPath } from "./route";
import { CONTAINER, FromAppNotice } from "./shell";
import { Badge } from "./tiles";
import { button, focusRing, Skeleton } from "./ui";
import { FEATURED_WINDOW, featuredOptions, useFeatured, useJamList, type JamTab } from "./use-jam-data";
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
    <span className={cn("flex items-center gap-x-1.5", stacked ? "flex-wrap gap-y-0" : "shrink-0 whitespace-nowrap")}>
      <span>{jt("card.plays", { count: song.plays, countLabel: compactCount(song.plays, locale) })}</span>
      {song.likes > 1 && (
        <>
          {/* on a card the likes may wrap under the plays in a narrow language, so no separator dangles */}
          {!stacked && <span aria-hidden="true">·</span>}
          <span className="inline-flex items-center gap-1" role="img" aria-label={jt("card.likes", { count: song.likes })}>
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
      <div className={cn("min-w-0 text-[13px] leading-5 text-text-secondary", className)}>
        <p className="truncate">{origin}</p>
        {stats}
      </div>
    );
  }
  return (
    <p className={cn("flex min-w-0 items-center gap-x-1.5 text-[13px] text-text-secondary", className)}>
      <span className="min-w-0 truncate">{origin}</span>
      <span aria-hidden="true">·</span>
      {stats}
    </p>
  );
}

/**
 * Opens the song. It does NOT start it: opening a song never makes a sound, and sound starts only on that
 * song's own play button on its own page (and a play is counted only then). The home does not play in place
 * (the song page is where the band, the parts and the controls are), so the button SAYS where it goes: the
 * hero's is a pill with words, a card's round one has a tooltip (round 1 m5, partly open in round 3).
 * It used to carry a "start it" wish in `history.state` after an unlocked click, which worked only once
 * somebody had pressed play on another song in the same tab (launch screenshots, problem 1).
 */
function PlayButton({ song, size, label }: { song: PublicJamSong; size: "card" | "hero"; label: string }) {
  const path = useSongPath()(song);
  return (
    <Link
      href={path}
      aria-label={label}
      title={size === "card" ? jt("home.playOpens") : undefined}
      data-jam-play={song.id}
      onPointerEnter={() => void warmJamEngine()}
      onFocus={() => void warmJamEngine()}
      className={cn(
        "relative z-10 shrink-0 rounded-full transition-[transform,background-color] duration-[var(--duration-fast)] motion-reduce:transition-none",
        focusRing,
        size === "hero"
          ? "flex h-16 items-center justify-center gap-3 whitespace-nowrap bg-accent px-6 text-base font-bold text-on-accent hover:scale-105 motion-reduce:hover:scale-100"
          : "grid h-11 w-11 place-items-center bg-surface-2 text-text ring-1 ring-inset ring-border hover:bg-accent hover:text-on-accent hover:ring-transparent",
      )}
    >
      <Play className={size === "hero" ? "h-6 w-6" : "h-4 w-4"} fill="currentColor" aria-hidden />
      {size === "hero" && <span data-jam-play-label="">{jt("home.listen")}</span>}
    </Link>
  );
}

/** The first page of the list is drawn whole; the cards after it (a long scroll) are skipped by the browser while offscreen. */
const SKIPPED_AFTER = 24;

function Card({ song, skippable }: { song: PublicJamSong; skippable: boolean }) {
  const path = useSongPath()(song);
  return (
    <article data-jam-card={song.id} className={cn(
        "group relative flex min-w-0 flex-col",
        // the placeholder is a card's own height (phone, tablet, desktop): a taller one leaves a dead gap when the list is short
        skippable && "[content-visibility:auto] [contain-intrinsic-size:auto_17.5rem] md:[contain-intrinsic-size:auto_21rem] lg:[contain-intrinsic-size:auto_23rem]",
      )}
    >
      <div className="overflow-hidden rounded-[var(--radius-panel)]">
        <SongArt song={song} variant="card" />
      </div>
      <div className="mt-3 min-w-0">
        <div className="flex items-start gap-2.5">
          <SongCover title={song.title} coverUrl={song.coverUrl} className="mt-0.5 h-9 w-9" />
          <h3 className="line-clamp-2 min-w-0 flex-1 text-base font-bold leading-snug">
            <Link
              href={path}
              className="rounded-sm py-3.5 outline-none after:absolute after:inset-0 after:z-0 after:rounded-[var(--radius-panel)] focus-visible:after:ring-2 focus-visible:after:ring-focus-ring"
            >
              {song.title}
            </Link>
          </h3>
        </div>
        <div className="mt-1 flex items-end gap-2">
          <Meta song={song} className="flex-1" stacked />
          <PlayButton song={song} size="card" label={jt("home.play", { title: song.title })} />
        </div>
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

function Hero({ song, status }: { song: PublicJamSong | null; status: "loading" | "ready" | "error" }) {
  const path = useSongPath();
  const locale = detectLocale();
  if (status === "loading") {
    return (
      <div className="grid gap-6 pb-2 pt-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-center lg:gap-12 lg:pt-10" aria-hidden="true">
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
    <section aria-label={jt("home.featured")} data-jam-hero={song.id} className="grid gap-6 pb-2 pt-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] lg:items-center lg:gap-12 lg:pt-10">
      <div className="overflow-hidden rounded-[var(--radius-panel)]">
        <SongArt song={song} variant="hero" />
      </div>
      <div className="min-w-0">
        <div className="flex items-center gap-3">
          <SongCover title={song.title} coverUrl={song.coverUrl} className="h-12 w-12" />
          <p className="text-sm font-semibold text-text-secondary">{jt("home.featured")}</p>
        </div>
        <h2 className="mt-2 break-words font-display text-[clamp(2.5rem,7vw,4.25rem)] font-extrabold leading-[0.98] tracking-[-0.025em]">
          {song.title}
        </h2>
        {people.length > 0 && (
          <p className="mt-4 text-[15px] text-text-secondary">{listOf(people, locale)}</p>
        )}
        {song.needs.length > 0 && (
          <p className="mt-3 text-xl font-extrabold" style={{ color: inkMix(asInstrument(song.needs[0]!)) }}>
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

/**
 * Under a closed hero (a song that takes no part): a few songs that do, so a
 * visitor who wants to record always has something to record on. Drawn only
 * when `pickWantingParts` finds some. "Ver todas" is the Falta alguém tab.
 */
function WantsPart({ songs, onAll }: { songs: readonly PublicJamSong[]; onAll: () => void }) {
  const songPath = useSongPath();
  if (songs.length === 0) return null;
  return (
    <section aria-labelledby="jam-wants-title" data-jam-wants="" className="mt-6">
      <div className="flex items-center justify-between gap-3">
        <h2 id="jam-wants-title" className="text-sm font-bold text-text-secondary">
          {jt("wants.title")}
        </h2>
        <button
          type="button"
          onClick={onAll}
          data-jam-wants-all=""
          className={cn("min-h-11 rounded-sm px-1 text-sm font-bold text-text-secondary hover:text-text", focusRing)}
        >
          {jt("wants.all")}
        </button>
      </div>
      <ul className="mt-2 grid gap-2 md:grid-cols-3">
        {songs.map((song) => {
          const first = song.needs[0] ? asInstrument(song.needs[0]) : null;
          return (
            <li key={song.id}>
              <Link
                href={songPath(song)}
                data-jam-wants-song={song.id}
                className={cn(
                  "flex min-h-14 items-center gap-3 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-2.5 transition-colors hover:bg-surface-2 motion-reduce:transition-none",
                  focusRing,
                )}
              >
                {first ? (
                  <Badge instrument={first} className="h-10 w-10" />
                ) : (
                  <span aria-hidden="true" className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-accent text-on-accent">
                    <Mic className="h-[18px] w-[18px]" />
                  </span>
                )}
                <span className="min-w-0">
                  <span className="block truncate text-[15px] font-bold leading-5">{song.title}</span>
                  <span
                    className="block truncate text-[13px] font-semibold leading-5"
                    style={first ? { color: inkMix(first) } : undefined}
                  >
                    {first ? needSentence(song.needs) : jt("wants.any")}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** The first card of the grid: the one door to starting a jam, as tall as its neighbours. */
function StartCard() {
  const ask = useAsk();
  return (
    <article data-jam-start-card="" className="@container/start flex min-w-0 flex-col justify-between gap-4 rounded-[var(--radius-panel)] border border-border bg-surface-1 p-4 sm:p-5">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-accent text-on-accent">
        <Mic className="h-6 w-6" aria-hidden />
      </span>
      <div>
        <h3 className="text-lg font-extrabold leading-tight">{jt("start.title")}</h3>
        <p className="mt-1 text-sm leading-5 text-text-secondary">{jt("start.body")}</p>
        <button type="button" onClick={() => ask({ kind: "start" })} data-jam-start-strip="" className={button("secondary", "md", "mt-4 w-full")}>
          {jt("start.cta")}
        </button>
      </div>
    </article>
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
      <div role="group" aria-label={jt("tabs.label")} className="-mx-1 flex gap-0.5 overflow-x-auto px-1 pb-1 [mask-image:linear-gradient(to_right,var(--color-text)_calc(100%-1.75rem),transparent)] [scrollbar-width:none] sm:gap-1 sm:[mask-image:none]">
        {TABS.map((id) => (
          <button
            key={id}
            type="button"
            aria-pressed={tab === id}
            data-jam-tab={id}
            onClick={() => onTab(id)}
            className={cn(
              "relative h-11 shrink-0 rounded-[var(--radius-control)] px-2.5 text-[15px] font-extrabold outline-none sm:px-3 sm:text-base transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-focus-ring motion-reduce:transition-none",
              tab === id ? "text-text" : "text-text-secondary hover:text-text",
              "after:absolute after:inset-x-2.5 after:bottom-0 sm:after:inset-x-3 after:h-[3px] after:rounded-full",
              tab === id ? "after:bg-accent" : "after:bg-transparent",
            )}
          >
            {jt(`tabs.${id}` as Parameters<typeof jt>[0])}
          </button>
        ))}
        <span aria-hidden="true" className="w-4 shrink-0" />
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

/** The tab row's own height (a 44 px button and 4 px under it), as quiet bars. */
function TabsSkeleton() {
  return (
    <div className="flex h-12 items-start gap-3">
      <Skeleton className="mt-1.5 h-8 w-20 rounded-full" />
      <Skeleton className="mt-1.5 h-8 w-16 rounded-full" />
      <Skeleton className="mt-1.5 h-8 w-24 rounded-full" />
    </div>
  );
}

/**
 * The home while the site asks the API whether it is on (`site.tsx`): the same
 * frame the home draws while ITS data loads (tagline, the how-it-works strip, a
 * hero skeleton, the tab row, eight card skeletons), so the answer swaps content
 * in place instead of replacing a short placeholder with a tall page. The short
 * placeholder is what moved the footer a whole screen on a phone (CLS about 0.2
 * measured on a throttled phone, round 2).
 */
export function HomeBooting() {
  return (
    <div className={CONTAINER} aria-hidden="true" data-jam-booting="">
      <div className="text-balance pt-6 text-[17px] font-semibold leading-6 text-text-secondary sm:text-lg lg:pt-8">{jt("home.tagline")}</div>
      <div className="flex flex-col">
        <div className="order-2 lg:order-1">
          <Hero song={null} status="loading" />
        </div>
        <HowItWorks className="order-1 mt-5 lg:order-2 lg:mt-10" />
      </div>
      <div className="mt-10 sm:mt-14">
        <TabsSkeleton />
      </div>
      <div className="mt-8">
        <div className="grid grid-cols-2 gap-x-4 gap-y-8 md:grid-cols-3 lg:grid-cols-4 lg:gap-x-6">
          {Array.from({ length: 8 }, (_, index) => (
            <CardSkeleton key={index} />
          ))}
        </div>
      </div>
    </div>
  );
}

export function HomePage() {
  const [tab, setTab] = useState<JamTab>("top");
  const [need, setNeed] = useState<Instrument | null>(null);
  const list = useJamList(tab, need);
  const featured = useFeatured();
  // A closed hero takes no part: point at a few songs that do (nothing when the hero takes one, or none does).
  const wanting = useMemo(() => pickWantingParts(featured.songs, featured.song), [featured.songs, featured.song]);
  const showWanting = () => {
    setTab("needs");
    setNeed(null);
    window.requestAnimationFrame(() => document.querySelector('[data-jam-tab="needs"]')?.scrollIntoView({ block: "start" }));
  };
  const hasHero = featured.status === "loading" || featured.song !== null;
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

  // The engine's code (not a byte of audio) is fetched once the page is idle, so a
  // play press finds it loaded and can unlock the audio inside the click itself.
  useEffect(() => {
    const idle = (window as { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(() => void warmJamEngine()) : window.setTimeout(() => void warmJamEngine(), 1500);
    return () => {
      const cancel = (window as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
      if (idle && cancel) cancel(handle);
      else window.clearTimeout(handle);
    };
  }, []);

  // The hero is the first of Em alta: it is not shown twice on that tab. The hero
  // and the grid are two reads that race, so while the hero is still on its way the
  // grid applies the hero's own rule to its own page (the same Em alta order).
  // Waiting for the hero instead would hold usable cards behind a second request;
  // leaving nothing out would draw the hero's song as a card and pull it out a
  // moment later, shifting every card after it.
  const heroId = tab !== "top" ? null : featured.status === "loading" ? (pickFeatured(list.songs.slice(0, FEATURED_WINDOW), featuredOptions())?.id ?? null) : (featured.song?.id ?? null);
  const shown = useMemo(() => (heroId ? list.songs.filter((song) => song.id !== heroId) : list.songs), [heroId, list.songs]);
  const cards = useMemo(() => shown.map((song, index) => <Card key={song.id} song={song} skippable={index >= SKIPPED_AFTER} />), [shown]);

  return (
    <div className={CONTAINER}>
      <h1 className="text-balance pt-6 text-[17px] font-semibold leading-6 text-text-secondary sm:text-lg lg:pt-8" data-jam-tagline="">
        {jt("home.tagline")}
      </h1>
      {fromApp && <FromAppNotice body={jt("fromApp.start")} />}
      {/* On a phone the strip comes first: the hero's play button is a screen down, and a cold visitor should know what a jam is before it. From lg the hero sits beside its art and the strip goes under it. */}
      {/* No song has earned the hero (`pickFeatured`): the page leads with how it works and the list, never with a weak song. */}
      <div className="flex flex-col" data-jam-lead={hasHero ? "hero" : "how"}>
        <div className="order-2 lg:order-1">
          <Hero song={featured.song} status={featured.status} />
          <WantsPart songs={wanting} onAll={showWanting} />
        </div>
        <HowItWorks className={cn("order-1 mt-5", hasHero && "lg:order-2 lg:mt-10")} />
      </div>
      <div className="mt-10 sm:mt-14">
        <Tabs tab={tab} onTab={setTab} need={need} onNeed={setNeed} />
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
              <StartCard />
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
