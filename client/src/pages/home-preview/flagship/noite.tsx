import {
  ArrowRight,
  ArrowUpRight,
  Gauge,
  Hand,
  Keyboard,
  Layers,
  ListMusic,
  Lock,
  Mic,
  MonitorUp,
  Music2,
  Pause,
  PhoneOff,
  RefreshCw,
  Search,
  SkipForward,
  SlidersHorizontal,
  Smartphone,
  VideoOff,
  type LucideIcon,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { JoinButton } from "../shared/auth-buttons";
import { Avatar, CAST, SoundBars, type Person } from "../shared/mock";
import { useReducedMotion } from "../shared/motion";
import {
  BrowserFrame,
  Clip,
  type ClipFocus,
  type ClipSources,
  Magnetic,
  Reveal,
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
  CTA_CREATE,
  CTA_IMPORT,
  Caption,
  Chip,
  ExampleTag,
  Eyebrow,
  FreeLine,
  Glow,
  H3,
  HEADER_GAP,
  Hi,
  IMPORT_INTENT,
  Section,
  SectionHeader,
} from "./ui";

/**
 * "A noite": the flagship's centrepiece. One evening with the crew in four
 * hours (voice, a share with sound, a watch party, the music queue), and the
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
 */

type BeatId = "voz" | "tela" | "filme" | "musica";

interface Proof {
  icon: LucideIcon;
  text: ReactNode;
}

interface Beat {
  id: BeatId;
  time: string;
  label: string;
  /** One short word for the night's rail. */
  short: string;
  title: ReactNode;
  body: ReactNode;
  proofs: Proof[];
  /** What the picture shows, for screen readers. */
  sr: string;
  /** The honest line under the picture. */
  caption: string;
  /** Real footage or a drawing. */
  real: boolean;
}

const BEATS: Beat[] = [
  {
    id: "voz",
    time: "21:40",
    label: "Voz",
    short: "Voz",
    title: "Um entra, chama no grupo, e a call enche.",
    body: "É só entrar no canal de voz. Quem tá falando acende na tela, e cada um acerta o volume de cada amigo do jeito que prefere.",
    proofs: [
      { icon: Keyboard, text: "Push-to-talk ou ativação por voz" },
      { icon: SlidersHorizontal, text: "Volume e mudo por pessoa" },
      { icon: RefreshCw, text: "A call costuma sobreviver quando você recarrega a página, no navegador e no app de desktop" },
    ],
    sr: "Na imagem: o canal de voz Lobby do servidor A Mesa, com seis pessoas na call e um anel aceso em volta de quem tá falando.",
    caption: "O app de verdade, com gente de exemplo.",
    real: true,
  },
  {
    id: "tela",
    time: "22:10",
    label: "Tela com som",
    short: "Tela",
    title: "Passa a tela, o som vai junto.",
    body: "A Bia abre a arte nova da taverna e passa a tela. A galera vê na hora, no palco da call, e comenta no chat embaixo.",
    proofs: [
      { icon: Layers, text: "Mais de uma tela ao mesmo tempo: duas nas salas menores, até quatro nas grandes" },
      { icon: Gauge, text: "Qualidade de 360p a 1080p" },
      { icon: Smartphone, text: "Quem tá no celular assiste, e o app de Android também compartilha" },
    ],
    sr: "No vídeo: a Bia compartilha a tela no canal de voz sessao-de-sabado. A pintura de um terraço ao entardecer ocupa o palco da call, com o chat da call embaixo.",
    caption: "O app de verdade, com gente de exemplo.",
    real: true,
  },
  {
    id: "filme",
    time: "23:00",
    label: "Filme em grupo",
    short: "Filme",
    title: "Bota o filme e chama a galera toda.",
    body: "O canal de watch party segura a sala cheia: um passa o filme, todo mundo assiste junto e comenta no mesmo lugar.",
    proofs: [],
    sr: "Na imagem: o canal de watch party Sexta com a comunidade, ao vivo, com o filme no palco e o chat ao lado.",
    caption: "O app de verdade, com filme e gente de exemplo.",
    real: true,
  },
  {
    id: "musica",
    time: "00:30",
    label: "Fila de música",
    short: "Música",
    title: "Ninguém quer desligar. Solta a música.",
    body: "Cada um joga a sua na fila e todo mundo ouve a mesma música, ao mesmo tempo.",
    proofs: [
      { icon: ListMusic, text: "Fila compartilhada, sincronizada pra todo mundo na call" },
      { icon: Search, text: "Busca no YouTube ou cola o link" },
      { icon: Lock, text: "Quem tem permissão pula e pausa" },
    ],
    sr: "Na ilustração: a fila de música da call, com uma música tocando pra todo mundo e outras na fila, todas de exemplo.",
    caption: "Ilustração da fila de música, com gente e músicas de exemplo.",
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
const TELA_STILL = stillImg("share", BEATS[1].sr, FRAME_SIZES);

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
 * 23:00: a capture of a live watch party (1440 by 850), the channel "Sexta
 * com a comunidade" ao vivo, with the film on the stage and the chat beside
 * it. Not the share's painting, so the two hours never show one picture.
 */
const PARTY_IMG = {
  src: "/images/streamers/live-pt-BR.webp",
  srcSet: "/images/streamers/live-pt-BR-720.webp 720w, /images/streamers/live-pt-BR.webp 1440w",
  sizes: FRAME_SIZES,
  width: 1440,
  height: 850,
};

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

export function Noite() {
  // The pinned frame needs room: below xl the hours stack, side by side.
  const motion = usePinnedScenes();
  const wide = useMediaQuery("(min-width: 1280px)");
  // The stage is taller than a short window (a 720p laptop with its browser chrome).
  const tall = useMediaQuery("(min-height: 640px)");
  const pinned = motion && wide && tall;
  return (
    <Section id="noite" labelledBy="noite-title" divider={false}>
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow="Uma noite com a galera"
          titleId="noite-title"
          title={
            <>
              Do papo ao filme sem <Hi>trocar de app</Hi>.
            </>
          }
          lede="A noite começa com dois falando e termina na fila de música, de madrugada. Tudo no mesmo lugar, no navegador ou no app."
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
      {/* The one light of the section: low, behind the frame. */}
      <Glow intensity="soft" className="right-[-10%] top-1/2 h-[80vh] w-[70vw] -translate-y-1/2" />
      {/* The left edge is the page's own (a 1200px container with 2rem of padding); only the right bleeds.
          The words' column holds "Ninguém quer desligar." on one line at the H3's size. */}
      <div className="relative grid w-full grid-cols-[5rem_minmax(0,21rem)_minmax(0,1fr)] items-center gap-x-8 pb-0 pl-[max(2rem,calc((100%_-_1200px)/2_+_2rem))] pr-8 pt-20 2xl:grid-cols-[5rem_minmax(0,22rem)_minmax(0,1fr)] 2xl:gap-x-10">
        <NightRail active={active} near={near} onPick={pick} />

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
                {beat.caption}
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

/** The night's clock: four hours on a vertical rail that fills as you scroll. */
function NightRail({ active, near, onPick }: { active: number; near: boolean; onPick: (i: number) => void }) {
  return (
    <div role="group" aria-label="As horas da noite" className="relative h-[min(27rem,52svh)] self-center">
      {/* Track and fill: the fill reaches each hour as its stretch begins. */}
      <span aria-hidden className="absolute bottom-[7px] left-[5px] top-[7px] w-px bg-white/[0.09]" />
      <span
        aria-hidden
        className="absolute bottom-[7px] left-[5px] top-[7px] w-px origin-top bg-gradient-to-b from-signal/40 to-signal"
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
                aria-label={`${beat.time}, ${beat.label}`}
                className="group -m-2 flex items-start gap-3 rounded-lg p-2 pr-5 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                <span aria-hidden className="relative mt-[3px] grid h-[11px] w-[11px] shrink-0 place-items-center">
                  {on && near && <span className="noite-ping absolute inset-0 rounded-full bg-signal" />}
                  <span
                    className={cn(
                      "relative h-[11px] w-[11px] rounded-full border transition-colors duration-500",
                      on && "border-signal bg-signal",
                      past && "border-signal/60 bg-ink",
                      !on && !past && "border-white/25 bg-ink group-hover:border-white/50",
                    )}
                  />
                </span>
                <span aria-hidden className="block">
                  <span
                    className={cn(
                      "block origin-left font-mono text-[13px] tabular-nums leading-none transition-[transform,color] duration-500",
                      on ? "scale-[1.3] text-signal" : "text-paper-muted group-hover:text-paper",
                    )}
                  >
                    {beat.time}
                  </span>
                  <span
                    className={cn(
                      "mt-2.5 block whitespace-nowrap text-[13px] leading-tight transition-colors duration-500",
                      on ? "text-paper" : "text-paper-muted group-hover:text-paper",
                    )}
                  >
                    {beat.short}
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
  return (
    <div className={cn(CONTAINER, "relative", HEADER_GAP)}>
      {/* The one light of the section, behind the first hour's picture. */}
      <Glow
        intensity="soft"
        className="-right-48 top-24 h-[520px] w-[520px] lg:-right-24 lg:top-0 lg:h-[680px] lg:w-[680px]"
      />
      <ol className="relative flex flex-col gap-24 sm:gap-28 lg:gap-36">
        {BEATS.map((beat, i) => (
          <li key={beat.id} className="noite-hour" data-flip={i % 2 === 1 ? "" : undefined}>
            <Reveal className="[grid-area:head]">
              <BeatHead beat={beat} />
            </Reveal>
            <Reveal variant="scale" as="figure" className="relative m-0 mt-7 [grid-area:media] lg:mt-0 lg:self-center">
              <BrowserFrame>
                <StackedPicture id={beat.id} />
              </BrowserFrame>
              {/* The tag keeps its line and the words wrap beside it, even at 360. */}
              <Caption example as="figcaption" className="flex-nowrap items-start">
                {beat.caption}
              </Caption>
            </Reveal>
            <Reveal className="mt-8 [grid-area:body] lg:mt-4">
              <BeatBody beat={beat} />
            </Reveal>
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
  return (
    <div className={cn(CONTAINER, pinned ? "mt-4" : "mt-24 sm:mt-28 lg:mt-36")}>
      <Reveal
        stagger
        className="flex flex-col items-start gap-8 lg:grid lg:grid-cols-12 lg:items-end lg:gap-12"
      >
        <H3 size="lg" className="max-w-[16ch] lg:col-span-6">
          A próxima noite é na sala de vocês.
        </H3>
        <div id={NOITE_CTAS_ID} className="w-full lg:col-span-6 lg:justify-self-end">
          <div className="flex w-full flex-col gap-3 sm:w-auto sm:flex-row lg:justify-end">
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
          <FreeLine className="mt-3 text-sm text-paper-muted text-pretty lg:text-right" />
        </div>
      </Reveal>
    </div>
  );
}

/* ------------------------------------------------------------------------ */
/* The words of one hour                                                     */
/* ------------------------------------------------------------------------ */

type Piece = (k: number) => CSSProperties | undefined;

/**
 * The hour's label and heading. Pinned, the rail already shows the time, so
 * the label goes without its clock.
 */
function BeatHead({ beat, pinned = false, piece }: { beat: Beat; pinned?: boolean; piece?: Piece }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-3" style={piece?.(0)}>
        <Eyebrow tone="muted" time={pinned ? undefined : beat.time}>
          {beat.label}
        </Eyebrow>
        {beat.id === "filme" && (
          <Chip className="py-0.5">
            <span className="h-1.5 w-1.5 rounded-full bg-signal" aria-hidden />
            acesso antecipado
          </Chip>
        )}
      </div>
      {/* Pinned, the heading is where a pick on the rail leaves focus. */}
      <div
        className="mt-5 outline-none"
        style={piece?.(1)}
        tabIndex={pinned ? -1 : undefined}
        data-hour-head={pinned ? "" : undefined}
      >
        <H3 size="lg" className="max-w-[22ch]">
          {beat.title}
        </H3>
      </div>
    </>
  );
}

/** The rest of the hour's words: the body, its proofs and its notes. */
function BeatBody({ beat, piece }: { beat: Beat; piece?: Piece }) {
  return (
    <>
      <p className="max-w-md text-[17px] leading-relaxed text-paper-muted text-pretty" style={piece?.(2)}>
        {beat.body}
      </p>
      <p className="sr-only">{beat.sr}</p>

      {beat.proofs.length > 0 && (
        <ul
          className="mt-6 max-w-md divide-y divide-white/[0.06] border-y border-white/[0.06]"
          style={piece?.(3)}
        >
          {beat.proofs.map((p, j) => (
            <li key={j} className="flex items-start gap-3 py-2.5 text-[15px] leading-snug text-paper">
              <span className="mt-px grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-white/[0.05] text-paper-muted">
                <p.icon className="h-3.5 w-3.5" aria-hidden />
              </span>
              <span className="pt-1">{p.text}</span>
            </li>
          ))}
        </ul>
      )}

      {beat.id === "tela" && (
        <p className="mt-4 max-w-md text-[13px] leading-relaxed text-paper-muted" style={piece?.(4)}>
          O som vai junto ao compartilhar uma aba do Chrome ou do Edge. No app de desktop, o som do
          computador vai no Windows 11 (Mac, Linux e Windows 10 mandam só a imagem).
        </p>
      )}

      {beat.id === "filme" && (
        <>
          <div className={cn(CARD, "mt-7 flex max-w-md items-center gap-5 p-5")} style={piece?.(3)}>
            {/* Smaller than the H2 at every width: the H2 holds its 2.1rem floor up to about 760px and passes 44px only past 1000px. */}
            <span className="font-brand text-[32px] leading-none text-paper xl:text-[44px]">100+</span>
            <p className="text-sm leading-snug text-paper-muted text-pretty">
              Mais de 100 pessoas assistiram juntas numa sala em 5 de setembro de 2026.
            </p>
          </div>
          <p className="mt-5 max-w-md text-sm leading-relaxed text-paper-muted" style={piece?.(4)}>
            A watch party tá em acesso antecipado e chega servidor por servidor.
            <Link
              to="/watch-party"
              className="mt-1 flex min-h-10 w-fit items-center gap-1 font-medium text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-signal focus-visible:rounded focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Entrar na lista
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
  const t = localProgress(index);
  // Looping motion inside a drawing runs only for the hour on screen, near the viewport.
  const running = playing && near;
  // The voice room and the watch party share one slow push in.
  if (id === "voz") return <VoiceRoom zoom={mix("1", "1.1", t)} />;
  if (id === "tela") {
    return (
      <Camera cam={`scale(${mix("1.16", "1.02", t)})`} origin="42% 34%">
        {live ? (
          <Clip
            src={TELA_SOURCES}
            fallbackStill={TELA_STILL}
            label={BEATS[1].sr}
            className="absolute inset-0"
            controlsClassName={CLIP_CONTROL}
          />
        ) : (
          <RestFrame still={TELA_STILL} />
        )}
      </Camera>
    );
  }
  if (id === "filme") return <WatchParty zoom={mix("1", "1.14", t)} />;
  return <MusicQueue running={running} />;
});

/** Stacked: each hour's picture, framed for a narrow screen below md. */
function StackedPicture({ id }: { id: BeatId }) {
  if (id === "voz") {
    return (
      <div className="relative aspect-square md:aspect-[16/10]">
        <VoiceRoom />
      </div>
    );
  }
  if (id === "tela") {
    return (
      <Clip
        src={TELA_SOURCES}
        fallbackStill={TELA_STILL}
        label={BEATS[1].sr}
        aspect="3 / 2"
        focus={TELA_FOCUS}
        className="md:aspect-[16/10]!"
        controlsClassName={CLIP_CONTROL}
      />
    );
  }
  if (id === "filme") {
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
  return (
    <div aria-hidden className="noite-party absolute inset-0 overflow-hidden bg-ink-2">
      <img
        {...PARTY_IMG}
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

const NOW_PLAYING = { title: "Laje às Onze", artist: "Os Vizinhos", by: CAST.nico };

const QUEUE: { title: string; artist: string; by: Person; length: string }[] = [
  { title: "Último Ônibus", artist: "Maré Baixa", by: CAST.bia, length: "3:12" },
  { title: "Pão de Queijo Frio", artist: "Trio Sereno", by: CAST.caio, length: "4:05" },
  { title: "Volta pra Call", artist: "Os Primos da Duda", by: CAST.duda, length: "2:47" },
  { title: "Fim de Feira", artist: "Banda do Prédio", by: CAST.leo, length: "3:30" },
];

const LOBBY = [CAST.rafa, CAST.bia, CAST.caio, CAST.nico, CAST.duda, CAST.leo];

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
  const elapsed = useSongClock(running);
  return (
    <div aria-hidden data-live={running} className="noite-music flex h-full w-full bg-ink text-[15px] text-paper">
      {/* Main: what is playing, and the call bar. */}
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-[56px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-6">
          <Mic className="h-4 w-4 text-signal" />
          <div className="leading-tight">
            <p className="font-semibold">Lobby</p>
            <p className="text-[12px] text-paper-muted">6 aqui</p>
          </div>
          <span className="ml-auto inline-flex items-center gap-2 rounded-full bg-signal/15 px-3 py-1 text-[12px] font-medium text-signal">
            <SoundBars className="text-signal" />
            tocando pra todo mundo
          </span>
        </div>

        <div className="flex min-h-0 flex-1 items-center gap-6 px-8">
          <span className="relative grid h-[128px] w-[128px] shrink-0 place-items-center overflow-hidden rounded-2xl bg-gradient-to-br from-amber-300/80 via-rose-500/60 to-violet-700/70">
            <span className="h-9 w-9 rounded-full bg-ink/80 ring-[6px] ring-black/20" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-paper-muted">Tocando agora</p>
            <p className="mt-2 flex items-center gap-3">
              <span className="truncate font-display text-[34px] font-bold leading-none tracking-tight">
                {NOW_PLAYING.title}
              </span>
              <ExampleTag className="shrink-0" />
            </p>
            <p className="mt-2 flex items-center gap-2 text-[14px] text-paper-muted">
              {NOW_PLAYING.artist}
              <span className="text-paper-muted/50">·</span>
              pedida pelo
              <Avatar person={NOW_PLAYING.by} size={20} />
              <span className="font-semibold text-violet-400">{NOW_PLAYING.by.name}</span>
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
                pular e pausar: quem tem permissão
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
          Na fila · {QUEUE.length}
        </p>
        <ul className="flex-1 space-y-1 px-3 py-3">
          {QUEUE.map((q, i) => (
            <li
              key={q.title}
              className={cn("flex items-center gap-3.5 rounded-xl px-3.5 py-[18px]", i === 0 && "bg-white/[0.05]")}
            >
              <span className="w-4 text-right text-[15px] tabular-nums text-paper-muted">{i + 1}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[18px] font-semibold leading-tight">{q.title}</span>
                <span className="mt-1.5 flex items-center gap-2 truncate text-[14px] text-paper-muted">
                  <Avatar person={q.by} size={20} />
                  {q.by.name} · {q.artist}
                </span>
              </span>
              <span className="text-[14px] tabular-nums text-paper-muted">{q.length}</span>
            </li>
          ))}
        </ul>
        <div className="m-4 mt-0 flex h-12 items-center gap-2.5 rounded-xl border border-white/[0.08] bg-ink px-4 text-[14px] text-paper-muted">
          <Search className="h-4 w-4 shrink-0" />
          Busca no YouTube ou cola um link
        </div>
      </div>
    </div>
  );
}

/** The call bar at the foot of the real app, with the music note lit. */
function CallBar() {
  const btn = "grid h-10 w-10 place-items-center rounded-full text-paper";
  return (
    <div className="m-4 mt-0 shrink-0 rounded-2xl border border-white/[0.07] bg-ink-2/70">
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex -space-x-2">
          {LOBBY.slice(0, 3).map((p) => (
            <Avatar key={p.name} person={p} size={30} accent className="ring-2 ring-ink-2" />
          ))}
        </span>
        <span className="text-[14px]">6 na chamada</span>
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
  const elapsed = useSongClock(running);
  return (
    <div aria-hidden data-live={running} className="noite-music flex h-full w-full flex-col bg-ink text-[17px] text-paper">
      <div className="flex h-[64px] shrink-0 items-center gap-3 border-b border-white/[0.06] px-6">
        <Mic className="h-5 w-5 text-signal" />
        <span className="font-semibold">Lobby</span>
        <span className="text-[14px] text-paper-muted">6 aqui</span>
        <span className="ml-auto inline-flex items-center gap-2 rounded-full bg-signal/15 px-3 py-1 text-[14px] font-medium text-signal">
          <SoundBars className="text-signal" />
          tocando
        </span>
      </div>
      <div className="flex items-center gap-5 px-6 pt-6">
        <span className="grid h-[120px] w-[120px] shrink-0 place-items-center rounded-2xl bg-gradient-to-br from-amber-300/80 via-rose-500/60 to-violet-700/70">
          <span className="h-10 w-10 rounded-full bg-ink/80 ring-[6px] ring-black/20" />
        </span>
        <div className="min-w-0 flex-1">
          <ExampleTag />
          <p className="mt-2 truncate font-display text-[28px] font-bold leading-tight">{NOW_PLAYING.title}</p>
          <p className="truncate text-[15px] text-paper-muted">
            {NOW_PLAYING.artist} · pedida pelo <span className="text-violet-400">{NOW_PLAYING.by.name}</span>
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
        Na fila
        <span className="ml-auto inline-flex items-center gap-1.5 normal-case tracking-normal">
          <Lock className="h-3.5 w-3.5" />
          pular e pausar: quem tem permissão
        </span>
      </p>
      <ul className="px-3">
        {QUEUE.slice(0, 3).map((q, i) => (
          <li key={q.title} className="flex items-center gap-3 px-3 py-2.5">
            <span className="w-4 text-right text-[14px] tabular-nums text-paper-muted">{i + 1}</span>
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{q.title}</span>
              <span className="block truncate text-[14px] text-paper-muted">
                {q.by.name} · {q.artist}
              </span>
            </span>
            <span className="text-[14px] tabular-nums text-paper-muted">{q.length}</span>
          </li>
        ))}
      </ul>
      <div className="mx-6 mb-6 mt-auto flex h-12 items-center gap-2 rounded-xl border border-white/[0.08] bg-ink-2 px-4 text-[15px] text-paper-muted">
        <Search className="h-4 w-4 shrink-0" />
        Busca no YouTube ou cola um link
      </div>
    </div>
  );
}
