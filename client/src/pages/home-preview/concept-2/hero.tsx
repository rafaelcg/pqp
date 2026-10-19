import { ArrowRight } from "lucide-react";
import { HeroDownload } from "@/components/marketing/hero-download";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { BTN, CONTAINER, Drift, Halftone, Stamp, Tape } from "./ui";

/**
 * The opening sheet. Nothing here waits for a scroll or an observer: the
 * headline, the line under it and both buttons are in the first paint. Only
 * the stamps thump in, and they are labels, not the message.
 */
export function Hero() {
  return (
    <section aria-label="Abertura" className="relative isolate overflow-hidden pb-14 pt-8 sm:pb-20 sm:pt-12 lg:pb-24 lg:pt-14">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10">
        <div className="c2-ghost absolute -left-12 top-20 h-72 w-56 -rotate-6 sm:h-[26rem] sm:w-72" />
        <div className="c2-ghost absolute right-[6%] top-[38%] hidden h-80 w-64 rotate-3 lg:block" />
        <div className="absolute -right-28 -top-10 h-[440px] w-[440px] overflow-hidden rounded-full text-signal/25 sm:-right-16 lg:right-[-4%] lg:top-8 lg:h-[560px] lg:w-[560px]">
          <Halftone cols={36} rows={36} shape="radial" max={4.8} />
        </div>
      </div>

      <div
        className={cn(
          CONTAINER,
          "relative [--hs:clamp(4.2rem,23.4vw,8.4rem)] sm:[--hs:clamp(5rem,min(13.5vw,19.5vh),12.2rem)]",
        )}
      >
        <ul className="mb-6 flex flex-wrap items-center gap-x-5 gap-y-3 sm:mb-8" aria-label="Em resumo">
          <li>
            <Stamp r={-4} className="text-[13px] text-signal sm:text-[15px]">
              Grátis
            </Stamp>
          </li>
          <li>
            <Stamp r={2} className="text-[13px] text-paper sm:text-[15px]">
              Código aberto
            </Stamp>
          </li>
          <li>
            <Stamp r={-2} className="text-[13px] text-signal sm:text-[15px]">
              Beta
            </Stamp>
          </li>
        </ul>

        <h1 className="font-brand uppercase leading-[0.84] tracking-[-0.035em] [font-size:var(--hs)]">
          <span className="block text-paper sm:inline">Bora</span>{" "}
          <span className="block text-paper sm:inline">pra</span>
          <span className="mt-[0.05em] block">
            <span className="inline-block -rotate-1 bg-signal px-[0.13em] pb-[0.03em] pt-[0.02em] text-ink">Call.</span>
          </span>
        </h1>

        <div className="mt-8 max-w-[34rem] sm:mt-10">
          <p className="text-lg leading-snug text-paper sm:text-xl">
            Voz, tela com som e filme em grupo. Grátis, código aberto, com servidor de voz em São Paulo.
          </p>
          <div className="mt-7 flex flex-wrap gap-x-5 gap-y-4">
            <JoinButton intent={CREATE_INTENT} className={BTN.lime}>
              Criar a sala da galera
              <ArrowRight className="h-4 w-4" aria-hidden />
            </JoinButton>
            <JoinButton intent={IMPORT_INTENT} className={BTN.line}>
              Trazer do Discord
            </JoinButton>
          </div>
          <p className="mt-5 text-sm text-paper-muted">Grátis, sem cartão. Entra com Google, Apple ou Twitch.</p>
          <HeroDownload tone="ink" className="mt-3" />
        </div>

        <figure className="relative mt-14 ml-auto w-[min(86%,440px)] rotate-[2.5deg] lg:absolute lg:right-0 lg:top-[calc(var(--hs)*0.84+6rem)] lg:mt-0 lg:w-[min(31vw,440px)]">
          <div className="c2-photo">
            <img
              src="/images/product/hero.webp"
              width={1920}
              height={1080}
              loading="lazy"
              decoding="async"
              alt="Captura real do pqp: a sala Mesa, com o chat, a lista de membros e o canal de voz Lobby com duas pessoas na call."
              className="block h-auto w-full"
            />
          </div>
          <Drift className="absolute -top-3 left-5" amp={10}>
            <Tape tone="light" w={86} r={-9} />
          </Drift>
          <Drift className="absolute -top-2 right-7" amp={-8}>
            <Tape tone="light" w={70} r={7} />
          </Drift>
          <figcaption className="absolute -bottom-4 left-3 -rotate-2 bg-paper px-2.5 py-1 font-display text-[11px] font-bold uppercase tracking-[0.12em] text-ink">
            Captura real do app
          </figcaption>
        </figure>
      </div>
    </section>
  );
}
