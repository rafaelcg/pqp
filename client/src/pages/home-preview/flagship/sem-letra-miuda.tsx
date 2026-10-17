import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { cn } from "@/lib/utils";
import { Reveal } from "./cinema";
import { CONTAINER, Eyebrow, HEADER_GAP, Hi, Section, SectionHeader } from "./ui";

/**
 * "Ainda em obra": the page's quiet section. Plain Portuguese, no
 * jokes, and on purpose no effect beyond a soft rise as each line arrives: no
 * tilt, no glow, and no lime past the eyebrow and the title's one highlighted
 * phrase. It earns the claims above it by stating, with a date, what is
 * missing and what Discord does better today.
 */

const UPDATED_ISO = "2026-10-16";
const UPDATED_LABEL = "16 de outubro de 2026";

const INLINE_LINK =
  "text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

/* What the import brings and where it runs is said once, under the import
 * demo in Mudança, so it is not repeated here. */
const NOT_YET: { lead: string; body: ReactNode }[] = [
  {
    lead: "O app de iPhone ainda é beta.",
    body: (
      <>
        Ele está no TestFlight, em{" "}
        <Link to="/beta" className={INLINE_LINK}>
          pqp.gg/beta
        </Link>
        .
      </>
    ),
  },
  {
    lead: "A watch party está em acesso antecipado.",
    body: (
      <>
        Ela é liberada servidor por servidor. Dá pra pedir pelo{" "}
        <Link to="/watch-party" className={INLINE_LINK}>
          pqp.gg/watch-party
        </Link>
        .
      </>
    ),
  },
  {
    lead: "Bots e integrações estão começando.",
    body: "Webhooks no formato do Discord já funcionam. Fora isso, a lista ainda é curta.",
  },
  {
    lead: "O som da tela depende do navegador e do sistema.",
    body: "Uma aba do Chrome ou do Edge leva o som junto. No app de desktop, o som do computador vai só no Windows 11; no Mac, no Linux e no Windows 10, vai só a imagem.",
  },
];

const DISCORD_BETTER: { lead: string; body: string }[] = [
  {
    lead: "Apps nativos maduros.",
    body: "Os apps de celular e de computador do Discord são muito bons, e têm anos de polimento.",
  },
  {
    lead: "Um ecossistema enorme de bots e integrações.",
    body: "Pra quase tudo que um servidor precisa, já existe um bot pronto.",
  },
  {
    lead: "Anos de estrada.",
    body: "Muitos casos raros, em muitos aparelhos diferentes, já foram encontrados e resolvidos por lá.",
  },
];

export function SemLetraMiuda() {
  return (
    <Section id="limites" labelledBy="limites-title">
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow="Sem letra miúda"
          titleId="limites-title"
          title={
            <>
              Ainda <Hi>em obra</Hi>.
            </>
          }
          lede={
            <>
              Pra vocês decidirem com tudo na mesa. A lista muda conforme as coisas ficam prontas.
              <span className="mt-4 block font-mono text-xs text-paper-muted">
                Atualizado em <time dateTime={UPDATED_ISO}>{UPDATED_LABEL}</time>.
              </span>
            </>
          }
        />

        <div className={cn(HEADER_GAP, "grid gap-16 lg:grid-cols-12 lg:gap-12")}>
          <div className="lg:col-span-7">
            <Column title="Ainda tá chegando" items={NOT_YET} />
          </div>

          <div className="lg:sticky lg:top-28 lg:col-span-5 lg:col-start-8 lg:self-start">
            <Column title="O que o Discord faz melhor hoje" items={DISCORD_BETTER} />
            <Link
              to="/vs-discord"
              className="mt-8 inline-flex min-h-10 items-center gap-2 text-[15px] font-medium text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:decoration-signal focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
            >
              Ver a comparação completa
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>
        </div>
      </div>
    </Section>
  );
}

function Column({ title, items }: { title: string; items: { lead: string; body: ReactNode }[] }) {
  return (
    <div>
      {/* A column label, not a headline: the muted eyebrow, still a level-3 heading. */}
      <Eyebrow tone="muted" as="h3" className="border-b border-white/[0.1] pb-4">
        {title}
      </Eyebrow>
      <Reveal as="ol" stagger={70} className="divide-y divide-white/[0.06]">
        {items.map((item, i) => (
          <li key={item.lead} className="grid grid-cols-[2.25rem_1fr] gap-x-3 py-6 sm:grid-cols-[3rem_1fr]">
            <span aria-hidden className="pt-0.5 font-mono text-xs text-paper-muted/70 tabular-nums">
              {String(i + 1).padStart(2, "0")}
            </span>
            <div>
              <p className="font-display text-lg font-semibold leading-snug text-paper text-pretty">{item.lead}</p>
              <p className="mt-2 leading-relaxed text-paper-muted text-pretty">{item.body}</p>
            </div>
          </li>
        ))}
      </Reveal>
    </div>
  );
}
