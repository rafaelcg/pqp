import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { type MessageKey, useTranslation } from "@/lib/i18n";
import { playStoreUrl } from "@/lib/play-store";
import { cn } from "@/lib/utils";
import { JoinButton } from "./shared/auth-buttons";
import { PIN_MEDIA, Parallax, PhoneFrame, stillImg, useMediaQuery } from "./cinema";
import "./celular.css";
import { rich } from "./rich";
import { CARD, CONTAINER, CREATE_INTENT, Caption, H3, HEADER_GAP, Section, SectionHeader, useCta } from "./ui";

/**
 * #celular: the same app on a phone. Two real captures of the web client at
 * phone width (recorded in a 390 wide browser): the call in front, and the
 * channel list behind it, a little smaller and turned, rising faster as the
 * section passes (with reduced motion they simply sit there). The chat with
 * the poll and the dice is not here on purpose: it is Brinquedos' first tile.
 * On a phone the two become a row you swipe, the call first. Below them:
 * Android, the iPhone beta via TestFlight, the desktop app, and the browser
 * with nothing to install, as four plain cards (a name, a line, a link; no
 * icons, nothing reveals on scroll). The links are paper, not lime: lime is
 * for the page's primary buttons.
 *
 * Google Play is named only while `playStoreUrl()` answers a listing (the
 * code default, `lib/play-store.ts`). A self-host that blanks
 * `VITE_PLAY_STORE_URL` gets the APK wording in the lede and on the Android
 * card, the same switch the footer makes (`marketing-footer.tsx`). The card
 * links `/android` either way, because that page makes the same switch. The
 * iPhone card links `/beta` for every visitor, as the shipped landing did.
 */

const PHONES = [
  { name: "phone-call", alt: "home.phone.callAlt", speed: 0.05, front: true },
  { name: "phone-servers", alt: "home.phone.serversAlt", speed: 0.26, front: false },
] as const satisfies readonly { name: string; alt: MessageKey; speed: number; front: boolean }[];

/** How wide each capture is drawn (the frame's width less its bezel), for `sizes`. */
const SIZES = {
  front: "(min-width: 1024px) 334px, (min-width: 640px) 286px, 258px",
  back: "(min-width: 1024px) 246px, (min-width: 640px) 198px, 258px",
} as const;

const SM_MEDIA = "(min-width: 640px)";

export function Celular() {
  const { t } = useTranslation();
  const cta = useCta();
  const wide = useMediaQuery(PIN_MEDIA);
  const roomy = useMediaQuery(SM_MEDIA);
  // Read per render, not at import: a test can then switch the listing off.
  const hasPlay = Boolean(playStoreUrl());

  return (
    <Section id="celular" labelledBy="celular-title" className="overflow-x-clip">
      <div className={CONTAINER}>
        <SectionHeader
          layout="center"
          titleId="celular-title"
          title={rich(t("home.phone.title"), { accent: t("home.phone.titleAccent") })}
          lede={t(hasPlay ? "home.phone.lede.play" : "home.phone.lede")}
        />
      </div>

      {/* The phones. */}
      <div className={cn("relative", HEADER_GAP)}>
        {/*
          On a phone the row scrolls sideways and starts on the call: the side
          padding centres whichever phone is snapped. From sm the pair stands
          together, centred as one.
        */}
        <div
          tabIndex={roomy ? undefined : 0}
          role="group"
          aria-label={t("home.phone.rowLabel")}
          className="cel-row flex items-end gap-4 overflow-x-auto px-[calc(50%-8.5rem)] pb-10 pt-2 snap-x snap-mandatory focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:snap-none sm:justify-center sm:gap-0 sm:overflow-visible sm:px-0 sm:pb-0 sm:pt-0"
        >
          {PHONES.map((phone) => (
            <Parallax
              key={phone.name}
              speed={roomy ? (wide ? phone.speed : phone.speed * 0.5) : 0}
              className={cn(
                "relative w-[17rem] shrink-0 snap-center",
                phone.front
                  ? "z-10 sm:w-[19rem] lg:w-[22rem]"
                  : "z-0 sm:-ml-10 sm:w-[13.5rem] sm:pb-10 lg:-ml-16 lg:w-[16.5rem] lg:pb-16",
              )}
            >
              <PhoneFrame
                aspect="1170 / 2648"
                className={cn("bg-ink-3 ring-white/30", !phone.front && "sm:[rotate:3deg]")}
                screenClassName="bg-rail"
              >
                {/* The captures have no status bar: it gets its own band, under the camera. */}
                <img
                  {...stillImg(phone.name, t(phone.alt), phone.front ? SIZES.front : SIZES.back)}
                  loading="lazy"
                  decoding="async"
                  draggable={false}
                  className="absolute inset-x-0 bottom-0 h-auto w-full"
                />
                {!phone.front && <span aria-hidden className="absolute inset-0 z-[1] bg-ink/25" />}
              </PhoneFrame>
            </Parallax>
          ))}
        </div>
        <Caption example className="mt-10 justify-center px-5 text-center sm:mt-12">
          {t("home.phone.caption")}
        </Caption>
      </div>

      {/* Where it runs. */}
      <div className={cn(CONTAINER, "mt-16 sm:mt-20")}>
        <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <Platform
            name="Android"
            fact={t(hasPlay ? "home.phone.android.play" : "home.phone.android")}
            action={
              <PlatformLink to="/android">
                {t(hasPlay ? "home.phone.android.cta.play" : "home.phone.android.cta")}
              </PlatformLink>
            }
          />
          <Platform
            name="iPhone"
            badge={t("home.phone.ios.badge")}
            fact={t("home.phone.ios.fact")}
            action={<PlatformLink to="/beta">{t("home.phone.ios.cta")}</PlatformLink>}
          />
          <Platform
            name={t("home.phone.desktop.name")}
            fact={t("home.phone.desktop.fact")}
            action={<PlatformLink to="/download">{t("home.phone.desktop.cta")}</PlatformLink>}
          />
          <Platform
            name={t("home.phone.web.name")}
            fact={t("home.phone.web.fact")}
            action={
              <JoinButton intent={CREATE_INTENT} className={LINK}>
                <LinkLabel>{cta.create}</LinkLabel>
              </JoinButton>
            }
          />
        </ul>
      </div>
    </Section>
  );
}

/**
 * A link in a platform card: paper, with its arrow. Hovering or focusing the
 * link moves the arrow a little (transform only, 200 ms, ease-out); nothing
 * else changes colour.
 */
const LINK =
  "group/link inline-flex min-h-10 items-center rounded-full text-left text-[13px] font-semibold text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink-2 sm:text-sm";

/**
 * A link's words and its arrow. The arrow stays glued to the last word, so in
 * a narrow card the words wrap and the arrow never sits on a line alone.
 */
function LinkLabel({ children }: { children: string }) {
  const cut = children.lastIndexOf(" ") + 1;
  return (
    <span>
      {children.slice(0, cut)}
      <span className="whitespace-nowrap">
        {children.slice(cut)}
        <ArrowRight
          className="ml-1.5 inline h-3.5 w-3.5 align-[-2px] transition-transform duration-200 ease-out group-hover/link:translate-x-0.5 group-focus-visible/link:translate-x-0.5"
          aria-hidden
        />
      </span>
    </span>
  );
}

function PlatformLink({ to, children }: { to: string; children: string }) {
  return (
    <Link to={to} className={LINK}>
      <LinkLabel>{children}</LinkLabel>
    </Link>
  );
}

/** One place it runs: a name, one line, a link. No icon tile (the name says it). */
function Platform({
  name,
  badge,
  fact,
  action,
}: {
  name: string;
  badge?: string;
  fact: string;
  action: ReactNode;
}) {
  return (
    <li className={cn(CARD, "flex min-w-0 flex-col p-4 sm:p-6")}>
      <H3 className="flex flex-wrap items-center gap-x-2 gap-y-1 text-paper">
        {name}
        {badge && (
          <span className="rounded-full border border-white/15 px-2 py-px font-sans text-[10px] font-semibold uppercase tracking-wider text-paper-muted">
            {badge}
          </span>
        )}
      </H3>
      <p className="mt-1.5 text-sm leading-snug text-paper-muted text-pretty sm:text-[15px]">{fact}</p>
      <div className="mt-auto pt-4">{action}</div>
    </li>
  );
}
