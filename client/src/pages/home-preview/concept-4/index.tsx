import { useState, type CSSProperties, type Dispatch, type SetStateAction } from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { MarketingFooter } from "@/components/marketing/marketing-footer";
import { BetaTag } from "@/components/ui/beta-tag";
import { cn } from "@/lib/utils";
import { JoinButton, SignInButton } from "../shared/auth-buttons";
import "../shared/mock.css";
import { Builder, INITIAL_DRAFT, type Draft } from "./builder";
import "./c4.css";
import { Codigo, Convite, Discord, Fim, Limites } from "./sections";
import { Tela } from "./share";
import { CONTAINER } from "./ui";

/**
 * Concept 4, "Monta o rolê": the hero is a builder. You name a server, switch
 * channels on and off and watch a drawn pqp window follow. It is a preview and
 * says so; the real room is made in the app after sign-up. Lighter and more
 * tool-like than the flagship: hairline panels, inputs, switches, mono labels.
 */
export default function Concept4() {
  const [draft, setDraft] = useState<Draft>(INITIAL_DRAFT);

  return (
    <div className="min-h-screen overflow-x-clip bg-ink text-paper">
      <a
        href="#conteudo"
        className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-4 focus:z-[70] focus:rounded-lg focus:bg-paper focus:px-4 focus:py-2 focus:text-sm focus:font-semibold focus:text-ink"
      >
        Pular pro conteúdo
      </a>
      <Nav />
      <main id="conteudo" tabIndex={-1} className="relative outline-none">
        {/* The grid the page is drawn on: two hairlines at the content edges. */}
        <div aria-hidden className="pointer-events-none absolute inset-0 z-0">
          <div className={cn(CONTAINER, "h-full")}>
            <div className="h-full border-x border-white/[0.05]" />
          </div>
        </div>
        <div className="relative z-10">
          <Hero draft={draft} setDraft={setDraft} />
          <Tela />
          <Discord />
          <Convite draft={draft} />
          <Limites />
          <Codigo />
          <Fim />
        </div>
      </main>
      <MarketingFooter />
    </div>
  );
}

const NAV_LINKS = [
  { href: "#monta", label: "Monta o rolê" },
  { href: "#tela", label: "Tela com som" },
  { href: "#discord", label: "Do Discord" },
  { href: "#link", label: "Convite" },
  { href: "#codigo", label: "Código aberto" },
];

function Nav() {
  return (
    <header className="sticky top-0 z-50 border-b border-white/[0.07] bg-ink/85 backdrop-blur-xl">
      <div className={cn(CONTAINER, "flex h-14 items-center gap-6")}>
        <Link to="/preview/home/c4" className="flex items-center gap-2 font-brand text-xl tracking-tight">
          pqp
          <BetaTag />
        </Link>
        <nav aria-label="Seções" className="hidden min-w-0 items-center gap-6 text-sm text-paper-muted lg:flex">
          {NAV_LINKS.map((l) => (
            <a key={l.href} href={l.href} className="whitespace-nowrap transition-colors hover:text-paper">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-2 sm:gap-3">
          <SignInButton className="hidden h-9 items-center rounded-lg px-3 text-sm font-medium text-paper-muted transition-colors hover:text-paper sm:inline-flex" />
          <JoinButton className="inline-flex h-9 items-center rounded-lg bg-paper px-4 text-sm font-semibold text-ink transition-colors hover:bg-paper/85 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal">
            Começar
          </JoinButton>
        </div>
      </div>
    </header>
  );
}

function Hero({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  return (
    <section id="monta" className="relative scroll-mt-14 pb-12 pt-8 sm:pt-12 lg:pb-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-[520px] bg-[radial-gradient(60%_60%_at_50%_0%,color-mix(in_oklch,var(--color-text)_7%,transparent),transparent)]"
      />
      <div className={cn(CONTAINER, "relative")}>
        <p
          className="animate-rise inline-flex items-center gap-2 rounded-full border border-white/10 px-3 py-1 text-xs text-paper-muted"
          style={{ "--stagger": 0 } as CSSProperties}
        >
          <span className="h-1.5 w-1.5 rounded-full bg-paper-muted" aria-hidden />
          De graça, código aberto, feito por dois irmãos
        </p>
        <div className="mt-5 grid gap-4 lg:mb-8 lg:grid-cols-12 lg:items-end lg:gap-8">
          <h1
            className="animate-rise font-display text-[clamp(2.6rem,11vw,3.75rem)] font-bold leading-[0.98] tracking-[-0.03em] text-balance lg:col-span-8"
            style={{ "--stagger": 1 } as CSSProperties}
          >
            Monta o rolê da galera.
            <span
              aria-hidden
              className="c4-caret ml-1.5 inline-block h-[0.78em] w-[0.09em] translate-y-[0.04em] bg-signal align-baseline"
            />
          </h1>
          <p
            className="animate-rise text-base leading-relaxed text-paper-muted text-pretty sm:text-lg lg:col-span-4 lg:pb-1"
            style={{ "--stagger": 2 } as CSSProperties}
          >
            Dá nome pro servidor, escolhe os canais e vê como fica. Depois é só mandar o link.
          </p>
        </div>

        <div className="mt-8 lg:mt-0">
          <Builder draft={draft} setDraft={setDraft} />
          <HeroDownload tone="ink" className="mt-3" />
        </div>
      </div>
    </section>
  );
}
