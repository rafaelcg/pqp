import { ArrowRight } from "lucide-react";
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { LanguagePicker } from "@/components/marketing/language-picker";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BetaTag } from "@/components/ui/beta-tag";
import { useCommunitiesEnabled } from "@/hooks/use-communities-enabled";
import { useScrollToHash } from "@/hooks/use-scroll-to-hash";
import { isDesktopApp } from "@/lib/desktop";
import { detectPlatform, readPlatformSignals } from "@/lib/downloads";
import { type MessageKey, useTranslation } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  HERO_ASPECT,
  HERO_BODY_UNPINNED,
  HERO_DOWNLOAD_BOX,
  HERO_DOWNLOAD_BOX_MAC_TOUCH,
  HERO_FOCUS,
  HERO_FRAME_WIDTH,
  HERO_OBJECT_POSITION,
  HERO_PICTURE,
  HERO_REDUCED_SOURCES,
  HERO_SIZES,
  HERO_SKY,
} from "./hero-media";
import { rich } from "./rich";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton, SignInButton } from "./shared/auth-buttons";
import { useLiveStatus } from "./shared/live-status";
import { useReducedMotion } from "./shared/motion";
import "./shared/mock.css";
import { Brinquedos } from "./brinquedos";
import { Celular } from "./celular";
import {
  BrowserFrame,
  Clip,
  PIN_MEDIA,
  Scene,
  mix,
  useMediaQuery,
  usePinnedScenes,
  useSceneProgress,
} from "./cinema";
import { Codigo } from "./codigo";
import { Fim } from "./fim";
import { Mudanca } from "./mudanca";
import { Noite } from "./noite";
import { Perguntas } from "./perguntas";
import { SemLetraMiuda } from "./sem-letra-miuda";
import { SeuArroba } from "./seu-arroba";
import { HERO_CTAS_ID, StickyCta, useStickyCtaShown } from "./sticky-cta";
import { BTN_PRIMARY, BTN_SECONDARY, CONTAINER, Caption, FreeLine, useCta } from "./ui";
import { HERO_BREU_FADE, HeroBreu } from "./breu/hero-breu";
import { useReloadRestore } from "./reload-restore";

/**
 * The homepage at "/" (the review route under /preview/home renders it
 * too). One night with the crew, told by the product itself: the hero is the
 * real app, the page follows the evening, and every claim is something pqp
 * does today (or is labelled as early access, beta, or a sample).
 */
export default function Home() {
  const { t } = useTranslation();
  useScrollToHash();
  useReloadRestore();
  useHeaderScrollPadding();
  return (
    // The html scroll padding (5rem) already keeps a jump clear of the header;
    // a section's own scroll margin would add to it and land 10rem down.
    <div className="min-h-screen overflow-x-clip bg-ink text-paper [&_section]:scroll-mt-0">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-paper focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink"
      >
        {t("nav.skipToContent")}
      </a>
      <Nav />
      <main id="conteudo" tabIndex={-1} className="outline-none">
        <Hero />
        <Ticker />
        <Slot name="noite">
          <Noite />
        </Slot>
        <Slot name="mudanca">
          <Mudanca />
        </Slot>
        <Slot name="brinquedos">
          <Brinquedos />
        </Slot>
        <Slot name="celular">
          <Celular />
        </Slot>
        <Slot name="arroba">
          <SeuArroba />
        </Slot>
        <Slot name="limites">
          <SemLetraMiuda />
        </Slot>
        <Slot name="codigo">
          <Codigo />
        </Slot>
        <Slot name="perguntas">
          <Perguntas />
        </Slot>
        <Slot name="fim">
          <Fim />
        </Slot>
      </main>
      <StickyCta />
      <MarketingFooter />
    </div>
  );
}

/**
 * Keeps keyboard focus clear of the sticky header: a control reached with Tab
 * or Shift+Tab is scrolled to at least 5rem from the top. Longhand only, so
 * the sticky bar's `scroll-padding-bottom` on the same element survives.
 */
function useHeaderScrollPadding() {
  useLayoutEffect(() => {
    const html = document.documentElement;
    const previous = html.style.scrollPaddingTop;
    html.style.scrollPaddingTop = "5rem";
    return () => {
      html.style.scrollPaddingTop = previous;
    };
  }, []);
}

/** A section that throws must not take the rest of the page with it. */
class Slot extends Component<{ name: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  componentDidCatch(error: unknown) {
    console.error(`[home] section "${this.props.name}" failed`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/**
 * In page order. Bare `#id` hrefs, so the preview copy of the page keeps its
 * own path. "Recursos" is the shared nav's `nav.features`: the old
 * `/#features` lands on the same section (an alias on #brinquedos).
 */
const NAV_LINKS = [
  { href: "#noite", label: "home.nav.night" },
  { href: "#mudanca", label: "home.nav.move" },
  { href: "#brinquedos", label: "nav.features" },
  { href: "#codigo", label: "home.nav.code" },
  { href: "#perguntas", label: "home.nav.faq" },
] as const satisfies readonly { href: string; label: MessageKey }[];

/**
 * The sticky header. Its row is sized for its widest state: signed out, the
 * Communities link, the status pill at its longest label and the language
 * picker, in pt-BR and es (measured October 17, 2026). That only fits from
 * xl, so the Communities link joins there; at lg the five section links fit
 * with room to spare. The footer carries every link either way.
 */
function Nav() {
  const { t } = useTranslation();
  // Asked of the server (`COMMUNITIES_ENABLED`), the hook the shared nav and
  // footer use. The answer arrives late, so the link sits last in the row and
  // its arrival moves no other link.
  const communities = useCommunitiesEnabled();
  // Below lg the sticky bar at the bottom offers the same create action; while
  // it is up, this button steps aside so one screen never shows two.
  const barUp = useStickyCtaShown();
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  const navCta = cn(
    "inline-flex h-10 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink transition-colors hover:bg-signal sm:h-9",
    // Desktop: once the header is solid it is the page's standing CTA.
    solid && "lg:bg-signal lg:hover:bg-signal-dim",
  );

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition-[background-color,border-color] duration-300",
        solid ? "border-white/[0.06] bg-ink/80 backdrop-blur-xl" : "border-transparent bg-transparent",
      )}
    >
      <div className={cn(CONTAINER, "flex h-16 items-center gap-6")}>
        <Link to="/" className="inline-flex min-h-10 items-center gap-2 font-brand text-xl tracking-tight">
          pqp
          <span className="hidden min-[380px]:inline-flex">
            <BetaTag />
          </span>
        </Link>
        <nav
          aria-label={t("home.nav.label")}
          className="hidden min-w-0 items-center gap-5 text-sm text-paper-muted lg:flex"
        >
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="whitespace-nowrap transition-colors hover:text-paper">
              {t(l.label)}
            </a>
          ))}
          {communities && (
            // The exact href the shared nav uses: e2e/landing-hash-scroll.spec.ts
            // looks for `header nav a[href="/#communities"]`.
            <a href="/#communities" className="hidden whitespace-nowrap transition-colors hover:text-paper xl:inline">
              {t("nav.communities")}
            </a>
          )}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <StatusPill className="hidden xl:inline-flex" />
          {/* The footer's picker is phone-only (sm:hidden); this one takes over from sm. */}
          <LanguagePicker className="hidden sm:inline-flex" />
          <SignInButton className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium text-paper-muted transition-colors hover:text-paper sm:h-9" />
          <JoinButton
            intent={CREATE_INTENT}
            // A returning visitor wants the app, not a new community: signed
            // in, this reads "Open the app" and links /app, and it stays put
            // while the sticky bar is up (the bar does not open the app).
            openAppWhenSignedIn
            className={cn(navCta, barUp && "max-lg:hidden")}
            signedInClassName={navCta}
          >
            {t("home.nav.create")}
          </JoinButton>
        </div>
      </div>
    </header>
  );
}

/**
 * "Voz no ar", read once from /status.json. Hidden until there is an answer
 * and when there is none: a pill that guesses green is a lie. The dot is
 * still: its colour is the reading, and a pulse would add nothing to it.
 */
function StatusPill({ className }: { className?: string }) {
  const { t } = useTranslation();
  const reading = useLiveStatus();
  if (!reading || reading === "unavailable" || reading.overall === "unknown") return null;
  // Short labels on purpose: the header row is measured with the longest one.
  const tone =
    reading.overall === "operational"
      ? { dot: "bg-success", label: t("home.nav.status.up") }
      : reading.overall === "degraded"
        ? { dot: "bg-warning", label: t("home.nav.status.degraded") }
        : { dot: "bg-danger", label: t("home.nav.status.down") };
  return (
    <Link
      to="/status"
      className={cn(
        "items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-paper-muted transition-colors hover:text-paper",
        className,
      )}
    >
      <span aria-hidden className={cn("inline-flex h-2 w-2 rounded-full", tone.dot)} />
      {tone.label}
    </Link>
  );
}

/* ------------------------------------------------------------------ Hero */

/*
 * The hero's footage, picture, sizes and download reserve live in
 * `hero-media.ts` as plain data: the static first screen in index.html
 * (`src/lib/prerender-hero.ts`) draws the same values, and a test holds the
 * two equal.
 */

/**
 * The hero's beats through its pin: the copy steps back first, the frame
 * rises, flattens and grows until it fills the screen, then holds.
 */
const HERO_RANGES = {
  copy: [0, 0.24],
  frame: [0, 0.8, "out"],
  sky: [0, 0.75],
} as const;

/**
 * The raw scroll progress at which the hero's Breu is fully transparent. Its
 * opacity is `1 - --p-frame * HERO_BREU_FADE`, which hits 0 at `--p-frame`
 * 1 / HERO_BREU_FADE, and `frame` eases out (`1 - (1 - t) ** 2` over
 * `[0, HERO_RANGES.frame[1]]`), so the progress is that range's end times
 * `1 - sqrt(1 - 1 / HERO_BREU_FADE)`: about 0.147 for a fade of 3. Past it
 * Breu is invisible and its loops pause; before it, hiding it would cut a
 * visible frame.
 */
const HERO_BREU_GONE_AT = HERO_RANGES.frame[1] * (1 - Math.sqrt(1 - 1 / HERO_BREU_FADE));

/** Tailwind's `sm` is 640px: below it the hero's copy is as short as it can be. */
const PHONE_QUERY = "(max-width: 639px)";

/** Offset of `el` from `ancestor`, ignoring transforms (offsetTop does). */
function offsetWithin(el: HTMLElement, ancestor: HTMLElement): number {
  let top = 0;
  let node: HTMLElement | null = el;
  while (node && node !== ancestor) {
    top += node.offsetTop;
    node = node.offsetParent as HTMLElement | null;
  }
  return top;
}

function Hero() {
  const { t } = useTranslation();
  const cta = useCta();
  const pinned = usePinnedScenes();
  const reduced = useReducedMotion();
  const [mac] = useState(
    () => typeof navigator !== "undefined" && !isDesktopApp() && detectPlatform(readPlatformSignals()) === "mac",
  );
  const pinnedRef = useRef(pinned);
  pinnedRef.current = pinned;
  // On wide screens the frame is on the first screen (the LCP); on phones it
  // sits below the fold and loads lazily like everything else.
  const wide = useMediaQuery(PIN_MEDIA);
  // Below sm the download line goes under the footage: on an iPhone it is a
  // 44px pill, and above the frame it pushed the top of the call off a 664px
  // Safari screen (390 wide, toolbars up).
  const phone = useMediaQuery(PHONE_QUERY);
  const downloadBelow = phone && !pinned;
  const stageRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);
  // Breu mounts one commit after the hero (breu/hero-breu.tsx), so it is
  // attached through a callback that applies the last progress at once: a
  // reload restored mid-page must not start it visible with its loops on.
  const breuRef = useRef<HTMLSpanElement | null>(null);
  const progressRef = useRef(0);
  const attachBreu = useCallback((node: HTMLSpanElement | null) => {
    breuRef.current = node;
    node?.toggleAttribute("data-gone", pinnedRef.current && progressRef.current >= HERO_BREU_GONE_AT);
  }, []);

  // Built at render, never at import: English is bundled in the entry and
  // pt-BR and es load after it, so an alt read at import would stay English.
  const stills = useMemo(() => {
    const alt = t("home.hero.alt");
    return {
      motion: { ...HERO_PICTURE.motion, sizes: HERO_SIZES, alt },
      // Reduced motion: the six-person room, not the loop's first frame.
      reduced: { ...HERO_PICTURE.reduced, sizes: HERO_SIZES, alt },
    };
  }, [t]);

  // Pinned, the frame is laid out at its final place and size. This measures
  // how far below that place it starts: just under the copy.
  useLayoutEffect(() => {
    const stage = stageRef.current;
    const copy = copyRef.current;
    const box = boxRef.current;
    if (!pinned || !stage || !copy || !box) return;
    const measure = () => {
      const copyBottom = offsetWithin(copy, stage) + copy.offsetHeight;
      const lift = Math.max(0, copyBottom + 44 - offsetWithin(box, stage));
      stage.style.setProperty("--lift", `${lift}px`);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(stage);
    ro.observe(copy);
    return () => ro.disconnect();
  }, [pinned]);

  // Per frame, DOM only: faded copy stops taking clicks, and a settled frame
  // drops its transform so it rasterises at full sharpness.
  // Unpinned the scene rests at 1, which must not fade the copy: it stays
  // where it is and has to keep taking clicks.
  const onProgress = useCallback((p: number) => {
    progressRef.current = p;
    copyRef.current?.toggleAttribute("data-faded", pinnedRef.current && p > 0.24);
    frameRef.current?.toggleAttribute("data-settled", p >= 0.8);
    // Breu is fully transparent from here (HERO_BREU_GONE_AT), so hiding it
    // never cuts a visible frame; it also pauses its loops.
    breuRef.current?.toggleAttribute("data-gone", pinnedRef.current && p >= HERO_BREU_GONE_AT);
  }, []);
  // Switching reduced motion on while open reports progress 1 before React
  // re-renders, so both flags can still be set here. Clear them: unpinned, the
  // copy must take clicks and Breu rests in its peek pose.
  useEffect(() => {
    if (pinned) return;
    copyRef.current?.removeAttribute("data-faded");
    breuRef.current?.removeAttribute("data-gone");
  }, [pinned]);

  // Tabbing into the copy after it stepped back brings the top of the page
  // back, so focus never lands on something you cannot see.
  const onCopyFocus = () => {
    if (pinned && copyRef.current?.hasAttribute("data-faded")) window.scrollTo({ top: 0 });
  };

  const copyStyle: CSSProperties | undefined = pinned
    ? {
        opacity: "calc(1 - var(--p-copy))",
        transform: "translate3d(0, calc(var(--p-copy) * -96px), 0) scale(calc(1 - var(--p-copy) * 0.05))",
        willChange: "transform, opacity",
      }
    : undefined;

  const frameStyle: CSSProperties | undefined = pinned
    ? {
        transform:
          "translate3d(0, calc((1 - var(--p-frame)) * var(--lift, 0px)), 0) scale(calc(0.68 + 0.32 * var(--p-frame))) perspective(1500px) rotateX(calc((1 - var(--p-frame)) * 24deg))",
        transformOrigin: "50% 0%",
        willChange: "transform",
      }
    : undefined;

  const frame = (
    <div
      ref={frameRef}
      className="pointer-events-auto relative isolate data-settled:transform-none! data-settled:will-change-auto!"
      style={frameStyle}
    >
      {/* The hero's entrance: the frame rises once, on load, and the copy
          above it is simply there. With the static first screen up
          (`html[data-pre]`, production's "/") the rise is off, and Breu's
          peek is the hero's only entrance. */}
      <div className="animate-rise" style={{ "--stagger": 1 } as CSSProperties}>
        {/* Breu, the mascot, behind the window bar, lg and up only (below
            that there is no room above the window). Absolutely placed on
            the top edge: the containing block is this div while its rise
            leaves a transform on it, the frame div around it under `data-pre`,
            and both share the window's top edge and width. Before the
            window in the DOM, so the window paints over its lower body. */}
        {wide && <HeroBreu pinned={pinned} ref={attachBreu} />}
        <BrowserFrame
          bodyClassName={cn(!pinned && HERO_BODY_UNPINNED)}
          bodyStyle={pinned ? { aspectRatio: HERO_ASPECT.css } : undefined}
        >
          <Clip
            // Reduced motion never plays the loop, and its first frame is a
            // lobby with one person, so the still of the full room stands in.
            {...(reduced ? { src: HERO_REDUCED_SOURCES } : { name: "call-join" })}
            priority={wide}
            fallbackStill={reduced ? stills.reduced : stills.motion}
            label={t("home.hero.clipLabel")}
            position={HERO_OBJECT_POSITION}
            focus={HERO_FOCUS}
            sizes={HERO_SIZES}
            className="absolute inset-0"
            // Pinned, top left over the server rail: on screen while the frame
            // still rises from the bottom, and clear of the members list and
            // chat. Below md, top right in the empty chat, clear of the call
            // bar along the crop's bottom edge. From md to lg, the bottom of
            // the members list.
            controlsClassName="max-md:bottom-auto max-md:top-3 lg:bottom-auto lg:left-3 lg:right-auto lg:top-3"
          />
        </BrowserFrame>
        {/* The page's one full disclaimer. Every other figure carries only the
            short example tag and says what it shows. */}
        <Caption>{t("home.hero.caption")}</Caption>
      </div>
    </div>
  );

  return (
    <Scene
      as="section"
      label={t("home.hero.label")}
      // While the static first screen is up (`html[data-pre]`), index.css
      // keeps this scene's entrance still, so the live hero lands at rest.
      attrs={{ "data-home-hero": "" }}
      height="230vh"
      ranges={HERO_RANGES}
      onProgress={onProgress}
      stageRef={stageRef}
      className="-mt-16"
      stageClassName={cn(!pinned && "pt-16")}
    >
      <HeroSky pinned={pinned} />
      <div
        aria-hidden
        className="hp-grain pointer-events-none absolute inset-0 opacity-70 [mask-image:linear-gradient(to_bottom,black_55%,transparent)]"
      />

      <div
        ref={copyRef}
        onFocus={onCopyFocus}
        className={cn(
          "z-10 data-faded:pointer-events-none",
          pinned ? "absolute inset-x-0 top-0 pt-[calc(4rem+4.5vh)]" : "relative pt-6 sm:pt-16",
        )}
        style={copyStyle}
      >
        <div className={cn(CONTAINER, "flex flex-col items-start")}>
          {/* One fixed shape in every language: `home.hero.title` holds one
              {accent} and no other slot, and no forced line break, so the
              static first screen can print the same h1. The accent is plain
              text: the page's only lime headline phrase is the closer's.
              `text-balance` sets the break; pt-BR keeps "numa sala" together
              with a no-break space in its value. */}
          <h1 className="max-w-[17ch] font-display text-[clamp(2.75rem,min(6.4vw,10.6vh),5.75rem)] font-bold leading-[0.96] tracking-[-0.035em] text-balance">
            {rich(t("home.hero.title"), { accent: t("home.hero.titleAccent") })}
          </h1>
          <p className="mt-4 max-w-[36rem] text-base leading-relaxed text-paper-muted text-pretty sm:mt-6 sm:text-xl">
            {t("home.hero.body")}
          </p>
          <div id={HERO_CTAS_ID} className="mt-6 flex w-full flex-col gap-3 sm:mt-8 sm:w-auto sm:flex-row">
            <JoinButton intent={CREATE_INTENT} className={cn(BTN_PRIMARY, "w-full sm:w-auto")}>
              {cta.create}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </JoinButton>
            <JoinButton intent={IMPORT_INTENT} className={cn(BTN_SECONDARY, "w-full sm:w-auto")}>
              {cta.importDiscord}
            </JoinButton>
          </div>
          <div className="mt-4 flex flex-col items-start gap-2 sm:mt-5">
            {/* The facts the old chip carried, said once: free, no card, open
                source, two brothers, and how to sign up. */}
            <FreeLine extra={t("home.hero.made")} className="max-w-[36rem] text-sm text-paper-muted" />
            {/* Held at its tallest state (a Mac before the chip is known: both
                builds and a note), so nothing under it moves when it settles.
                On a phone it sits under the footage instead (below). */}
            {!downloadBelow && (
              <div className={cn(HERO_DOWNLOAD_BOX, mac && HERO_DOWNLOAD_BOX_MAC_TOUCH)}>
                <HeroDownload tone="ink" />
              </div>
            )}
          </div>
        </div>
      </div>

      <div
        className={cn(
          pinned
            ? "pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-5 pt-16"
            : cn(CONTAINER, "relative pb-14 pt-4 sm:pb-28 sm:pt-10"),
        )}
      >
        <div
          ref={boxRef}
          className="pointer-events-none relative w-full"
          style={pinned ? { width: HERO_FRAME_WIDTH } : undefined}
        >
          {/* Never behind a scroll reveal: on a phone the top of the call has
              to be on the first screen, not wait for a scroll to appear. */}
          {frame}
        </div>
        {downloadBelow && (
          <div className="pointer-events-auto relative mt-5 flex justify-start">
            <HeroDownload tone="ink" />
          </div>
        )}
      </div>
    </Scene>
  );
}

/**
 * The painted rooftop at dusk, as a sky behind the first screen: the same
 * painting Fim closes on, lit, with a dark band behind the copy only (as Fim
 * keeps one behind its words). At lg the copy is a left column, so the band
 * runs from the left edge and the sky opens on the right; below lg the copy
 * spans the screen, so the band does too.
 */
function HeroSky({ pinned }: { pinned: boolean }) {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[74%] max-h-[56rem] overflow-hidden"
      style={
        pinned
          ? {
              opacity: "calc(1 - var(--p-sky) * 0.8)",
              transform: "translate3d(0, calc(var(--p-sky) * -10vh), 0)",
              willChange: "transform, opacity",
            }
          : undefined
      }
    >
      <picture>
        <source type="image/avif" srcSet={HERO_SKY.avifSrcSet} sizes={HERO_SKY.sizes} />
        <img
          src={HERO_SKY.src}
          srcSet={HERO_SKY.srcSet}
          sizes={HERO_SKY.sizes}
          alt=""
          width={HERO_SKY.width}
          height={HERO_SKY.height}
          decoding="async"
          fetchPriority="low"
          className="h-full w-full object-cover object-[50%_35%] [mask-image:linear-gradient(to_bottom,black_0%,black_40%,transparent_100%)]"
        />
      </picture>
      {/* The band behind the copy. Measured October 17, 2026 with the text
          hidden: the lede keeps at least 4.5:1 against the lightest pixel
          behind it at 390, 1024, 1440 and 1920 wide. */}
      <div className="absolute inset-0 bg-ink/70 lg:bg-transparent lg:bg-gradient-to-r lg:from-ink lg:from-15% lg:via-ink/80 lg:via-50% lg:to-ink/10 lg:to-85%" />
      {/* The sky settles into the page under it. */}
      <div className="absolute inset-x-0 bottom-0 h-2/3 bg-gradient-to-b from-transparent to-ink" />
    </div>
  );
}

/* ---------------------------------------------------------------- Ticker */

/** The verbs of a night, in order. */
const VERBS = [
  "home.ticker.call",
  "home.ticker.share",
  "home.ticker.hand",
  "home.ticker.music",
  "home.ticker.poll",
  "home.ticker.dice",
  "home.ticker.crew",
] as const satisfies readonly MessageKey[];

/**
 * The page's one shout: the verbs of a night, in the brand face. It slides
 * with the scroll and only then, so nothing runs on its own and there is
 * nothing to pause. With reduced motion it stands still at the first verb.
 */
function Ticker() {
  const { t, locale } = useTranslation();
  const ref = useRef<HTMLDivElement>(null);
  useSceneProgress(ref, { mode: "through", rest: 0 });
  const verbs = VERBS.map((key) => ({ key, text: t(key) }));
  // Read once as a sentence: the verbs in a comma list, first letter up.
  const list = verbs.map((v) => v.text).join(", ");
  const spoken = `${list.charAt(0).toLocaleUpperCase(locale)}${list.slice(1)}.`;
  return (
    // Where the hero pins (lg with motion), its frame ends with the caption
    // near the bottom of the screen; the margin keeps the band off it.
    <div ref={ref} className="relative border-y border-white/[0.06] py-6 sm:py-8 motion-safe:lg:mt-12">
      <p className="sr-only">{spoken}</p>
      <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <div
          aria-hidden
          className="flex w-max"
          style={{ transform: `translate3d(${mix("0%", "-30%")}, 0, 0)`, willChange: "transform" }}
        >
          {[0, 1].map((copy) => (
            <ul key={copy} className="flex shrink-0 items-center">
              {verbs.map((verb, i) => (
                <li key={verb.key} className="flex items-center whitespace-nowrap">
                  <span
                    className={cn(
                      "px-6 font-brand text-3xl uppercase tracking-tight sm:px-8 sm:text-5xl",
                      i % 2 ? "text-transparent [-webkit-text-stroke:1px_var(--color-text)]" : "text-paper",
                    )}
                  >
                    {verb.text}
                  </span>
                  <span className="h-2.5 w-2.5 rotate-45 bg-white/25" aria-hidden />
                </li>
              ))}
            </ul>
          ))}
        </div>
      </div>
    </div>
  );
}
