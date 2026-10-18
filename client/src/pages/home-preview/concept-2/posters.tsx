import { ArrowRight, Check, Mic, MonitorUp, Popcorn } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { useInView } from "../shared/motion";
import { CONTAINER, Drift, Halftone, Kicker, LINK, Paste, Sheet, Stamp, Tape } from "./ui";

const SHOUTS = ["Voz", "Tela com som", "Filme em grupo", "Código aberto", "Grátis", "Sem cartão"];

/** A strip of caps between the opening and the posters. Pauses off screen. */
export function Ticker() {
  const [ref, inView] = useInView<HTMLDivElement>();
  const row = (
    <ul className="flex shrink-0 items-center" aria-hidden>
      {SHOUTS.map((s) => (
        <li key={s} className="flex items-center whitespace-nowrap font-brand text-2xl uppercase tracking-tight sm:text-4xl">
          <span className="px-5 sm:px-8">{s}</span>
          <span className="h-3 w-3 rotate-45 bg-ink sm:h-4 sm:w-4" />
        </li>
      ))}
    </ul>
  );
  return (
    <div ref={ref} className="relative z-10 -rotate-1 overflow-hidden bg-signal py-3 text-ink sm:py-4">
      <p className="sr-only">Voz, tela com som, filme em grupo. Código aberto, grátis e sem cartão.</p>
      <div className="c2-marquee flex w-max" data-run={inView}>
        {row}
        {row}
        {row}
        {row}
      </div>
    </div>
  );
}

function Point({ children }: { children: ReactNode }) {
  return (
    <li className="flex gap-2.5">
      <Check className="mt-1 h-4 w-4 shrink-0" strokeWidth={3} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

export function Posters() {
  return (
    <section id="cartazes" aria-labelledby="cartazes-h" className="relative scroll-mt-16 py-20 sm:py-28">
      <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-28 overflow-hidden text-signal/15">
        <Halftone cols={80} rows={8} shape="up" max={4.2} />
      </div>
      <div className={cn(CONTAINER, "relative")}>
        <Kicker className="text-signal">Em cartaz</Kicker>
        <h2 id="cartazes-h" className="mt-3 max-w-3xl font-display text-4xl font-extrabold leading-[1.02] tracking-tight sm:text-6xl">
          Três cartazes na parede. Tudo que a galera faz junto.
        </h2>

        <div className="mt-14 grid gap-14 sm:mt-20 lg:grid-cols-3 lg:items-start lg:gap-8">
          {/* VOZ */}
          <Paste r="-2deg" className="lg:mt-6">
            <Sheet tone="lime" crease className="px-6 pb-8 pt-9 sm:px-8">
              <Drift className="absolute -top-3 left-8" amp={10}>
                <Tape tone="light" w={92} r={-6} />
              </Drift>
              <Mic className="h-9 w-9" strokeWidth={2.5} aria-hidden />
              <p className="mt-4 font-brand text-[clamp(5.5rem,22vw,8.2rem)] uppercase leading-[0.82] tracking-[-0.04em] lg:text-[clamp(4.2rem,8vw,7.2rem)]">Voz</p>
              <h3 className="mt-5 font-display text-2xl font-extrabold leading-tight">Cai na call e fica o tempo que quiser.</h3>
              <ul className="mt-5 space-y-2.5 text-[15px] leading-snug">
                <Point>Aperta pra falar ou voz ativa, você escolhe.</Point>
                <Point>Volume e mudo por pessoa.</Point>
                <Point>Atualizou a página? A call costuma continuar de pé, na web e no desktop.</Point>
                <Point>Salas grandes passam por um servidor de voz em São Paulo, Miami ou Londres, o mais perto da maioria.</Point>
              </ul>
              <Drift className="absolute -bottom-5 -right-3 sm:-right-5" amp={-12}>
                <Stamp r={8} className="bg-signal text-[13px] text-ink">
                  Servidor em SP
                </Stamp>
              </Drift>
            </Sheet>
          </Paste>

          {/* TELA COM SOM */}
          <Paste r="1.5deg" delay={80}>
            <Sheet tone="paper" className="px-6 pb-8 pt-9 sm:px-8">
              <Drift className="absolute -top-3 right-10" amp={-10}>
                <Tape tone="lime" w={84} r={5} />
              </Drift>
              <MonitorUp className="h-9 w-9" strokeWidth={2.5} aria-hidden />
              <p className="mt-4 font-brand text-[clamp(3rem,10.6vw,5.2rem)] uppercase leading-[0.9] tracking-[-0.035em] lg:text-[clamp(2.4rem,4.2vw,3.8rem)]">
                <span className="block">Tela</span>
                <span className="mt-[0.06em] inline-block whitespace-nowrap bg-ink px-[0.12em] pb-[0.04em] pt-[0.02em] text-signal">com som</span>
              </p>
              <div className="c2-photo relative mt-6 -rotate-1 bg-ink/90">
                <img
                  src="/images/product/screen.webp"
                  width={1920}
                  height={1080}
                  loading="lazy"
                  decoding="async"
                  alt="Captura real do pqp: uma tela compartilhada na call, com o chat ao lado."
                  className="block h-auto w-full"
                />
              </div>
              <h3 className="mt-6 font-display text-2xl font-extrabold leading-tight">Passa a tela, o som vai junto.</h3>
              <ul className="mt-4 space-y-2.5 text-[15px] leading-snug">
                <Point>Várias telas ao mesmo tempo: duas em salas menores, até quatro nas grandes.</Point>
                <Point>De 360p a 1080p. Quem está no celular também assiste.</Point>
                <Point>O som vai quando você compartilha uma aba do Chrome ou do Edge. No app de desktop, o som do computador só vai no Windows 11.</Point>
              </ul>
            </Sheet>
          </Paste>

          {/* FILME EM GRUPO */}
          <Paste r="-1deg" delay={160} className="lg:mt-14">
            <Sheet tone="ink" className="px-6 pb-8 pt-9 sm:px-8">
              <Drift className="absolute -top-4 left-6" amp={12}>
                <Tape tone="light" w={96} r={-4} />
              </Drift>
              <div className="flex items-start justify-between gap-3">
                <Popcorn className="h-9 w-9 text-signal" strokeWidth={2.5} aria-hidden />
                <Stamp r={5} className="text-[12px] text-signal sm:text-[13px]">
                  Acesso antecipado
                </Stamp>
              </div>
              <p className="mt-4 font-brand text-[clamp(3.2rem,12.5vw,5.4rem)] uppercase leading-[0.92] tracking-[-0.035em] lg:text-[clamp(2.5rem,4.4vw,4rem)]">
                Filme <span className="text-signal">em grupo</span>
              </p>
              <div className="c2-photo relative mt-6 rotate-1">
                <img
                  src="/images/streamers/live-pt-BR.webp"
                  width={1440}
                  height={850}
                  loading="lazy"
                  decoding="async"
                  alt="Captura real de uma sessão de filme em grupo no pqp, com o vídeo no centro e a galera no chat."
                  className="block h-auto w-full"
                />
              </div>
              <h3 className="mt-6 font-display text-2xl font-extrabold leading-tight">Mais de 100 pessoas numa sala, em 5 de setembro de 2026.</h3>
              <p className="mt-3 text-[15px] leading-snug text-paper-muted">
                Todo mundo vendo o mesmo filme ao mesmo tempo. Ainda é acesso antecipado: a gente libera servidor por servidor.
              </p>
              <Link to="/watch-party" className={cn(LINK.ink, "mt-4")}>
                Entrar na lista
                <ArrowRight className="h-4 w-4" aria-hidden />
              </Link>
            </Sheet>
          </Paste>
        </div>

        <div className="mt-16 flex flex-wrap items-center gap-x-6 gap-y-3 text-sm text-paper-muted">
          <Link to="/vs-discord" className={cn(LINK.ink, "text-paper")}>
            Comparação completa com o Discord
            <ArrowRight className="h-4 w-4" aria-hidden />
          </Link>
          <span className="hidden h-4 w-px bg-paper/20 sm:block" aria-hidden />
          <span>Chat com threads, enquetes, GIFs e cargos também está no pacote.</span>
        </div>
      </div>
    </section>
  );
}
