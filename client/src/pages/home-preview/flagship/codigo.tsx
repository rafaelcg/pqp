import { ArrowUpRight, Check, CodeXml, Info, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { formatPostDate } from "@/lib/blog/format";
import { POSTS, postTitle } from "@/lib/blog/posts";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { Reveal, Tilt } from "./cinema";
import { OndeStrip } from "./onde";
import {
  BTN_SECONDARY,
  CARD,
  CARD_RAISED,
  CONTAINER,
  Eyebrow,
  H3,
  HEADER_GAP,
  Hi,
  Section,
  SectionHeader,
} from "./ui";

/**
 * Trust, in normal-person language. The lede carries the page's one promise
 * (no paid plan, no card, donating unlocks nothing). Then two doors with the
 * same code behind them: the hosted pqp.gg (the default) and a copy of your
 * own; where the calls run, read live from `/status.json`; who makes it; and
 * the three newest release notes so the page shows the project is moving.
 * `posts.ts` is metadata only (titles and dates, no bodies), so the strip
 * costs a few kilobytes.
 *
 * Motion: the head enters in turn, the two doors rise in turn and lean toward
 * the pointer (mouse only), the rest simply arrives.
 */

const REPO_LABEL = SOURCE_REPO_URL.replace(/^https?:\/\//, "");

const OURS = ["Roda no navegador, sem instalar", "Servidor e banco em São Paulo", "Backup toda noite"];

const YOURS = [
  "Código aberto, sob a AGPL",
  "Exporta seus dados quando quiser",
  "Roda uma cópia na sua máquina",
  "Os dados ficam onde você decidir",
];

export function Codigo() {
  const notes = POSTS.slice(0, 3);
  return (
    <Section id="codigo" labelledBy="codigo-title">
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow="Código aberto"
          titleId="codigo-title"
          title={
            <>
              O código é público. <Hi>Qualquer um</Hi> confere.
            </>
          }
          lede="Sem plano pago, sem cartão, e doar não desbloqueia nada: é o mesmo pqp pra todo mundo. Você usa o nosso e, se um dia quiser, roda o seu com o mesmo código."
          aside={<RepoLink />}
        />

        {/* The two doors. On wide screens a plus sits on the seam between them. */}
        <div className={cn("relative", HEADER_GAP)}>
          <Reveal variant="scale" stagger={140} className="grid gap-4 md:grid-cols-2 md:gap-5">
            <Tilt max={3} className="h-full rounded-3xl">
              <article className={cn(CARD_RAISED, "flex h-full flex-col border-signal/40 p-7 sm:p-9")}>
                <Door label="pqp.gg" title="Usa o nosso">
                  Abre o site e pronto. A gente cuida do servidor, do banco e das atualizações.
                </Door>
                <Ticks items={OURS} className="mb-8 mt-8" />
                <Note>
                  As calls maiores passam pelo servidor de voz mais perto da galera. DMs e servidores pequenos vão direto.
                </Note>
              </article>
            </Tilt>

            <Tilt max={3} className="h-full rounded-3xl">
              <article className={cn(CARD, "flex h-full flex-col p-7 sm:p-9")}>
                <Door label="sua máquina" title="Ou roda o seu">
                  O mesmo app, com o código inteiro na mão. E mais:
                </Door>
                <Ticks items={YOURS} className="mb-8 mt-8" />
                <Note>
                  Sem servidor de mídia, cada canal de voz aguenta umas <span className="text-paper">oito pessoas</span>.
                </Note>
              </article>
            </Tilt>
          </Reveal>

          {/* Its own entrance, after both doors; the layer is what moves, so the
              seam's centring transform is left alone. */}
          <Reveal variant="scale" delay={420} className="pointer-events-none absolute inset-0 z-10 hidden md:block">
            <span
              aria-hidden
              className="absolute left-1/2 top-1/2 grid h-12 w-12 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-full border border-white/10 bg-ink text-paper-muted shadow-[0_0_0_8px_var(--color-surface-0)]"
            >
              <Plus className="h-5 w-5" />
            </span>
          </Reveal>
        </div>

        {/* Where the calls run, read live. */}
        <Reveal className="mt-5">
          <OndeStrip />
        </Reveal>

        {/* Who makes it, and how to help. */}
        <Reveal variant="scale" className="mt-5">
          <div className={cn(CARD, "grid gap-8 p-7 sm:p-9 md:grid-cols-12 md:items-center md:gap-10")}>
            <div className="md:col-span-5">
              <Eyebrow tone="muted">Quem faz o pqp</Eyebrow>
              <H3 size="lg" className="mt-4 text-[clamp(2rem,3.6vw,3rem)] leading-none tracking-[-0.03em] text-paper">
                Dois irmãos.
              </H3>
            </div>
            <div className="flex flex-col items-start gap-6 md:col-span-7 md:border-l md:border-white/[0.07] md:pl-10 lg:flex-row lg:items-center lg:justify-between">
              <p className="max-w-sm text-lg leading-relaxed text-paper text-pretty">
                Quem quiser ajudar com a hospedagem pode doar.
              </p>
              <Link to="/apoie" className={cn(BTN_SECONDARY, "shrink-0")}>
                Apoiar o pqp
              </Link>
            </div>
          </div>
        </Reveal>

        {/* The project, moving: the three newest release notes. */}
        {notes.length > 0 && (
          <Reveal className="mt-14">
            <div className="flex items-baseline justify-between gap-4">
              <Eyebrow tone="muted" as="h3">
                Notas de versão
              </Eyebrow>
              <Link
                to="/blog"
                className="inline-flex min-h-10 items-center gap-1 rounded-full text-sm font-medium text-paper transition-colors hover:text-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
              >
                Ver todas
                <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
              </Link>
            </div>
            <Reveal as="ol" stagger={110} className="mt-4 grid border-t border-white/[0.07] md:grid-cols-3">
              {notes.map((post) => (
                <li
                  key={post.slug}
                  className="border-b border-white/[0.07] md:border-b-0 md:border-r md:last:border-r-0 md:[&:not(:first-child)]:pl-6"
                >
                  <Link
                    to={`/blog/${post.slug}`}
                    className="group block rounded-xl py-5 pr-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  >
                    <time dateTime={post.date} className="font-mono text-xs text-paper-muted tabular-nums">
                      {formatPostDate(post.date, "pt-BR")}
                    </time>
                    <span className="mt-2 block font-display text-lg font-semibold leading-snug text-paper text-pretty transition-colors group-hover:text-signal">
                      {postTitle(post, "pt-BR")}
                    </span>
                  </Link>
                </li>
              ))}
            </Reveal>
          </Reveal>
        )}
      </div>
    </Section>
  );
}

/** The repository, as one mono pill. Right-aligned in the header's aside from `lg`. */
function RepoLink() {
  return (
    <div className="lg:flex lg:justify-end">
      <a
        href={SOURCE_REPO_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="group inline-flex h-12 max-w-full items-center gap-3 rounded-full border border-white/10 bg-ink-2/80 pl-4 pr-3 font-mono text-sm text-paper transition-colors hover:border-signal/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
      >
        <CodeXml className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
        <span className="truncate">{REPO_LABEL}</span>
        <span className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.06] transition-colors group-hover:bg-signal group-hover:text-ink">
          <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
        </span>
        <span className="sr-only">(abre o repositório no GitHub)</span>
      </a>
    </div>
  );
}

/** A door's head: where it runs, its name, one line. */
function Door({ label, title, children }: { label: string; title: string; children: ReactNode }) {
  return (
    <>
      <p className="flex items-center gap-2 font-mono text-xs text-paper-muted">
        <span className="h-1.5 w-1.5 rounded-full bg-paper-muted/60" aria-hidden />
        {label}
      </p>
      <H3 size="lg" className="mt-5">
        {title}
      </H3>
      <p className="mt-3 max-w-sm leading-relaxed text-paper-muted">{children}</p>
    </>
  );
}

/** The footnote both doors end on, pinned to the bottom so the two cards line up. */
function Note({ children }: { children: ReactNode }) {
  return (
    <p className="mt-auto flex gap-3 rounded-2xl border border-white/[0.07] bg-white/[0.02] p-4 text-sm leading-relaxed text-paper-muted">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-paper" aria-hidden />
      <span>{children}</span>
    </p>
  );
}

function Ticks({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn("space-y-3.5", className)}>
      {items.map((item) => (
        <li key={item} className="flex items-start gap-3 text-[15px] leading-snug text-paper">
          <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/[0.08] text-paper" aria-hidden>
            <Check className="h-3 w-3" strokeWidth={3} />
          </span>
          {item}
        </li>
      ))}
    </ul>
  );
}
