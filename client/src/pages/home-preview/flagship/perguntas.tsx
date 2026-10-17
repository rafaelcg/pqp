import { ArrowUpRight, Plus } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { Reveal } from "./cinema";
import { CONTAINER, H3, HEADER_GAP, Hi, Section, SectionHeader } from "./ui";

/**
 * The worries people have before they move a crew, asked in their words and
 * answered plainly. Native <details>: keyboard and screen reader behaviour
 * come from the browser, and the answers are all there without JavaScript.
 * The component is stateless on purpose, so React never re-applies `open`
 * and closes what a reader opened. Where the browser supports
 * `::details-content`, the panel eases open; elsewhere it simply appears.
 * The questions arrive one after another as the list scrolls in; a row lifts
 * its question and lights its number on hover.
 */

const A = "text-paper underline decoration-white/25 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:rounded-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal";

const FAQ: { q: string; a: ReactNode }[] = [
  {
    q: "E meus amigos que não saem do Discord?",
    a: (
      <p>
        Não precisam sair. Dá pra usar os dois ao mesmo tempo, e o Discord continua igual. Você manda o link do
        convite no grupo e quem clicar entra pelo navegador, sem instalar nada.
      </p>
    ),
  },
  {
    q: "Perco o histórico?",
    a: (
      <p>
        O histórico continua no Discord, onde sempre esteve. A importação traz a estrutura do servidor: nome e
        ícone, categorias, canais na mesma ordem, cargos e permissões. Mensagens, anexos e membros não vêm junto, então
        a conversa no pqp começa do zero.
      </p>
    ),
  },
  {
    q: "É grátis mesmo?",
    a: (
      <p>
        Sim, é de graça, e quem quiser ajudar com a hospedagem pode{" "}
        <Link to="/apoie" className={A}>
          doar
        </Link>
        .
      </p>
    ),
  },
  {
    q: "Funciona no celular?",
    a: (
      <p>
        Funciona no navegador do celular. No Android tem{" "}
        <Link to="/android" className={A}>
          app na Google Play
        </Link>
        . No iPhone, o app está em beta pelo TestFlight, e o convite fica em{" "}
        <Link to="/beta" className={A}>
          pqp.gg/beta
        </Link>
        .
      </p>
    ),
  },
  {
    q: "Precisa instalar alguma coisa?",
    a: (
      <p>
        Não. O pqp roda no navegador. Se preferir um app, tem pra Mac, Windows e Linux em{" "}
        <Link to="/download" className={A}>
          pqp.gg/download
        </Link>
        .
      </p>
    ),
  },
  {
    q: "O que o pqp coleta e onde ficam meus dados?",
    a: (
      <>
        <p>
          O site usa análise de visitas sem cookies (Umami e Cloudflare Web Analytics), relatório de erros (Grafana
          Faro) e a tag do Google Ads, que usa cookies. Está tudo explicado em linguagem simples na{" "}
          <Link to="/privacy" className={A}>
            política de privacidade
          </Link>
          .
        </p>
        <p>
          Os dados ficam no nosso banco em São Paulo, com backups na América do Norte, e você pode exportar os seus
          quando quiser.
        </p>
      </>
    ),
  },
  {
    q: "E se o pqp acabar?",
    a: (
      <p>
        O código é aberto, sob a AGPL, e está{" "}
        <a href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer" className={A}>
          público no GitHub
        </a>
        . Você pode exportar seus dados e rodar uma cópia do pqp na sua máquina.
      </p>
    ),
  },
];

export function Perguntas() {
  return (
    <Section id="perguntas" labelledBy="perguntas-title">
      <div className={CONTAINER}>
        <SectionHeader
          eyebrow="Perguntas"
          titleId="perguntas-title"
          title={
            <>
              Perguntas de quem <Hi>tá chegando</Hi>.
            </>
          }
          lede="Respostas curtas e diretas pro que todo mundo quer saber antes de mudar."
          aside={
            <ul className="space-y-1 text-sm lg:pb-1">
              <li>
                <Link to="/vs-discord" className={cn(A, "inline-flex min-h-10 items-center gap-1.5 no-underline")}>
                  Comparação completa com o Discord
                  <ArrowUpRight className="h-3.5 w-3.5 text-paper-muted" aria-hidden />
                </Link>
              </li>
              <li>
                <Link to="/status" className={cn(A, "inline-flex min-h-10 items-center gap-1.5 no-underline")}>
                  Status do serviço, ao vivo
                  <ArrowUpRight className="h-3.5 w-3.5 text-paper-muted" aria-hidden />
                </Link>
              </li>
            </ul>
          }
        />

        <div className={HEADER_GAP}>
          <Reveal as="ul" stagger={60} delay={120} className="border-t border-white/10">
            {FAQ.map((item, i) => (
              <li key={item.q} className="border-b border-white/10">
                <details
                  open={i === 0}
                  className={cn(
                    "group [interpolate-size:allow-keywords]",
                    "[&::details-content]:h-0 [&::details-content]:overflow-clip [&::details-content]:transition-[height,content-visibility] [&::details-content]:duration-300 [&::details-content]:ease-out [&::details-content]:[transition-behavior:allow-discrete]",
                    "open:[&::details-content]:h-auto motion-reduce:[&::details-content]:transition-none",
                  )}
                >
                  <summary className="flex min-h-11 cursor-pointer list-none items-start gap-4 -mx-3 rounded-xl px-3 py-6 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal sm:gap-6 [&::-webkit-details-marker]:hidden">
                    <span
                      aria-hidden
                      className="w-7 shrink-0 pt-1 font-mono text-xs text-paper-muted/70 tabular-nums transition-colors group-hover:text-paper group-open:text-signal sm:pt-1.5"
                    >
                      {String(i + 1).padStart(2, "0")}
                    </span>
                    <H3 className="min-w-0 flex-1 text-paper/85 transition-[color,translate] duration-300 ease-out group-hover:text-paper group-open:text-paper text-pretty motion-safe:group-hover:translate-x-1">
                      {item.q}
                    </H3>
                    <span
                      aria-hidden
                      className="grid h-8 w-8 shrink-0 place-items-center rounded-full border border-white/10 text-paper-muted transition-[transform,color,border-color,background-color] duration-300 group-hover:border-white/25 group-hover:text-paper group-open:rotate-45 group-open:border-signal/40 group-open:bg-signal/10 group-open:text-signal motion-reduce:transition-none"
                    >
                      <Plus className="h-4 w-4" />
                    </span>
                  </summary>
                  <div className="max-w-3xl space-y-3 pb-7 pl-11 pr-2 text-[15px] leading-relaxed text-paper-muted text-pretty sm:pl-[3.25rem] sm:pr-14 sm:text-base">
                    {item.a}
                  </div>
                </details>
              </li>
            ))}
          </Reveal>
        </div>
      </div>
    </Section>
  );
}
