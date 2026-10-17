import { ArrowRight } from "lucide-react";
import {
  Component,
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BetaTag } from "@/components/ui/beta-tag";
import { isDesktopApp } from "@/lib/desktop";
import { detectPlatform, readPlatformSignals } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton, SignInButton } from "../shared/auth-buttons";
import { useLiveStatus } from "../shared/live-status";
import { useReducedMotion } from "../shared/motion";
import "../shared/mock.css";
import { Brinquedos } from "./brinquedos";
import { Celular } from "./celular";
import {
  BrowserFrame,
  Clip,
  type ClipFocus,
  Magnetic,
  PIN_MEDIA,
  Reveal,
  Scene,
  clipPoster,
  mix,
  stillImg,
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
import { HERO_CTAS_ID, StickyCta } from "./sticky-cta";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CONTAINER,
  CTA_CREATE,
  CTA_IMPORT,
  Caption,
  FreeLine,
  Glow,
  Hi,
} from "./ui";

/**
 * The flagship homepage candidate. One night with the crew, told by the
 * product itself: the hero is the real app, the page follows the evening, and
 * every claim is something pqp does today (or is labelled as early access,
 * beta, or a sample).
 */
export default function FlagshipHome() {
  useScrollTarget();
  useHeaderScrollPadding();
  return (
    // The html scroll padding (5rem) already keeps a jump clear of the header;
    // a section's own scroll margin would add to it and land 10rem down.
    <div className="min-h-screen overflow-x-clip bg-ink text-paper [&_section]:scroll-mt-0">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-paper focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Pular pro conteúdo
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

const SCROLL_KEY = "pqp:flagship-scroll";

/**
 * Honours a `#section` link and a reload from mid-page. The page's pinned
 * scenes and lazy media settle after first paint, and the browser's own
 * restore runs before that, so it lands at the top. This waits two frames and
 * jumps itself (instant: html is `scroll-behavior: smooth` with motion).
 */
function useScrollTarget() {
  useLayoutEffect(() => {
    const previous = history.scrollRestoration;
    history.scrollRestoration = "manual";
    return () => {
      history.scrollRestoration = previous;
    };
  }, []);

  useEffect(() => {
    let saved: number | null = null;
    try {
      // Read now, cleared after the jump: a dev double-mount must see it twice.
      const raw = sessionStorage.getItem(SCROLL_KEY);
      if (raw !== null && Number.isFinite(Number(raw))) saved = Number(raw);
    } catch {
      // Storage can be blocked; the page still works without a restore.
    }

    const id = decodeURIComponent(window.location.hash.slice(1));
    const target = id ? document.getElementById(id) : null;
    const jump = () => {
      if (target) target.scrollIntoView({ block: "start", behavior: "instant" });
      else if (saved !== null) window.scrollTo({ top: saved, behavior: "instant" });
    };

    let raf = 0;
    let timer = 0;
    if (target || (saved !== null && saved > 0)) {
      raf = requestAnimationFrame(() => {
        raf = requestAnimationFrame(() => {
          jump();
          try {
            sessionStorage.removeItem(SCROLL_KEY);
          } catch {
            // See above.
          }
          // Scene runways and images keep settling; correct once if nothing
          // else moved the page in the meantime.
          const landed = window.scrollY;
          timer = window.setTimeout(() => {
            if (Math.abs(window.scrollY - landed) < 2) jump();
          }, 500);
        });
      });
    }

    const onHide = () => {
      try {
        sessionStorage.setItem(SCROLL_KEY, String(Math.round(window.scrollY)));
      } catch {
        // See above.
      }
    };
    window.addEventListener("pagehide", onHide);
    return () => {
      cancelAnimationFrame(raf);
      window.clearTimeout(timer);
      window.removeEventListener("pagehide", onHide);
    };
  }, []);
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
    console.error(`[home-preview] section "${this.props.name}" failed`, error);
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

/** In page order. */
const NAV_LINKS = [
  { href: "#noite", label: "Uma noite" },
  { href: "#mudanca", label: "Vindo do Discord" },
  { href: "#brinquedos", label: "Recursos" },
  { href: "#codigo", label: "Código aberto" },
  { href: "#perguntas", label: "Perguntas" },
];

function Nav() {
  const [solid, setSolid] = useState(false);
  useEffect(() => {
    const onScroll = () => setSolid(window.scrollY > 24);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <header
      className={cn(
        "sticky top-0 z-50 border-b transition-[background-color,border-color] duration-300",
        solid ? "border-white/[0.06] bg-ink/80 backdrop-blur-xl" : "border-transparent bg-transparent",
      )}
    >
      <div className={cn(CONTAINER, "flex h-16 items-center gap-6")}>
        <Link
          to="/preview/home/flagship"
          className="inline-flex min-h-10 items-center gap-2 font-brand text-xl tracking-tight"
        >
          pqp
          <span className="hidden min-[380px]:inline-flex">
            <BetaTag />
          </span>
        </Link>
        <nav aria-label="Seções" className="hidden min-w-0 items-center gap-6 text-sm text-paper-muted lg:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="whitespace-nowrap transition-colors hover:text-paper">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <StatusPill className="hidden xl:inline-flex" />
          <SignInButton className="inline-flex h-10 items-center rounded-full px-3 text-sm font-medium text-paper-muted transition-colors hover:text-paper sm:h-9" />
          <JoinButton
            intent={CREATE_INTENT}
            className={cn(
              "inline-flex h-10 items-center gap-1.5 rounded-full bg-paper px-4 text-sm font-semibold text-ink transition-colors hover:bg-signal sm:h-9",
              // Desktop: once the header is solid it is the page's standing CTA.
              solid && "lg:bg-signal lg:hover:bg-signal-dim",
            )}
          >
            Começar
          </JoinButton>
        </div>
      </div>
    </header>
  );
}

/**
 * "Voz no ar", read once from /status.json. Hidden until there is an answer
 * and when there is none: a pill that guesses green is a lie.
 */
function StatusPill({ className }: { className?: string }) {
  const reading = useLiveStatus();
  if (!reading || reading === "unavailable" || reading.overall === "unknown") return null;
  const tone =
    reading.overall === "operational"
      ? { dot: "bg-success", label: "Voz no ar" }
      : reading.overall === "degraded"
        ? { dot: "bg-warning", label: "Voz instável" }
        : { dot: "bg-danger", label: "Voz com problema" };
  return (
    <Link
      to="/status"
      className={cn(
        "items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-paper-muted transition-colors hover:text-paper",
        className,
      )}
    >
      <span className="relative flex h-2 w-2">
        <span className={cn("absolute inline-flex h-full w-full animate-ping rounded-full opacity-60 motion-reduce:hidden", tone.dot)} />
        <span className={cn("relative inline-flex h-2 w-2 rounded-full", tone.dot)} />
      </span>
      {tone.label}
    </Link>
  );
}

/* ------------------------------------------------------------------ Hero */

/**
 * The hero footage: `call-join` is recorded at 1920x1200, so the frame is
 * 16:10. The fallback still crops from the top.
 */
const HERO_ASPECT = { css: "16 / 10", ratio: 16 / 10 };

/** Pinned it ends as wide as the screen allows; below lg it fills the container. */
const HERO_SIZES = "(min-width: 1024px) min(92vw, 1440px), 100vw";

const HERO_ALT =
  "O pqp de verdade: o servidor A Mesa com o canal de voz Lobby aberto, o chat da call e os membros separados por cargo. Pessoas de exemplo.";

const HERO_STILL = clipPoster("call-join", HERO_ALT, HERO_SIZES);

/** With reduced motion: the six-person room, not the loop's first frame. */
const HERO_REDUCED_SRC = {
  webm: "/media/home/call-join.webm",
  mp4: "/media/home/call-join.mp4",
  webmSmall: "/media/home/call-join-960.webm",
  mp4Small: "/media/home/call-join-960.mp4",
  poster: "/media/home/still-call-join.webp",
  posterSmall: "/media/home/still-call-join-960.webp",
};
const HERO_REDUCED_STILL = stillImg("call-join", HERO_ALT, HERO_SIZES);

/**
 * Phones (below md): a light crop that keeps the whole call in the frame, the
 * channel list with the Lobby, the chat and the "6 na chamada" bar together.
 * Only the server rail and the members list drop out. The close-up of the
 * Lobby list belongs to the night's 21:40, not to the hero.
 */
const HERO_FOCUS: ClipFocus = { x: 15, y: 58, zoom: 1.25 };

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
 * The frame's final width: as wide as the screen allows with room to breathe.
 * The copy has stepped back by then, so the height only leaves room for the
 * header (4rem), the window bar (2.5rem), the caption (2rem) and a little air
 * (1.5rem): on a short screen the caption still ends inside it.
 */
const HERO_FRAME_WIDTH = `min(92vw, 1440px, calc((100svh - 10rem) * ${HERO_ASPECT.ratio.toFixed(4)}))`;

/**
 * Room for the download line's tallest state; the line itself may be shorter.
 * On a Mac it first offers both builds with a note (63px with a mouse, 84px
 * with touch) and settles on one link, so a Mac with a coarse pointer gets the
 * taller reserve. A phone's badge never changes and gets only the base one.
 */
const HERO_DOWNLOAD_BOX = "min-h-[4rem]";
const HERO_DOWNLOAD_BOX_MAC_TOUCH = "[@media(pointer:coarse)]:min-h-[5.25rem]";

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
  const stageRef = useRef<HTMLDivElement>(null);
  const copyRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLDivElement>(null);

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
    copyRef.current?.toggleAttribute("data-faded", pinnedRef.current && p > 0.24);
    frameRef.current?.toggleAttribute("data-settled", p >= 0.8);
  }, []);
  useEffect(() => {
    if (!pinned) copyRef.current?.removeAttribute("data-faded");
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
      {/* The lime light the screen floats on. */}
      <div
        aria-hidden
        className="pointer-events-none absolute -inset-x-[16%] -top-[14%] bottom-[30%] -z-10"
        style={{ opacity: pinned ? "calc(1 - var(--p-frame) * 0.72)" : 0.5 }}
      >
        {/* Unblurred: its opacity moves with every frame of the pin. */}
        <Glow intensity="strong" className="inset-0 blur-none" />
      </div>
      {/* Light catching the top edge while the screen lies back. */}
      {pinned && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-x-[6%] -top-px z-10 h-[2px] bg-gradient-to-r from-transparent via-signal to-transparent"
          style={{ opacity: "calc(1 - var(--p-frame) * 1.4)" }}
        />
      )}
      <div className="animate-rise" style={{ "--stagger": 4 } as CSSProperties}>
        <BrowserFrame
          bodyClassName={cn(!pinned && "aspect-[4/3] sm:aspect-[16/10]")}
          bodyStyle={pinned ? { aspectRatio: HERO_ASPECT.css } : undefined}
        >
          <Clip
            // Reduced motion never plays the loop, and its first frame is a
            // lobby with one person, so the still of the full room stands in.
            {...(reduced ? { src: HERO_REDUCED_SRC } : { name: "call-join" })}
            priority={wide}
            fallbackStill={reduced ? HERO_REDUCED_STILL : HERO_STILL}
            label="Uma call no pqp: a galera vai entrando no canal de voz Lobby, uma pessoa de cada vez. Gente de exemplo."
            position="object-left-top sm:object-top"
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
        <Caption example>O app de verdade, com gente de exemplo.</Caption>
      </div>
    </div>
  );

  return (
    <Scene
      as="section"
      label="Início"
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
          pinned ? "absolute inset-x-0 top-0 pt-[calc(4rem+4.5vh)]" : "relative pt-10 sm:pt-16",
        )}
        style={copyStyle}
      >
        <div className={cn(CONTAINER, "flex flex-col items-start lg:items-center lg:text-center")}>
          <p
            className="animate-rise inline-flex items-center gap-2 rounded-full border border-white/10 bg-ink/50 px-3 py-1 text-xs text-paper-muted backdrop-blur-sm"
            style={{ "--stagger": 0 } as CSSProperties}
          >
            <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
            De graça, código aberto, feito por dois irmãos
          </p>
          <h1
            className="animate-rise mt-6 font-display text-[clamp(2.75rem,min(6.4vw,10.6vh),5.75rem)] font-bold leading-[0.96] tracking-[-0.035em] text-balance"
            style={{ "--stagger": 1 } as CSSProperties}
          >
            Sua galera numa sala <br className="hidden lg:block" />
            que é <Hi>de vocês</Hi>.
          </h1>
          <p
            className="animate-rise mt-6 max-w-[36rem] text-lg leading-relaxed text-paper-muted text-pretty sm:text-xl lg:max-w-[40rem] lg:text-balance"
            style={{ "--stagger": 2 } as CSSProperties}
          >
            Voz, tela compartilhada com som e chat, direto no navegador. Vindo do Discord? Cola o link do
            modelo e o layout do servidor vem junto.
          </p>
          <div
            id={HERO_CTAS_ID}
            className="animate-rise mt-8 flex w-full flex-col gap-3 sm:w-auto sm:flex-row"
            style={{ "--stagger": 3 } as CSSProperties}
          >
            <Magnetic className="flex">
              <JoinButton intent={CREATE_INTENT} className={cn(BTN_PRIMARY, "w-full sm:w-auto")}>
                {CTA_CREATE}
                <ArrowRight className="h-4 w-4" aria-hidden />
              </JoinButton>
            </Magnetic>
            <Magnetic className="flex">
              <JoinButton intent={IMPORT_INTENT} className={cn(BTN_SECONDARY, "w-full sm:w-auto")}>
                {CTA_IMPORT}
              </JoinButton>
            </Magnetic>
          </div>
          <div
            className="animate-rise mt-5 flex flex-col items-start gap-2 lg:items-center"
            style={{ "--stagger": 4 } as CSSProperties}
          >
            <FreeLine className="text-sm text-paper-muted" />
            {/* Held at its tallest state (a Mac before the chip is known: both
                builds and a note), so nothing under it moves when it settles. */}
            <div className={cn(HERO_DOWNLOAD_BOX, mac && HERO_DOWNLOAD_BOX_MAC_TOUCH)}>
              <HeroDownload tone="ink" />
            </div>
          </div>
        </div>
      </div>

      <div
        className={cn(
          pinned
            ? "pointer-events-none absolute inset-0 z-20 flex items-center justify-center px-5 pt-16"
            : cn(CONTAINER, "relative pb-20 pt-12 sm:pb-28 sm:pt-16"),
        )}
      >
        <div
          ref={boxRef}
          className="pointer-events-none relative w-full"
          style={pinned ? { width: HERO_FRAME_WIDTH } : undefined}
        >
          {pinned ? frame : <Reveal variant="scale">{frame}</Reveal>}
        </div>
      </div>
    </Scene>
  );
}

/** The painted rooftop at dusk, as a sky behind the first screen. */
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
        <source
          type="image/avif"
          srcSet="/images/hero/hero-800.avif 800w, /images/hero/hero-1200.avif 1200w, /images/hero/hero-1536.avif 1536w"
          sizes="100vw"
        />
        <img
          src="/images/hero/hero-1200.webp"
          srcSet="/images/hero/hero-800.webp 800w, /images/hero/hero-1200.webp 1200w, /images/hero/hero-1536.webp 1536w"
          sizes="100vw"
          alt=""
          width={1536}
          height={1024}
          decoding="async"
          fetchPriority="low"
          className="h-full w-full object-cover object-[50%_35%] opacity-40 [mask-image:linear-gradient(to_bottom,black_0%,black_30%,transparent_100%)]"
        />
      </picture>
      <div className="absolute inset-0 bg-gradient-to-b from-ink/20 via-ink/45 to-ink" />
    </div>
  );
}

/* ---------------------------------------------------------------- Ticker */

const VERBS = ["entra na call", "passa a tela", "levanta a mão", "solta a música", "faz a enquete", "rola o dado", "chama a galera"];

/**
 * The page's one shout: the verbs of a night, in the brand face. It slides
 * with the scroll and only then, so nothing runs on its own and there is
 * nothing to pause. With reduced motion it stands still at the first verb.
 */
function Ticker() {
  const ref = useRef<HTMLDivElement>(null);
  useSceneProgress(ref, { mode: "through", rest: 0 });
  return (
    // Where the hero pins (lg with motion), its frame ends with the caption
    // near the bottom of the screen; the margin keeps the band off it.
    <div ref={ref} className="relative border-y border-white/[0.06] py-6 sm:py-8 motion-safe:lg:mt-12">
      <p className="sr-only">Entra na call, passa a tela, levanta a mão, solta a música, faz a enquete, rola o dado, chama a galera.</p>
      <div className="overflow-hidden [mask-image:linear-gradient(to_right,transparent,black_8%,black_92%,transparent)]">
        <div
          aria-hidden
          className="flex w-max"
          style={{ transform: `translate3d(${mix("0%", "-30%")}, 0, 0)`, willChange: "transform" }}
        >
          {[0, 1].map((copy) => (
            <ul key={copy} className="flex shrink-0 items-center">
              {VERBS.map((verb, i) => (
                <li key={verb} className="flex items-center whitespace-nowrap">
                  <span
                    className={cn(
                      "px-6 font-brand text-3xl uppercase tracking-tight sm:px-8 sm:text-5xl",
                      i % 2 ? "text-transparent [-webkit-text-stroke:1px_var(--color-text)]" : "text-paper",
                    )}
                  >
                    {verb}
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
