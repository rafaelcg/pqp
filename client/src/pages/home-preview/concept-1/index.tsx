import { ArrowRight } from "lucide-react";
import type { CSSProperties } from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BetaTag } from "@/components/ui/beta-tag";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton, SignInButton } from "../shared/auth-buttons";
import "../shared/mock.css";
import { MoveStage } from "./move-stage";
import { Codigo, Junto, Limites, Tela, Voz } from "./sections";
import { BTN_PRIMARY, BTN_SECONDARY, CONTAINER, H2, Hi, Lede, Reveal } from "./ui";

/**
 * Concept 1, "Mudança de casa". The move is the whole story: a server comes
 * over from Discord with its structure intact, and the page is honest about
 * what stays behind. Plain text, hairline rules, grey on the left (where it
 * was), ink and lime on the right (where it is going).
 */
export default function MudancaDeCasa() {
  return (
    <div className="min-h-screen overflow-x-clip bg-ink text-paper">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-full focus:bg-paper focus:px-5 focus:py-3 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Pular pro conteúdo
      </a>
      <Nav />
      <main id="conteudo" tabIndex={-1} className="outline-none">
        <Hero />
        <Junto />
        <Tela />
        <Voz />
        <Limites />
        <Codigo />
        <Closer />
      </main>
      <MarketingFooter />
    </div>
  );
}

const NAV_LINKS = [
  { href: "#junto", label: "Vem junto" },
  { href: "#tela", label: "Tela e filme" },
  { href: "#voz", label: "Voz" },
  { href: "#limites", label: "O que falta" },
  { href: "#codigo", label: "Código aberto" },
];

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-ink/85 backdrop-blur-xl">
      <div className={cn(CONTAINER, "flex h-16 items-center gap-6")}>
        <Link to="/preview/home/c1" className="flex items-center gap-2 font-brand text-xl tracking-tight">
          pqp
          <BetaTag />
        </Link>
        <nav aria-label="Seções" className="hidden min-w-0 items-center gap-1 text-sm text-paper-muted lg:flex">
          {NAV_LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="inline-flex h-10 items-center whitespace-nowrap rounded-full px-3 transition-colors hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-2">
          <SignInButton className="hidden h-10 items-center rounded-full px-3 text-sm font-medium text-paper-muted transition-colors hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:inline-flex" />
          <JoinButton className="inline-flex h-10 items-center gap-1.5 rounded-full bg-paper px-5 text-sm font-semibold text-ink transition-colors hover:bg-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal focus-visible:ring-offset-2 focus-visible:ring-offset-ink">
            Começar
          </JoinButton>
        </div>
      </div>
    </header>
  );
}

function stagger(i: number): CSSProperties {
  return { "--stagger": i } as CSSProperties;
}

function Hero() {
  return (
    <section className="relative isolate overflow-hidden">
      <div aria-hidden className="mv-plan pointer-events-none absolute inset-0 -z-10" />
      <div
        className={cn(
          CONTAINER,
          "grid gap-14 pb-16 pt-12 sm:pt-16 lg:grid-cols-12 lg:items-center lg:gap-10 lg:pb-24 lg:pt-14",
        )}
      >
        <div className="lg:col-span-5">
          <p
            className="animate-rise flex items-center gap-3 text-[11px] font-semibold uppercase tracking-[0.22em] text-paper-muted"
            style={stagger(0)}
          >
            <span aria-hidden className="h-px w-8 bg-signal" />
            Mudança de casa
          </p>
          <h1
            className="animate-rise mt-6 font-display text-[clamp(2.5rem,4.5vw,4.4rem)] font-bold leading-[1] tracking-[-0.03em] text-balance"
            style={stagger(1)}
          >
            Seu servidor do Discord, <Hi>com tudo no lugar.</Hi>
          </h1>
          <p
            className="animate-rise mt-6 max-w-lg text-lg leading-relaxed text-paper-muted text-pretty sm:text-xl"
            style={stagger(2)}
          >
            Cola o link do modelo e a estrutura inteira vem junto: categorias, canais e cargos. O histórico de mensagens
            fica lá.
          </p>
          <div className="animate-rise mt-9 flex flex-col gap-3 sm:flex-row" style={stagger(3)}>
            <JoinButton intent={IMPORT_INTENT} className={BTN_PRIMARY}>
              Trazer meu servidor
              <ArrowRight className="h-4 w-4" aria-hidden />
            </JoinButton>
            <JoinButton intent={CREATE_INTENT} className={BTN_SECONDARY}>
              Criar um do zero
            </JoinButton>
          </div>
          <p className="animate-rise mt-4 text-sm text-paper-muted" style={stagger(4)}>
            Grátis, sem cartão. Entra com Google, Apple ou Twitch.
          </p>
          <HeroDownload tone="ink" className="animate-rise mt-3" style={stagger(5)} />
        </div>

        <div className="animate-rise lg:col-span-7" style={stagger(3)}>
          <MoveStage className="mx-auto w-full max-w-[640px]" />
        </div>
      </div>
    </section>
  );
}

function Closer() {
  return (
    <section aria-labelledby="fim-t" className="relative isolate overflow-hidden border-t border-white/10">
      <div aria-hidden className="mv-plan pointer-events-none absolute inset-0 -z-10 opacity-60" />
      <div className={cn(CONTAINER, "py-24 sm:py-32")}>
        <Reveal>
          <H2 id="fim-t" className="max-w-4xl text-[clamp(2.2rem,5vw,4rem)] leading-[1.02]">
            Mudar de casa sem <Hi>refazer a casa inteira.</Hi>
          </H2>
          <Lede className="max-w-xl">
            Cola o link do modelo, confere a prévia e manda o convite. O Discord continua do jeito que está, então
            ninguém precisa se mudar no mesmo dia.
          </Lede>
        </Reveal>
        <Reveal className="mt-10" delay={80}>
          <JoinButton
            intent={IMPORT_INTENT}
            className="cta-lift group flex w-full max-w-xl items-center justify-between gap-3 rounded-full border border-white/15 bg-ink-2 p-1.5 pl-5 transition-colors hover:border-signal/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            <span aria-hidden className="truncate font-mono text-sm text-paper-muted">
              discord.new/…
            </span>
            <span className="inline-flex h-11 shrink-0 items-center gap-2 rounded-full bg-signal px-5 text-[15px] font-semibold text-ink transition-colors group-hover:bg-signal-dim">
              Trazer meu servidor
              <ArrowRight className="h-4 w-4" aria-hidden />
            </span>
          </JoinButton>
          <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2">
            <JoinButton intent={CREATE_INTENT} className="inline-flex min-h-10 items-center text-[15px] font-medium text-paper underline decoration-white/30 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal">
              Ou criar um do zero
            </JoinButton>
            <p className="text-sm text-paper-muted">Grátis, sem cartão. Entra com Google, Apple ou Twitch.</p>
          </div>
        </Reveal>
      </div>
    </section>
  );
}
