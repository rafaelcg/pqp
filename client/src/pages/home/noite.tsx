import {
  ArrowRight,
  ArrowUpRight,
  Hand,
  ListMusic,
  Lock,
  Mic,
  MonitorUp,
  Music2,
  Pause,
  PhoneOff,
  Search,
  SkipForward,
  VideoOff,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { type MessageKey, useTranslation } from "@/lib/i18n";
import type { Locale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { rich } from "./rich";
import { JoinButton } from "./shared/auth-buttons";
import { Avatar, CAST, SoundBars, type Person } from "./shared/mock";
import { useReducedMotion } from "./shared/motion";
import {
  BrowserFrame,
  Clip,
  type ClipFocus,
  type ClipSources,
  Scene,
  type StillImg,
  mix,
  stillImg,
  useMediaQuery,
  usePinnedScenes,
  within,
} from "./cinema";
import "./noite.css";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CARD,
  CONTAINER,
  CREATE_INTENT,
  Caption,
  Chip,
  ExampleTag,
  Eyebrow,
  FreeLine,
  H3,
  HEADER_GAP,
  IMPORT_INTENT,
  Section,
  SectionHeader,
  useCta,
} from "./ui";

/**
 * "A noite": the flagship's centrepiece. One evening with the crew in four
 * hours (voice, a screen share, a watch party, the music queue), and the
 * two CTAs once the night is over.
 *
 * At xl with motion: a 400vh pinned scene. The night's clock is a rail on the
 * left, the hour's words beside it, and one browser frame on the right whose
 * picture crossfades from hour to hour, each with its own slow camera move.
 * Everything that moves per frame is a CSS calc() on the scene's `--p`; React
 * only hears when the hour changes (four times through the whole scene).
 *
 * Elsewhere (phones, tablets, reduced motion): the four hours stack, each
 * with its picture right under its heading on a phone and beside its words
 * from lg up.
 *
 * The voice hour is a still of the real app, the share is real footage and
 * the watch party a capture of a live one, all with sample people. The music
 * queue is drawn (no footage of it exists), and its caption says so. None of
 * it repeats the hero's call footage, and no picture shows twice.
 *
 * What the section leaves out on purpose (the rules are in `ui.tsx`): no
 * eyebrow over an hour (the rail names it pinned, the clock chip stacked), no
 * lime on the headline or the rail, no glow, no tilt or magnetic pull, no
 * scroll reveal on the stacked hours, no icon tiles on the proof rows. Each
 * caption says what the picture shows and when, after the "exemplo" tag; the
 * full disclaimer is said once, under the hero footage.
 *
 * Every word is a catalogue key (`home.night.*`), translated at render. Data
 * at module scope holds keys, never text: a translation there would freeze
 * the language loaded at import time, and only English ships in the entry.
 * The voice and share pictures are pt-BR footage in every language; the
 * watch party capture exists per language and follows the reader's.
 */

type BeatId = "voice" | "share" | "party" | "music";

interface Beat {
  id: BeatId;
  time: string;
  /** The hour's name, above its heading and in the rail's accessible name. */
  label: MessageKey;
  /** One short word for the night's rail (its column is 5rem). */
  short: MessageKey;
  title: MessageKey;
  body: MessageKey;
  /** Short facts under the words, each a catalogue key. */
  proofs: readonly MessageKey[];
  /** What the picture shows, for screen readers. */
  sr: MessageKey;
  /** The line under the picture: what it shows and when (`{time}` is the hour's clock). */
  caption: MessageKey;
  /** Real footage or a drawing. */
  real: boolean;
}

/**
 * The four hours, as catalogue keys (translated at render). The source of
 * each claim sits beside it.
 */
const BEATS: readonly Beat[] = [
  {
    id: "voice",
    time: "21:40",
    label: "home.night.voice.label",
    short: "home.night.voice.short",
    title: "home.night.voice.title",
    body: "home.night.voice.body",
    proofs: [
      // Push-to-talk: browser (in-window) and desktop only, missing on iOS and Android (docs/PARITY.md:99).
      "home.night.voice.pushToTalk",
      // Per-peer volume (docs/PARITY.md:98). A listener-side mute is not verified, so the line says volume only.
      "home.night.voice.volume",
      // The 90 s resume window, web and desktop (CLAUDE.md pitfall 11; docs/PARITY.md:96).
      "home.night.voice.reload",
    ],
    sr: "home.night.voice.sr",
    caption: "home.night.voice.caption",
    real: true,
  },
  {
    id: "share",
    time: "22:10",
    label: "home.night.share.label",
    short: "home.night.share.short",
    // Sound on a share is a Chrome or Edge tab, or Windows 11 in the desktop
    // app (docs/DESKTOP.md:142-151): the title names the browsers, never a flat "with sound".
    title: "home.night.share.title",
    body: "home.night.share.body",
    proofs: [
      // SCREEN_SHARE_LIMIT is 2 on mesh and unbounded on the voice server (packages/shared/src/voice-backend.ts:66-69).
      "home.night.share.count",
      // The options exist; a large room holds 720p unless 1080p is chosen, so "up to", never "always"
      // (client/src/lib/livekit-session.ts:376, :389).
      "home.night.share.quality",
      // Android shares through MediaProjection, mesh and LiveKit (docs/ANDROID.md:72).
      "home.night.share.android",
    ],
    sr: "home.night.share.sr",
    caption: "home.night.share.caption",
    real: true,
  },
  {
    id: "party",
    time: "23:00",
    label: "home.night.party.label",
    short: "home.night.party.short",
    title: "home.night.party.title",
    // "Holds a packed room": over a hundred people on 2026-09-05 (docs/voice-backends.md:1030).
    body: "home.night.party.body",
    proofs: [],
    // The picture on the stage is a test pattern, so the words say a test stream.
    sr: "home.night.party.sr",
    caption: "home.night.party.caption",
    real: true,
  },
  {
    id: "music",
    time: "00:30",
    label: "home.night.music.label",
    short: "home.night.music.short",
    title: "home.night.music.title",
    body: "home.night.music.body",
    proofs: [
      // A queue per call, the same song for everyone (docs/MUSIC.md:4-6). Web and desktop: native is not verified.
      "home.night.music.queue",
      // A pasted link needs no key; search needs YOUTUBE_API_KEY (CLAUDE.md, Music queue), so the link leads.
      "home.night.music.add",
      // Skip and pause need MANAGE_MUSIC, or SPEAK with open controls (docs/MUSIC.md:93).
      "home.night.music.permission",
    ],
    sr: "home.night.music.sr",
    caption: "home.night.music.caption",
    real: false,
  },
];

const N = BEATS.length;

/* ------------------------------------------------------------------------ */
/* Footage                                                                   */
/* ------------------------------------------------------------------------ */

const MEDIA = "/media/home/";

/** How wide a picture is drawn: the pinned frame or the wide stacked column, else the screen. */
const FRAME_SIZES = "(min-width: 1024px) 60vw, 100vw";

/**
 * 21:40: the channel list of A Mesa (656 by 1520), with Lobby full and the
 * rings of whoever speaks lit. The hero already plays the call itself, so
 * this hour shows the room from the sidebar instead.
 */
const VOICE_LIST = stillImg("voice-list", "");

/**
 * share: Bia's share on the stage. The loop's first second is the call before
 * the share starts, so the rest frame is the still taken mid-share instead.
 */
const TELA_SOURCES: ClipSources = {
  webm: `${MEDIA}share.webm`,
  mp4: `${MEDIA}share.mp4`,
  webmSmall: `${MEDIA}share-960.webm`,
  mp4Small: `${MEDIA}share-960.mp4`,
  poster: `${MEDIA}still-share.webp`,
  posterSmall: `${MEDIA}still-share-960.webp`,
};

/**
 * The share's rest frame and the words that describe it, in the reader's
 * language. Built at render, never at module scope (see the file's head).
 */
function useShareStill() {
  const { t } = useTranslation();
  return useMemo(() => {
    const label = t("home.night.share.sr");
    return { label, still: stillImg("share", label, FRAME_SIZES) };
  }, [t]);
}

/**
 * On a phone the share is cropped to the call's stage (in a 3 by 2 box): the
 * painting edge to edge and the row of people under it, about a third larger
 * than the whole window would draw it.
 */
const TELA_FOCUS: ClipFocus = { x: 41, y: 25, zoom: 1.28 };

/**
 * The pause button sits over the message box, the one quiet strip of the real
 * app, left of the call's controls and clear of the members list. On a phone
 * the crop moves that strip, so the button keeps its corner there.
 */
const CLIP_CONTROL = "md:bottom-[1%] md:right-[44%]";

/**
 * 23:00: a capture of a live watch party (1440 by 850), with a test pattern
 * on the stage and the chat beside it. Not the share's painting, so the two
 * hours never show one picture. One capture per language, named the way
 * /streamers names them (`streamers-page.tsx`, `shotSrc`): the channel is
 * "Sexta com a comunidade", "Friday with the community" or "Viernes con la
 * comunidad", and `home.night.party.sr` names the one the reader sees.
 */
function partyImg(locale: Locale) {
  const base = `/images/streamers/live-${locale}`;
  return {
    src: `${base}.webp`,
    srcSet: `${base}-720.webp 720w, ${base}.webp 1440w`,
    sizes: FRAME_SIZES,
    width: 1440,
    height: 850,
  };
}

const FOOTAGE_ASPECT = "16 / 10";

/* ------------------------------------------------------------------------ */
/* The scene's timing (fractions of the pinned run)                          */
/* ------------------------------------------------------------------------ */

/** Half the width of a picture crossfade around each hour's boundary. */
const FADE = 0.035;
/** How early a layer's footage mounts before it starts to show. */
const LEAD = 0.12;

const startOf = (i: number) => i / N;
const endOf = (i: number) => (i + 1) / N;

/**
 * The picture of hour `i` wipes in from the right over its first boundary
 * (`wipe`, 0 to 1). The hour before it stays put underneath until the wipe is
 * complete, so two screens never overprint; only then does it go (`gone`).
 */
function layerVisibility(i: number) {
  const wipe = i === 0 ? "1" : within(startOf(i) - FADE, startOf(i) + FADE);
  const gone = i === N - 1 ? "0" : within(endOf(i) + FADE, endOf(i) + FADE + 0.004);
  return { wipe, gone };
}

/** The camera's 0 to 1 through hour `i`, crossfades included. */
function localProgress(i: number) {
  return within(Math.max(0, startOf(i) - FADE), Math.min(1, endOf(i) + FADE));
}

/**
 * The words of hour `i`, piece `k`: they leave in the last stretch before the
 * boundary and arrive from the boundary on, one piece at a time, so two hours
 * never overlap and the column is never empty for long.
 */
function textStyle(i: number, k: number): CSSProperties {
  const s = startOf(i) + k * 0.01;
  const e = endOf(i);
  const enter = i === 0 ? "1" : within(s, s + 0.035);
  const leave = i === N - 1 ? "0" : within(e - 0.035, e);
  return {
    opacity: `calc(${enter} * (1 - ${leave}))`,
    transform: `translate3d(0, calc((1 - ${enter}) * 30px - ${leave} * 22px), 0)`,
  };
}

/** Which layers are near enough to hold live footage, as a bitmask. */
function mountedMask(p: number): number {
  let mask = 0;
  for (let i = 0; i < N; i++) {
    const from = i === 0 ? -1 : startOf(i) - FADE - LEAD;
    const to = i === N - 1 ? 2 : endOf(i) + FADE;
    if (p >= from && p <= to) mask |= 1 << i;
  }
  return mask;
}

/* ------------------------------------------------------------------------ */
/* The section                                                               */
/* ------------------------------------------------------------------------ */

/**
 * Older anchors that land here (decision 19 of the build plan): nothing in
 * the repository links them today, and they cost one empty span each.
 */
const NIGHT_ALIASES = ["voice", "screen"] as const;

export function Noite() {
  const { t } = useTranslation();
  // The pinned frame needs room: below xl the hours stack, side by side.
  const motion = usePinnedScenes();
  const wide = useMediaQuery("(min-width: 1280px)");
  // The stage is taller than a short window (a 720p laptop with its browser chrome).
  const tall = useMediaQuery("(min-height: 640px)");
  const pinned = motion && wide && tall;
  return (
    // The section ends on a pair of calls to action, so it hands over to Mudança with half
    // the usual space on each side of the join (Mudança's top is trimmed to match).
    <Section
      id="noite"
      aliases={NIGHT_ALIASES}
      labelledBy="noite-title"
      divider={false}
      className="pb-16 sm:pb-20"
    >
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow={t("home.night.eyebrow")}
          titleId="noite-title"
          title={rich(t("home.night.title"), { accent: t("home.night.titleAccent") })}
          lede={t("home.night.lede")}
        />
      </div>
      {pinned ? <PinnedNight /> : <StackedNight />}
      <NightEnd pinned={pinned} />
    </Section>
  );
}

/**
 * Whether `el` is near the viewport, both ways (unlike useInView, which only
 * ever turns on). Looping animations run only while this is true.
 */
function useNearViewport<T extends Element>(margin = "200px 0px") {
  const ref = useRef<T>(null);
  const [near, setNear] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: margin });
    io.observe(el);
    return () => io.disconnect();
  }, [margin]);
  return [ref, near] as const;
}

/* ------------------------------------------------------------------------ */
/* Pinned (xl, motion allowed)                                               */
/* ------------------------------------------------------------------------ */

function PinnedNight() {
  const { t } = useTranslation();
  const stageRef = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [mounted, setMounted] = useState(1);
  const activeRef = useRef(0);
  const mountedRef = useRef(1);
  // Looping animations (the rail's ping, the equaliser bars) run only while
  // the scene's runway is near the screen.
  const [near, setNear] = useState(false);
  useEffect(() => {
    const runway = stageRef.current?.parentElement;
    if (!runway || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setNear(e.isIntersecting), { rootMargin: "200px 0px" });
    io.observe(runway);
    return () => io.disconnect();
  }, []);

  // Per frame, compare only: React hears about an hour change, nothing else.
  const onProgress = useCallback((p: number) => {
    const next = Math.min(N - 1, Math.floor(p * N));
    if (next !== activeRef.current) {
      activeRef.current = next;
      setActive(next);
    }
    const mask = mountedMask(p);
    if (mask !== mountedRef.current) {
      mountedRef.current = mask;
      setMounted(mask);
    }
  }, []);

  /**
   * Scrolls the page to the middle of hour `i`'s stretch of the runway.
   * Without `smooth` it jumps: the page's html scrolls smoothly, and a focus
   * jump that glides lets the next Tab land before the hour has changed.
   */
  const goTo = useCallback((i: number, smooth = true) => {
    const runway = stageRef.current?.parentElement;
    if (!runway) return;
    const rect = runway.getBoundingClientRect();
    const run = rect.height - window.innerHeight;
    const top = window.scrollY + rect.top + run * (startOf(i) + 0.4 / N);
    window.scrollTo({ top, behavior: smooth ? "smooth" : "instant" });
  }, []);

  const words = useRef<(HTMLDivElement | null)[]>([]);
  const picking = useRef(false);

  /**
   * A pick on the rail: glide to the hour, and move focus to its heading the
   * way an in-page anchor does, so the next Tab goes on from that hour instead
   * of back through the hours before it. The flag keeps that focus from
   * jumping the glide (the words' own focus handler would).
   */
  const pick = useCallback(
    (i: number) => {
      goTo(i);
      picking.current = true;
      words.current[i]?.querySelector<HTMLElement>("[data-hour-head]")?.focus({ preventScroll: true });
      picking.current = false;
    },
    [goTo],
  );

  // No HEADER_GAP above the runway: the stage centres the frame in the
  // screen, which already leaves more room under the header than that.
  return (
    <Scene
      height="400vh"
      onProgress={onProgress}
      stageRef={stageRef}
      stageClassName="flex items-center"
    >
      {/* The left edge is the page's own (a 1200px container with 2rem of padding); only the right bleeds.
          The words' column holds "Ninguém quer desligar." on one line at the H3's size. */}
      <div className="relative grid w-full grid-cols-[5rem_minmax(0,21rem)_minmax(0,1fr)] items-center gap-x-8 pb-0 pl-[max(2rem,calc((100%_-_1200px)/2_+_2rem))] pr-8 pt-20 2xl:grid-cols-[5rem_minmax(0,22rem)_minmax(0,1fr)] 2xl:gap-x-10">
        <NightRail active={active} onPick={pick} />

        <div className="grid">
          {BEATS.map((beat, i) => (
            <div
              key={beat.id}
              ref={(el) => {
                words.current[i] = el;
              }}
              className={cn("[grid-area:1/1] self-center", i !== active && "pointer-events-none")}
              onFocus={() => {
                // Tabbing into an hour that is not on screen brings it there.
                if (!picking.current && activeRef.current !== i) goTo(i, false);
              }}
            >
              <PinnedWords beat={beat} index={i} />
            </div>
          ))}
        </div>

        <figure className="relative m-0 w-full max-w-[calc((100svh-15.5rem)*1.6)] justify-self-end">
          <BigHour />
          <BrowserFrame bodyStyle={{ aspectRatio: FOOTAGE_ASPECT }} className="w-full">
            {BEATS.map((beat, i) => {
              const { wipe, gone } = layerVisibility(i);
              const on = i === active;
              return (
                <div
                  key={beat.id}
                  inert={!on}
                  aria-hidden={!on}
                  className="absolute inset-0"
                  style={{
                    // Later hours draw above and wipe in from the right; this one
                    // goes only once the next is fully in.
                    zIndex: i,
                    opacity: `calc(1 - ${gone})`,
                    clipPath: i === 0 ? undefined : `inset(0 0 0 calc((1 - ${wipe}) * 100%))`,
                    transform: i === 0 ? undefined : `scale(${mix("1.03", "1", wipe)})`,
                    willChange: i === 0 ? "opacity" : "opacity, transform, clip-path",
                  }}
                >
                  <Picture
                    id={beat.id}
                    index={i}
                    live={(mounted & (1 << i)) !== 0}
                    playing={on}
                    near={near}
                  />
                </div>
              );
            })}
          </BrowserFrame>
          <figcaption className="relative mt-4 grid text-xs text-paper-muted sm:text-[13px]">
            {BEATS.map((beat, i) => (
              <span
                key={beat.id}
                aria-hidden={i !== active}
                className={cn(
                  "flex items-center gap-2 transition-opacity duration-500 [grid-area:1/1]",
                  i === active ? "opacity-100" : "opacity-0",
                )}
              >
                <ExampleTag />
                {t(beat.caption, { time: beat.time })}
              </span>
            ))}
          </figcaption>
        </figure>
      </div>
    </Scene>
  );
}

/**
 * The hour, very large and drawn in outline, rising behind the top edge of
 * the frame. Decorative: the rail says the same thing in words.
 */
function BigHour() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute bottom-full right-[2%] grid translate-y-[24%] select-none"
    >
      {BEATS.map((beat, i) => {
        // Like the words: out just before the boundary, in just after.
        const fadeIn = i === 0 ? "1" : within(startOf(i), startOf(i) + 0.035);
        const fadeOut = i === N - 1 ? "0" : within(endOf(i) - 0.035, endOf(i));
        return (
          <span
            key={beat.id}
            className="font-brand text-[clamp(4.5rem,8.4vw,9.5rem)] leading-none tracking-tight text-transparent [-webkit-text-stroke:1px_color-mix(in_oklch,var(--color-text)_22%,transparent)] [grid-area:1/1]"
            style={{
              opacity: `calc(${fadeIn} * (1 - ${fadeOut}))`,
              transform: `translate3d(0, calc((1 - ${fadeIn}) * 40px - ${fadeOut} * 40px), 0)`,
            }}
          >
            {beat.time}
          </span>
        );
      })}
    </div>
  );
}

/**
 * The night's clock: four hours on a vertical rail that fills as you scroll.
 * Paper, not lime, and still: the active hour is the brighter and larger one.
 */
function NightRail({ active, onPick }: { active: number; onPick: (i: number) => void }) {
  const { t } = useTranslation();
  return (
    <div role="group" aria-label={t("home.night.rail")} className="relative h-[min(27rem,52svh)] self-center">
      {/* Track and fill: the fill reaches each hour as its stretch begins. */}
      <span aria-hidden className="absolute bottom-[7px] left-[5px] top-[7px] w-px bg-white/[0.09]" />
      <span
        aria-hidden
        className="absolute bottom-[7px] left-[5px] top-[7px] w-px origin-top bg-paper/45"
        style={{ transform: `scaleY(clamp(0, calc(var(--p) * ${N / (N - 1)}), 1))` }}
      />
      <ol className="relative flex h-full flex-col justify-between">
        {BEATS.map((beat, i) => {
          const on = i === active;
          const past = i < active;
          return (
            <li key={beat.id}>
              <button
                type="button"
                onClick={() => onPick(i)}
                aria-current={on ? "step" : undefined}
                aria-label={`${beat.time}, ${t(beat.label)}`}
                className="group -m-2 flex items-start gap-3 rounded-lg p-2 pr-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                <span aria-hidden className="relative mt-[3px] grid h-[11px] w-[11px] shrink-0 place-items-center">
                  <span
                    className={cn(
                      "relative h-[11px] w-[11px] rounded-full border transition-colors duration-300 ease-out",
                      on && "border-paper bg-paper",
                      past && "border-paper/55 bg-ink",
                      !on && !past && "border-white/25 bg-ink group-hover:border-white/50",
                    )}
                  />
                </span>
                <span aria-hidden className="block">
                  <span
                    className={cn(
                      "block origin-left font-mono text-[13px] tabular-nums leading-none transition-[transform,color] duration-300 ease-out",
                      on ? "scale-[1.3] text-paper" : "text-paper-muted group-hover:text-paper",
                    )}
                  >
                    {beat.time}
                  </span>
                  <span
                    className={cn(
                      "mt-2.5 block whitespace-nowrap text-[13px] leading-tight transition-colors duration-300 ease-out",
                      on ? "text-paper" : "text-paper-muted group-hover:text-paper",
                    )}
                  >
                    {t(beat.short)}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* Stacked (phones, tablets, reduced motion)                                 */
/* ------------------------------------------------------------------------ */

/**
 * Each hour is one grid (`noite-hour` in noite.css): on a phone its heading,
 * then its picture, then the rest of its words; from lg up the picture takes
 * one column beside the words, on alternating sides.
 */
function StackedNight() {
  const { t } = useTranslation();
  return (
    <div className={cn(CONTAINER, HEADER_GAP)}>
      <ol className="flex flex-col gap-24 sm:gap-28 lg:gap-36">
        {BEATS.map((beat, i) => (
          <li key={beat.id} className="noite-hour" data-flip={i % 2 === 1 ? "" : undefined}>
            <div className="[grid-area:head]">
              <BeatHead beat={beat} />
            </div>
            <figure className="relative m-0 mt-7 [grid-area:media] lg:mt-0 lg:self-center">
              <BrowserFrame>
                <StackedPicture id={beat.id} />
              </BrowserFrame>
              {/* The tag keeps its line and the words wrap beside it, even at 360. */}
              <Caption example as="figcaption" className="flex-nowrap items-start">
                {t(beat.caption, { time: beat.time })}
              </Caption>
            </figure>
            <div className="mt-8 [grid-area:body] lg:mt-4">
              <BeatBody beat={beat} />
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* The end of the night: the page's CTA pair                                 */
/* ------------------------------------------------------------------------ */

/** The id of the night's closing CTAs (the phone's sticky bar steps aside for them). */
export const NOITE_CTAS_ID = "noite-ctas";

function NightEnd({ pinned }: { pinned: boolean }) {
  const { t } = useTranslation();
  const cta = useCta();
  return (
    <div className={cn(CONTAINER, pinned ? "mt-4" : "mt-24 sm:mt-28 lg:mt-36")}>
      <div className="flex flex-col items-start gap-8 lg:grid lg:grid-cols-12 lg:items-end lg:gap-12">
        <H3 size="lg" className="max-w-[16ch] lg:col-span-6">
          {t("home.night.end.title")}
        </H3>
        <div id={NOITE_CTAS_ID} className="w-full lg:col-span-6 lg:justify-self-end">
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row lg:justify-end">
            <JoinButton intent={CREATE_INTENT} className={cn(BTN_PRIMARY, "w-full sm:w-auto")}>
              {cta.create}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </JoinButton>
            <JoinButton intent={IMPORT_INTENT} className={cn(BTN_SECONDARY, "w-full sm:w-auto")}>
              {cta.importDiscord}
            </JoinButton>
          </div>
          <FreeLine className="mt-3 text-sm text-paper-muted text-pretty lg:text-right" />
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* The words of one hour                                                     */
/* ------------------------------------------------------------------------ */

type Piece = (k: number) => CSSProperties | undefined;

/**
 * The hour's heading, with no eyebrow over it: pinned, the rail already names
 * the hour; stacked, a clock chip carries it (the night's clock is the
 * section's sequence, so the numbers stay). The hour's name is still there
 * for screen readers. The watch party's "early access" chip is the one thing
 * that sits above a heading, because it says something the heading does not.
 */
function BeatHead({ beat, pinned = false, piece }: { beat: Beat; pinned?: boolean; piece?: Piece }) {
  const { t } = useTranslation();
  const party = beat.id === "party";
  const row = !pinned || party;
  return (
    <>
      {pinned && <p className="sr-only">{t(beat.label)}</p>}
      {row && (
        <div className="flex flex-wrap items-center gap-3" style={piece?.(0)}>
          {!pinned && (
            <Eyebrow time={beat.time}>
              <span className="sr-only">{t(beat.label)}</span>
            </Eyebrow>
          )}
          {party && <Chip className="py-0.5">{t("home.night.party.badge")}</Chip>}
        </div>
      )}
      {/* Pinned, the heading is where a pick on the rail leaves focus. */}
      <div
        className={cn("outline-none", row && "mt-5")}
        style={piece?.(1)}
        tabIndex={pinned ? -1 : undefined}
        data-hour-head={pinned ? "" : undefined}
      >
        <H3 size="lg" className="max-w-[22ch]">
          {t(beat.title)}
        </H3>
      </div>
    </>
  );
}

/** The rest of the hour's words: the body, its proofs and its notes. */
function BeatBody({ beat, piece }: { beat: Beat; piece?: Piece }) {
  const { t } = useTranslation();
  return (
    <>
      <p className="max-w-md text-[17px] leading-relaxed text-paper-muted text-pretty" style={piece?.(2)}>
        {t(beat.body)}
      </p>
      <p className="sr-only">{t(beat.sr)}</p>

      {beat.proofs.length > 0 && (
        <ul
          className="mt-6 max-w-md divide-y divide-white/[0.06] border-y border-white/[0.06]"
          style={piece?.(3)}
        >
          {beat.proofs.map((text) => (
            <li key={text} className="py-3 text-[15px] leading-snug text-paper text-pretty">
              {t(text)}
            </li>
          ))}
        </ul>
      )}

      {/* The caveat the share's title points to (docs/DESKTOP.md:142-151). */}
      {beat.id === "share" && (
        <p className="mt-4 max-w-md text-[13px] leading-relaxed text-paper-muted" style={piece?.(4)}>
          {t("home.night.share.note")}
        </p>
      )}

      {beat.id === "party" && (
        <>
          {/* The one capacity figure the project states publicly: 2026-09-05 (docs/voice-backends.md:1030). */}
          <div className={cn(CARD, "mt-7 flex max-w-md items-center gap-5 p-5")} style={piece?.(3)}>
            {/* Smaller than the H2 at every width: the H2 holds its 2.1rem floor up to about 760px and passes 44px only past 1000px. */}
            <span className="font-brand text-[32px] leading-none text-paper xl:text-[44px]">100+</span>
            <p className="text-sm leading-snug text-paper-muted text-pretty">{t("home.night.party.proof")}</p>
          </div>
          {/* Early access, opened per server (CLAUDE.md, "Watch party availability is data"). The
              list's page is public and the shipped landing links it for everyone, so no gate. */}
          <p className="mt-5 max-w-md text-sm leading-relaxed text-paper-muted" style={piece?.(4)}>
            {t("home.night.party.access")}
            <Link
              to="/watch-party"
              className="mt-1 flex min-h-10 w-fit items-center gap-1 font-medium text-paper underline decoration-white/25 underline-offset-4 transition-colors duration-200 ease-out hover:decoration-paper focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              {t("home.night.party.waitlist")}
              <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
            </Link>
          </p>
        </>
      )}
    </>
  );
}

/** Pinned: the hour's words in one column, each piece in its own slot of the hour's entrance. */
const PinnedWords = memo(function PinnedWords({ beat, index }: { beat: Beat; index: number }) {
  const piece = (k: number) => textStyle(index, k);
  return (
    <div>
      <BeatHead beat={beat} pinned piece={piece} />
      <div className="mt-4">
        <BeatBody beat={beat} piece={piece} />
      </div>
    </div>
  );
});

/* ------------------------------------------------------------------------ */
/* The pictures                                                              */
/* ------------------------------------------------------------------------ */

/**
 * One hour's picture inside the pinned frame, with its camera move. `live`
 * mounts the footage (only the hours on or near the screen hold a video, so
 * the page never decodes two at once); otherwise the same rest frame shows
 * as a plain image, so the swap is invisible.
 */
const Picture = memo(function Picture({
  id,
  index,
  live,
  playing,
  near,
}: {
  id: BeatId;
  index: number;
  live: boolean;
  playing: boolean;
  near: boolean;
}) {
  const share = useShareStill();
  const progress = localProgress(index);
  // Looping motion inside a drawing runs only for the hour on screen, near the viewport.
  const running = playing && near;
  // The voice room and the watch party share one slow push in.
  if (id === "voice") return <VoiceRoom zoom={mix("1", "1.1", progress)} />;
  if (id === "share") {
    return (
      <Camera cam={`scale(${mix("1.16", "1.02", progress)})`} origin="42% 34%">
        {live ? (
          <Clip
            src={TELA_SOURCES}
            fallbackStill={share.still}
            label={share.label}
            className="absolute inset-0"
            controlsClassName={CLIP_CONTROL}
          />
        ) : (
          <RestFrame still={share.still} />
        )}
      </Camera>
    );
  }
  if (id === "party") return <WatchParty zoom={mix("1", "1.14", progress)} />;
  return <MusicQueue running={running} />;
});

/** Stacked: each hour's picture, framed for a narrow screen below md. */
function StackedPicture({ id }: { id: BeatId }) {
  const share = useShareStill();
  if (id === "voice") {
    return (
      <div className="relative aspect-square md:aspect-[16/10]">
        <VoiceRoom />
      </div>
    );
  }
  if (id === "share") {
    return (
      <Clip
        src={TELA_SOURCES}
        fallbackStill={share.still}
        label={share.label}
        aspect="3 / 2"
        focus={TELA_FOCUS}
        className="md:aspect-[16/10]!"
        controlsClassName={CLIP_CONTROL}
      />
    );
  }
  if (id === "party") {
    return (
      <div className="relative aspect-[4/3] md:aspect-[16/10]">
        <WatchParty />
      </div>
    );
  }
  return <StackedMusic />;
}

/**
 * The voice room: the channel list on its own colour (the still's background
 * is `bg-ink-2` exactly), with the server rail and the sidebar's edge clipped
 * off, so the crop has no seam and Lobby sits in the middle of the frame. On
 * a phone it fills a square from VOZ down to Leo; from md the frame is wider
 * and shows the next channel too. `zoom` is the pinned scene's push in.
 */
function VoiceRoom({ zoom = "1" }: { zoom?: string }) {
  return (
    <div aria-hidden className="noite-voice absolute inset-0 overflow-hidden bg-ink-2">
      <img
        {...VOICE_LIST}
        loading="lazy"
        decoding="async"
        draggable={false}
        className="absolute left-1/2 top-1/2 h-auto w-[112%] max-w-none md:w-[60%]"
        style={{ "--vl-zoom": zoom } as CSSProperties}
      />
    </div>
  );
}

/** Moves the footage inside its layer (see noite.css), never the controls. */
function Camera({ cam, origin, children }: { cam: string; origin: string; children: ReactNode }) {
  return (
    <div
      className="noite-cam absolute inset-0"
      style={{ "--cam": cam, "--cam-origin": origin } as CSSProperties}
    >
      {children}
    </div>
  );
}

function RestFrame({ still }: { still: StillImg }) {
  return (
    <div className="absolute inset-0 overflow-hidden bg-ink-2">
      <img
        {...still}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover object-top"
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* 23:00, the watch party (a capture of a live one)                          */
/* ------------------------------------------------------------------------ */

/**
 * The capture in its frame. From md it fills the 16:10 frame with the server
 * rail cropped off; on a phone the 4:3 box holds the stage, the title with
 * its AO VIVO and the chat (noite.css). `zoom` is the pinned scene's push in.
 */
function WatchParty({ zoom = "1" }: { zoom?: string }) {
  // The capture in the language the words are in (the locale the catalogue answers for).
  const { locale } = useTranslation();
  const img = useMemo(() => partyImg(locale), [locale]);
  return (
    <div aria-hidden className="noite-party absolute inset-0 overflow-hidden bg-ink-2">
      <img
        {...img}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="absolute inset-0 h-full w-full object-cover"
        style={{ "--party-zoom": zoom } as CSSProperties}
      />
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* 00:30, the music queue (a drawing: no footage of it may exist)            */
/* ------------------------------------------------------------------------ */

/**
 * Lays a fixed-size drawing out at its own size and scales it to fit the
 * box, so the drawn app reads at the same scale as the footage beside it. The
 * scale is measured on resize only, never per frame.
 */
function Fit({ width, height, children }: { width: number; height: number; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const set = (w: number) => el.style.setProperty("--fit", String(w / width));
    set(el.clientWidth);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(([e]) => set(e.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);
  return (
    <div ref={ref} className="absolute inset-0 overflow-hidden">
      <div style={{ width, height, transform: "scale(var(--fit, 0.5))", transformOrigin: "0 0" }}>{children}</div>
    </div>
  );
}

const SONG_SECONDS = 228;

/** A made-up song: its title and band are catalogue keys, so each language gets its own. */
interface Song {
  title: MessageKey;
  artist: MessageKey;
  by: Person;
}

const NOW_PLAYING: Song = {
  title: "home.night.song.rooftop.title",
  artist: "home.night.song.rooftop.artist",
  by: CAST.nico,
};

const QUEUE: readonly (Song & { length: string })[] = [
  { title: "home.night.song.bus.title", artist: "home.night.song.bus.artist", by: CAST.bia, length: "3:12" },
  { title: "home.night.song.cheese.title", artist: "home.night.song.cheese.artist", by: CAST.caio, length: "4:05" },
  { title: "home.night.song.call.title", artist: "home.night.song.call.artist", by: CAST.duda, length: "2:47" },
  { title: "home.night.song.market.title", artist: "home.night.song.market.artist", by: CAST.leo, length: "3:30" },
];

const LOBBY = [CAST.zeca, CAST.bia, CAST.caio, CAST.nico, CAST.duda, CAST.leo];

/**
 * The song's art, drawn the way the app draws a track's: a small-radius
 * square on a flat colour, holding the track's thumbnail edge to edge. The
 * thumbnail is the rooftop painting the page opens on, cropped square (the
 * song is "Rooftop at 11"), so no picture here is a gradient made up for it.
 */
function AlbumArt({ className }: { className?: string }) {
  return (
    <span className={cn("relative block shrink-0 overflow-hidden rounded-lg bg-ink-3", className)}>
      <img
        src="/images/hero/hero-480.webp"
        srcSet="/images/hero/hero-480.webp 480w, /images/hero/hero-800.webp 800w"
        sizes="128px"
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        className="h-full w-full object-cover object-[42%_55%]"
      />
    </span>
  );
}

function clock(s: number) {
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** The song's clock, ticking only while asked to and motion is allowed. */
function useSongClock(running: boolean) {
  const reduced = useReducedMotion();
  const [elapsed, setElapsed] = useState(74);
  useEffect(() => {
    if (!running || reduced) return;
    const id = window.setInterval(() => setElapsed((s) => (s + 1) % SONG_SECONDS), 1000);
    return () => window.clearInterval(id);
  }, [running, reduced]);
  return elapsed;
}

function StackedMusic() {
  // The song's clock and the bars run only while the drawing is on screen.
  const [ref, onScreen] = useNearViewport<HTMLDivElement>("0px");
  return (
    <div ref={ref} className="relative aspect-[4/5] md:aspect-[16/10]">
      <div className="md:hidden">
        <Fit width={520} height={650}>
          <MusicNarrow running={onScreen} />
        </Fit>
      </div>
      <div className="hidden md:block">
        <Fit width={WIDE.width} height={WIDE.height}>
          <MusicWide running={onScreen} />
        </Fit>
      </div>
    </div>
  );
}

function MusicQueue({ running }: { running: boolean }) {
  return (
    <Fit width={WIDE.width} height={WIDE.height}>
      <MusicWide running={running} />
    </Fit>
  );
}

/** Where the wide drawing is laid out; Fit scales it to the frame. */
const WIDE = { width: 1000, height: 625 };

/**
 * The drawn music view at 1000 by 625: the call's main panel and its queue,
 * cropped from the real app so every row reads at the footage's scale. The
 * queue is the point; the lit note on the call bar is how you open it.
 */
function MusicWide({ running }: { running: boolean }) {
  const { t } = useTranslation();
  const elapsed = useSongClock(running);
  return (
    <div aria-hidden data-live={running} className="noite-music flex h-full w-full bg-ink text-[15px] text-paper">
      {/* Main: what is playing, and the call bar. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[56px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-6">
          <Mic className="h-4 w-4 text-signal" />
          <div className="leading-tight">
            {/* literal-ok: the voice channel's name, as in the footage */}
            <p className="font-semibold">Lobby</p>
            <p className="text-[12px] text-paper-muted">{t("home.night.mock.here", { n: LOBBY.length })}</p>
          </div>
          <span className="ml-auto inline-flex items-center gap-2 rounded-full bg-signal/15 px-3 py-1 text-[12px] font-medium text-signal">
            <SoundBars className="text-signal" />
            {t("home.night.mock.playingForAll")}
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-center gap-6 px-8">
          <AlbumArt className="h-[128px] w-[128px]" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-paper-muted">
              {t("home.night.mock.nowPlaying")}
            </p>
            <p className="mt-2 flex items-center gap-3">
              <span className="truncate font-display text-[34px] font-bold leading-none tracking-tight">
                {t(NOW_PLAYING.title)}
              </span>
              <ExampleTag className="shrink-0" />
            </p>
            <p className="mt-2 flex items-center gap-2 text-[14px] text-paper-muted">
              {t(NOW_PLAYING.artist)}
              <span className="text-paper-muted/50">·</span>
              {rich(t("home.night.mock.requestedBy"), {
                who: (
                  <>
                    <Avatar person={NOW_PLAYING.by} size={20} />
                    <span className="font-semibold text-violet-400">{NOW_PLAYING.by.name}</span>
                  </>
                ),
              })}
            </p>
            <div className="mt-5 flex items-center gap-3">
              <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
                <span
                  className="absolute inset-0 origin-left rounded-full bg-signal transition-transform duration-1000 ease-linear motion-reduce:transition-none"
                  style={{ transform: `scaleX(${elapsed / SONG_SECONDS})` }}
                />
              </span>
              <span className="text-[12px] tabular-nums text-paper-muted">
                {clock(elapsed)} / {clock(SONG_SECONDS)}
              </span>
            </div>
            <div className="mt-4 flex items-center gap-2.5">
              <span className="grid h-10 w-10 place-items-center rounded-full bg-paper text-ink">
                <Pause className="h-[18px] w-[18px]" />
              </span>
              <span className="grid h-10 w-10 place-items-center rounded-full bg-white/[0.07]">
                <SkipForward className="h-[18px] w-[18px]" />
              </span>
              <span className="ml-2 inline-flex items-center gap-1.5 text-[12px] text-paper-muted">
                <Lock className="h-3.5 w-3.5" />
                {t("home.night.mock.permission")}
              </span>
            </div>
          </div>
        </div>

        <CallBar />
      </div>

      {/* The queue: the focus of the picture. */}
      <div className="flex w-[400px] shrink-0 flex-col border-l border-white/[0.06] bg-ink-2/50">
        <p className="flex h-[56px] shrink-0 items-center gap-2 border-b border-white/[0.06] px-5 text-[13px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
          <ListMusic className="h-4 w-4 text-signal" />
          {t("home.night.mock.upNext")} · {QUEUE.length}
        </p>
        <ul className="flex-1 space-y-1 px-3 py-3">
          {QUEUE.map((q, i) => (
            <li
              key={q.title}
              className={cn("flex items-center gap-3.5 rounded-xl px-3.5 py-[18px]", i === 0 && "bg-white/[0.05]")}
            >
              <span className="w-4 text-right text-[15px] tabular-nums text-paper-muted">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[18px] font-semibold leading-tight">{t(q.title)}</span>
                <span className="mt-1.5 flex items-center gap-2 truncate text-[14px] text-paper-muted">
                  <Avatar person={q.by} size={20} />
                  {q.by.name} · {t(q.artist)}
                </span>
              </span>
              <span className="text-[14px] tabular-nums text-paper-muted">{q.length}</span>
            </li>
          ))}
        </ul>
        <div className="m-4 mt-0 flex h-12 items-center gap-2.5 rounded-xl border border-white/[0.08] bg-ink px-4 text-[14px] text-paper-muted">
          <Search className="h-4 w-4 shrink-0" />
          {t("home.night.mock.search")}
        </div>
      </div>
    </div>
  );
}

/** The call bar at the foot of the real app, with the music note lit. */
function CallBar() {
  const { t } = useTranslation();
  const btn = "grid h-10 w-10 place-items-center rounded-full text-paper";
  return (
    <div className="m-4 mt-0 shrink-0 rounded-2xl border border-white/[0.07] bg-ink-2/70">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex -space-x-2">
          {LOBBY.slice(0, 3).map((p) => (
            <Avatar key={p.name} person={p} size={30} accent className="ring-2 ring-ink-2" />
          ))}
        </span>
        <span className="text-[14px]">{t("home.night.mock.inCall", { n: LOBBY.length })}</span>
        <span className="text-[13px] tabular-nums text-paper-muted">2:51:07</span>
        <span className="ml-auto flex items-center gap-1">
          <span className={btn}>
            <Mic className="h-[18px] w-[18px]" />
          </span>
          <span className={btn}>
            <VideoOff className="h-[18px] w-[18px]" />
          </span>
          <span className={btn}>
            <MonitorUp className="h-[18px] w-[18px]" />
          </span>
          <span className={btn}>
            <Hand className="h-[18px] w-[18px]" />
          </span>
          <span className={cn(btn, "bg-signal text-ink")}>
            <Music2 className="h-[18px] w-[18px]" />
          </span>
          <span className="ml-2 grid h-10 w-12 place-items-center rounded-full bg-danger text-white">
            <PhoneOff className="h-[18px] w-[18px]" />
          </span>
        </span>
      </div>
    </div>
  );
}

/** The drawn queue at 520 by 650, for a phone's narrow frame. */
function MusicNarrow({ running }: { running: boolean }) {
  const { t } = useTranslation();
  const elapsed = useSongClock(running);
  return (
    <div aria-hidden data-live={running} className="noite-music flex h-full w-full flex-col bg-ink text-[17px] text-paper">
      <div className="flex h-[64px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-6">
        <Mic className="h-5 w-5 text-signal" />
        {/* literal-ok: the voice channel's name, as in the footage */}
        <span className="font-semibold">Lobby</span>
        <span className="text-[14px] text-paper-muted">{t("home.night.mock.here", { n: LOBBY.length })}</span>
        <span className="ml-auto inline-flex items-center gap-2 rounded-full bg-signal/15 px-3 py-1 text-[14px] font-medium text-signal">
          <SoundBars className="text-signal" />
          {t("home.night.mock.playing")}
        </span>
      </div>
      <div className="flex items-center gap-5 px-6 pt-6">
        <AlbumArt className="h-[120px] w-[120px]" />
        <div className="min-w-0 flex-1">
          <ExampleTag />
          <p className="mt-2 truncate font-display text-[28px] font-bold leading-tight">{t(NOW_PLAYING.title)}</p>
          <p className="truncate text-[15px] text-paper-muted">
            {t(NOW_PLAYING.artist)} ·{" "}
            {rich(t("home.night.mock.requestedBy"), {
              who: <span className="text-violet-400">{NOW_PLAYING.by.name}</span>,
            })}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-3 px-6 pt-5">
        <span className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-white/10">
          <span
            className="absolute inset-0 origin-left rounded-full bg-signal transition-transform duration-1000 ease-linear motion-reduce:transition-none"
            style={{ transform: `scaleX(${elapsed / SONG_SECONDS})` }}
          />
        </span>
        <span className="text-[14px] tabular-nums text-paper-muted">
          {clock(elapsed)} / {clock(SONG_SECONDS)}
        </span>
      </div>
      <p className="flex items-center gap-2 px-6 pb-1 pt-6 text-[13px] font-semibold uppercase tracking-[0.14em] text-paper-muted">
        <ListMusic className="h-4 w-4" />
        {t("home.night.mock.upNext")}
        <span className="ml-auto inline-flex items-center gap-1.5 normal-case tracking-normal">
          <Lock className="h-3.5 w-3.5" />
          {t("home.night.mock.permission")}
        </span>
      </p>
      <ul className="px-3">
        {QUEUE.slice(0, 3).map((q, i) => (
          <li key={q.title} className="flex items-center gap-3 px-3 py-2.5">
            <span className="w-4 text-right text-[14px] tabular-nums text-paper-muted">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{t(q.title)}</span>
              <span className="block truncate text-[14px] text-paper-muted">
                {q.by.name} · {t(q.artist)}
              </span>
            </span>
            <span className="text-[14px] tabular-nums text-paper-muted">{q.length}</span>
          </li>
        ))}
      </ul>
      <div className="mx-6 mb-6 mt-auto flex h-12 items-center gap-2 rounded-xl border border-white/[0.08] bg-ink-2 px-4 text-[15px] text-paper-muted">
        <Search className="h-4 w-4 shrink-0" />
        {t("home.night.mock.search")}
      </div>
    </div>
  );
}
