import { ArrowRight, Volume2 } from "lucide-react";
import { type CSSProperties, useRef, useState } from "react";
import { HeroDownload } from "@/components/marketing/hero-download";
import { isDesktopApp } from "@/lib/desktop";
import { detectPlatform, readPlatformSignals } from "@/lib/downloads";
import { useTranslation } from "@/lib/i18n";
import { intlLocale } from "@/lib/locale";
import { cn } from "@/lib/utils";
import { JoinButton } from "./shared/auth-buttons";
import { Avatar, CAST } from "./shared/mock";
import { Reveal, mix, useSceneProgress } from "./cinema";
import { rich } from "./rich";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CONTAINER,
  CREATE_INTENT,
  ExampleTag,
  FreeLine,
  Hi,
  IMPORT_INTENT,
  Section,
  SectionHeader,
  useCta,
} from "./ui";

/**
 * The book-end to the hero. The hero opens on the painted rooftop at dusk as
 * a sky fading down; the closer brings the same rooftop up from the bottom,
 * at 02:14, with a few of the crew still in the call. Then the same two doors
 * as the top of the page.
 *
 * One motion: as the section arrives, the painting eases back from a slight
 * zoom to its full frame and the rooftop's lights come up (an ink veil over
 * the lower half thins out). The band behind the copy stays dark the whole
 * time, so the text keeps its contrast. Progress is measured on the backdrop
 * layer, which covers the section exactly and which nothing transforms.
 * Reduced motion shows the settled, lit scene.
 *
 * This is the one place the page spends lime on a headline ("Chama a
 * galera.", in the brand face). Everything else here is still: no glow, no
 * magnetic buttons, and the copy and the buttons are simply there. Only the
 * sample call's pill arrives, since it is a figure.
 */

const STILL_HERE = [CAST.bia, CAST.caio, CAST.nico];

/** The sample call's channel: a name somebody typed, the same in every language. */
const STILL_HERE_CHANNEL = "Lobby"; // literal-ok: a sample channel name, not copy

/** Beats of the arrival: 0 when the section enters, 1 when its centre reaches the screen's. */
const FIM_RANGES = {
  zoom: [0, 1, "out"],
  lights: [0.3, 1, "inOut"],
} as const;

export function Fim() {
  const { t, locale } = useTranslation();
  const cta = useCta();
  const stillHere = new Intl.ListFormat(locale === "en" ? "en-US" : intlLocale(locale), {
    type: "conjunction",
  }).format(STILL_HERE.map((person) => person.name));
  const ref = useRef<HTMLDivElement>(null);
  useSceneProgress(ref, { mode: "enter", ranges: FIM_RANGES });

  return (
    <Section id="fim" labelledBy="fim-title" divider={false} className="isolate overflow-hidden">
      {/* The backdrop: the same box as the section, so the arrival is measured on it. */}
      <div ref={ref} aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <Rooftop />
        <div className="hp-grain absolute inset-0 opacity-50 [mask-image:linear-gradient(to_bottom,transparent,black_40%)]" />
      </div>

      <div className={cn(CONTAINER, "relative flex flex-col items-center text-center")}>
        <SectionHeader
          layout="center"
          eyebrow={t("home.end.eyebrow")}
          time="02:14"
          titleId="fim-title"
          title={
            <>
              <span className="block font-display text-[clamp(1.75rem,3.6vw,3rem)] font-bold leading-tight tracking-[-0.02em] text-paper-muted">
                {t("home.end.titleLead")}
              </span>
              <span className="mt-1 block font-brand text-[clamp(3.1rem,8.2vw,7.5rem)] leading-[0.95] tracking-[-0.02em]">
                {rich(t("home.end.title"), { accent: <Hi>{t("home.end.titleAccent")}</Hi> })}
              </span>
            </>
          }
          titleClassName="mt-8"
          lede={t("home.end.lede")}
          ledeClassName="mt-7 max-w-md"
          className="w-full max-w-none"
        />

        <div className="flex w-full flex-col items-center">
          <div className="mt-9 flex w-full flex-col gap-3 sm:w-auto sm:flex-row sm:items-center">
            <JoinButton intent={CREATE_INTENT} className={cn(BTN_PRIMARY, "w-full sm:w-auto")}>
              {cta.create}
              <ArrowRight className="h-4 w-4" aria-hidden />
            </JoinButton>
            <JoinButton
              intent={IMPORT_INTENT}
              className={cn(BTN_SECONDARY, "w-full bg-ink/40 backdrop-blur-sm sm:w-auto")}
            >
              {cta.importDiscord}
            </JoinButton>
          </div>

          <SmallPrint />
        </div>

        {/* Who is still up. A sample call, labelled as one. Its bottom margin
            is the room left for the rooftop, less the section's own padding. */}
        <Reveal
          variant="scale"
          delay={250}
          className="mb-[calc(clamp(16rem,38vw,27rem)_-_6rem)] mt-14 flex flex-col items-center gap-2.5 sm:mb-[calc(clamp(16rem,38vw,27rem)_-_8rem)]"
        >
          <p className="sr-only">
            {t("home.end.stillHere.sr", { names: stillHere, channel: STILL_HERE_CHANNEL })}
          </p>
          <div
            aria-hidden
            className="inline-flex items-center gap-3 rounded-full border border-white/10 bg-ink/70 py-1.5 pl-1.5 pr-4 text-sm shadow-[0_20px_60px_-20px_black] backdrop-blur-md"
          >
            <span className="flex -space-x-1">
              {STILL_HERE.map((person) => (
                <Avatar key={person.name} person={person} size={28} accent className="ring-2 ring-ink" />
              ))}
            </span>
            <span className="flex items-center gap-1.5 text-signal">
              <Volume2 className="h-3.5 w-3.5" />
              <span className="font-medium">{STILL_HERE_CHANNEL}</span>
            </span>
            <span className="text-paper-muted">{t("home.end.stillHere.count")}</span>
          </div>
          <ExampleTag className="bg-ink/50" />
        </Reveal>
      </div>
    </Section>
  );
}

/**
 * The line under the CTAs and the download, in a box whose height does not
 * move. On a Mac the download first offers both chips with a note (63px with
 * a mouse, 84px with touch) and settles on one link (23px or 44px) once
 * Chromium names the chip. So on a Mac an invisible copy of the tallest state
 * shares the grid cell and holds the box at that height, and the settled lines
 * sit in its middle. A phone's Play badge or TestFlight pill never changes, so
 * it gets no reserve.
 */
function SmallPrint() {
  const [mac] = useState(
    () => typeof navigator !== "undefined" && !isDesktopApp() && detectPlatform(readPlatformSignals()) === "mac",
  );
  return (
    <div className="mt-4 grid max-w-full grid-cols-[minmax(0,1fr)] rounded-2xl bg-ink/55 px-4 py-2.5 backdrop-blur-[2px]">
      {mac && (
        <div aria-hidden className="invisible col-start-1 row-start-1 flex flex-col items-center gap-3">
          <FreeLine className="text-sm text-balance" />
          <div className="h-16 w-96 max-w-full [@media(pointer:coarse)]:h-[5.25rem]" />
        </div>
      )}
      <div className="col-start-1 row-start-1 flex flex-col items-center gap-3 self-center">
        <FreeLine className="text-sm text-paper-muted text-balance" />
        <HeroDownload tone="ink" className="text-center [&_p]:mx-auto" />
      </div>
    </div>
  );
}

/**
 * The painted rooftop, rising from the bottom of the page. The picture eases
 * back from a slight zoom; an ink veil over the lower half thins as it does,
 * so the lights come up. Above it, a fixed ink band keeps the copy readable.
 */
function Rooftop() {
  const zoom: CSSProperties = {
    transform: `scale(${mix("1.08", "1", "var(--p-zoom, 1)")})`,
    transformOrigin: "50% 78%",
  };
  return (
    <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 -z-10 h-[60%] overflow-hidden sm:h-[90%]">
      <div className="absolute inset-0 will-change-transform" style={zoom}>
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
            loading="lazy"
            decoding="async"
            className="h-full w-full object-cover object-[50%_82%] [mask-image:linear-gradient(to_top,black_0%,black_48%,transparent_92%)]"
          />
        </picture>
      </div>
      {/* The night: a veil over the rooftop that thins as you arrive. */}
      <div
        className="absolute inset-0 bg-ink [mask-image:linear-gradient(to_top,black_0%,black_55%,transparent_100%)]"
        style={{ opacity: mix("0.7", "0.26", "var(--p-lights, 1)") }}
      />
      {/* The band behind the copy: dark from the start, dark at the end. */}
      <div className="absolute inset-x-0 top-0 h-[45%] bg-gradient-to-b from-ink via-ink/80 to-transparent sm:h-[62%]" />
      <div className="absolute inset-x-0 bottom-0 h-32 bg-gradient-to-t from-ink to-transparent" />
    </div>
  );
}
