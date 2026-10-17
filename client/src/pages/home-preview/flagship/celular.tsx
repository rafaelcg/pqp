import { ArrowRight, Globe, Laptop, Smartphone } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { JoinButton } from "../shared/auth-buttons";
import { PIN_MEDIA, Parallax, PhoneFrame, Reveal, stillImg, useMediaQuery } from "./cinema";
import "./celular.css";
import {
  CARD,
  CONTAINER,
  CREATE_INTENT,
  CTA_CREATE,
  Caption,
  Glow,
  H3,
  HEADER_GAP,
  Hi,
  Section,
  SectionHeader,
} from "./ui";

/**
 * #celular: the same app on a phone. Two real captures of the web client at
 * phone width (recorded in a 390 wide browser): the call in front, and the
 * channel list behind it, a little smaller and turned, rising faster as the
 * section passes (with reduced motion they simply sit there). The chat with
 * the poll and the dice is not here on purpose: it is Brinquedos' first tile.
 * On a phone the two become a row you swipe, the call first. Below them:
 * Android on Google Play, the iPhone beta via TestFlight, the desktop app,
 * and the browser with nothing to install.
 */

const PHONES = [
  {
    name: "phone-call",
    alt: "O pqp no navegador do celular: o canal de voz Lobby com o chat da call, a barra com quem está na chamada e os controles. Gente de exemplo.",
    speed: 0.05,
    front: true,
  },
  {
    name: "phone-servers",
    alt: "O pqp no navegador do celular: a lista de canais do servidor A Mesa, com os canais de texto e os canais de voz. Gente de exemplo.",
    speed: 0.26,
    front: false,
  },
] as const;

/** How wide each capture is drawn (the frame's width less its bezel), for `sizes`. */
const SIZES = {
  front: "(min-width: 1024px) 334px, (min-width: 640px) 286px, 258px",
  back: "(min-width: 1024px) 246px, (min-width: 640px) 198px, 258px",
} as const;

const SM_MEDIA = "(min-width: 640px)";

export function Celular() {
  const wide = useMediaQuery(PIN_MEDIA);
  const roomy = useMediaQuery(SM_MEDIA);

  return (
    <Section id="celular" labelledBy="celular-title" className="isolate overflow-x-clip">
      {/*
        A slightly lifted band, so the page breathes between dark sections. The
        section is `isolate` so this and the Glow (both -z-10) paint over the
        page's own background instead of under it.
      */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-10 bg-gradient-to-b from-transparent via-ink-2/45 to-transparent"
      />

      <div className={CONTAINER}>
        <SectionHeader
          layout="center"
          eyebrow="No celular também"
          titleId="celular-title"
          title={
            <>
              A sala cabe no <Hi>bolso</Hi>.
            </>
          }
          lede="Android na Google Play, iPhone em beta, app pra computador. E no navegador, sem instalar nada."
        />
      </div>

      {/* The phones. */}
      <div className={cn("relative", HEADER_GAP)}>
        <Glow intensity="soft" className="left-1/2 top-[4%] -z-10 h-[88%] w-[min(60rem,150vw)] -translate-x-1/2" />
        {/*
          On a phone the row scrolls sideways and starts on the call: the side
          padding centres whichever phone is snapped. From sm the pair stands
          together, centred as one.
        */}
        <div
          tabIndex={roomy ? undefined : 0}
          role="group"
          aria-label="Telas do pqp no celular: a call e a lista de canais. Arrasta pro lado pra ver as duas."
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
                  {...stillImg(phone.name, phone.alt, phone.front ? SIZES.front : SIZES.back)}
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
          O pqp no navegador do celular, com gente de exemplo.
        </Caption>
      </div>

      {/* Where it runs. */}
      <div className={cn(CONTAINER, "mt-16 sm:mt-20")}>
        <Reveal as="ul" stagger className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:gap-4">
          <Platform
            icon={Smartphone}
            name="Android"
            fact="Na Google Play."
            action={<PlatformLink to="/android">Baixar na Google Play</PlatformLink>}
          />
          <Platform
            icon={Smartphone}
            name="iPhone"
            badge="beta"
            fact="Em beta, pelo TestFlight."
            action={<PlatformLink to="/beta">Entrar no beta</PlatformLink>}
          />
          <Platform
            icon={Laptop}
            name="Computador"
            fact="App pra Mac, Windows e Linux."
            action={<PlatformLink to="/download">Baixar o app</PlatformLink>}
          />
          <Platform
            icon={Globe}
            name="Navegador"
            fact="Nada pra instalar. Abre o pqp.gg e pronto."
            action={
              <JoinButton intent={CREATE_INTENT} className={cn(LINK, "text-signal")}>
                <LinkLabel>{CTA_CREATE}</LinkLabel>
              </JoinButton>
            }
          />
        </Reveal>
      </div>
    </Section>
  );
}

const LINK =
  "inline-flex min-h-10 items-center rounded-full text-left text-[13px] font-semibold sm:text-sm text-paper transition-colors hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink-2";

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
          className="ml-1.5 inline h-3.5 w-3.5 align-[-2px] transition-transform group-hover/plat:translate-x-0.5"
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

function Platform({
  icon: Icon,
  name,
  badge,
  fact,
  action,
}: {
  icon: typeof Globe;
  name: string;
  badge?: string;
  fact: string;
  action: ReactNode;
}) {
  return (
    <li className={cn(CARD, "group/plat flex min-w-0 flex-col p-4 transition-colors hover:border-white/[0.14] sm:p-6")}>
      <span className="grid h-10 w-10 place-items-center rounded-2xl bg-white/[0.05] text-paper ring-1 ring-inset ring-white/[0.08]">
        <Icon className="h-5 w-5" aria-hidden />
      </span>
      <H3 className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 text-paper sm:mt-5">
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
