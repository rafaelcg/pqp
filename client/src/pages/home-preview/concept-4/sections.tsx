import { ArrowRight, ArrowUpRight, Check, Code2, Hash, Link2, Lock, Minus, Volume2 } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { CHANNELS } from "./data";
import { ServerIcon, displayName, type Draft } from "./builder";
import {
  BTN_PRIMARY,
  BTN_SECONDARY,
  CONTAINER,
  ExampleTag,
  MONO,
  PANEL,
  PanelHead,
  SectionHead,
} from "./ui";

const TEXT_LINK =
  "text-paper underline decoration-paper-muted/40 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal rounded-sm";

/* ------------------------------------------------------------------ */
/* 03 Do Discord                                                       */
/* ------------------------------------------------------------------ */

const COMES = [
  "Nome e ícone do servidor",
  "Categorias, canais de texto e de voz, na mesma ordem",
  "Tópico de cada canal",
  "Cargos, com nome, cor e permissões (menos o de Administrador)",
  "Canais privados e quem pode ver, escrever e entrar",
];

const STAYS = [
  "Membros",
  "Mensagens e anexos",
  "Emoji e figurinhas personalizados",
  "Soundboard",
  "Webhooks",
  "Banimentos",
  "Convites do Discord",
];

const STEPS = [
  {
    title: "Gera o link de modelo no Discord",
    text: "Quem é dono do servidor, ou tem a permissão Gerenciar servidor, cria o link (discord.new/…). Isso se faz no computador ou no navegador, não no app do celular.",
  },
  {
    title: "Cola o link no pqp",
    text: "Você vê uma prévia do que vai ser criado antes de confirmar.",
  },
  {
    title: "Cria, e pronto",
    text: "Sem bot, sem login do Discord, sem token. O Discord não muda: dá pra usar os dois ao mesmo tempo.",
  },
];

export function Discord() {
  return (
    <section id="discord" className="relative scroll-mt-16 py-16 sm:py-20">
      <div className={CONTAINER}>
        <SectionHead
          n="03"
          label="Ou traz o do Discord"
          title="Já tem servidor? Traz o desenho dele."
          lede="A importação é oficial e leva a estrutura: canais, categorias e cargos. O histórico de mensagens e a lista de gente ficam onde estão."
        />

        <div className="mt-12 grid gap-4 lg:grid-cols-12">
          <div className={cn(PANEL, "lg:col-span-5")}>
            <PanelHead n="A" label="Como funciona" />
            <ol className="grid gap-5 p-5">
              {STEPS.map((s, i) => (
                <li key={s.title} className="grid grid-cols-[28px_1fr] gap-3">
                  <span className="grid h-7 w-7 place-items-center rounded-lg border border-white/15 font-mono text-xs text-paper">
                    {i + 1}
                  </span>
                  <div>
                    <h3 className="font-display text-base font-semibold leading-7">{s.title}</h3>
                    <p className="mt-1 text-sm leading-relaxed text-paper-muted">{s.text}</p>
                  </div>
                </li>
              ))}
            </ol>
            <div className="border-t border-white/[0.08] p-4">
              <JoinButton intent={IMPORT_INTENT} className={cn(BTN_SECONDARY, "w-full sm:w-auto")}>
                Trazer do Discord
                <ArrowRight className="h-4 w-4" aria-hidden />
              </JoinButton>
              <p className="mt-3 text-xs leading-relaxed text-paper-muted">
                A importação roda na web, hoje. Depois de criar a conta, o pqp abre o campo pra você colar o link.
              </p>
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2 lg:col-span-7">
            <div className={PANEL}>
              <PanelHead label="Vem junto" right={<span className="font-mono text-[11px] text-paper-muted">{COMES.length}</span>} />
              <ul className="grid gap-3 p-5">
                {COMES.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm leading-snug text-paper">
                    <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full bg-white/10 text-paper">
                      <Check className="h-3 w-3" strokeWidth={3} aria-hidden />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
            <div className={cn(PANEL, "bg-transparent")}>
              <PanelHead label="Não vem" right={<span className="font-mono text-[11px] text-paper-muted">{STAYS.length}</span>} />
              <ul className="grid gap-3 p-5">
                {STAYS.map((item) => (
                  <li key={item} className="flex items-start gap-3 text-sm leading-snug text-paper-muted">
                    <span className="mt-px grid h-5 w-5 shrink-0 place-items-center rounded-full border border-white/15">
                      <Minus className="h-3 w-3" aria-hidden />
                    </span>
                    {item}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 04 Manda o link                                                     */
/* ------------------------------------------------------------------ */

function InviteCard({ draft }: { draft: Draft }) {
  const on = CHANNELS.filter((c) => draft.on.includes(c.id));
  return (
    <div className={cn(PANEL, "overflow-hidden")}>
      <div className="c4-dots relative h-24 border-b border-white/[0.08] bg-ink-2/60">
        <span className="absolute right-3 top-3">
          <ExampleTag>prévia</ExampleTag>
        </span>
      </div>
      <div className="px-5 pb-5 sm:px-6 sm:pb-6">
        <ServerIcon draft={draft} className="-mt-8 h-16 w-16 rounded-2xl border-4 border-ink-2 text-xl" />
        <p className={cn(MONO, "mt-4")}>convite pra</p>
        <p className="mt-1 break-words font-display text-3xl font-bold leading-tight tracking-tight sm:text-4xl">
          {displayName(draft)}
        </p>
        {on.length > 0 ? (
          <ul className="mt-4 flex flex-wrap gap-2" aria-label="Canais da prévia">
            {on.map((c) => {
              const Icon = c.kind === "voice" ? Volume2 : c.kind === "private" ? Lock : Hash;
              return (
                <li
                  key={c.id}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-2.5 py-1 text-xs text-paper-muted"
                >
                  <Icon className="h-3 w-3" aria-hidden />
                  {c.name}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-4 text-sm text-paper-muted">Nenhum canal ligado na prévia.</p>
        )}
        <span
          aria-hidden
          className="mt-6 inline-flex h-11 w-full items-center justify-center rounded-xl bg-paper text-[15px] font-semibold text-ink sm:w-auto sm:px-8"
        >
          Entrar no servidor
        </span>
      </div>
      <div className="flex items-center gap-3 border-t border-white/[0.08] bg-ink/60 px-5 py-3 sm:px-6">
        <Link2 className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
        <code className="min-w-0 flex-1 truncate font-mono text-[13px] text-paper">pqp.gg/app/invite/exemplo</code>
        <ExampleTag>link de exemplo</ExampleTag>
      </div>
    </div>
  );
}

const LINK_STEPS = [
  "Copia o link do convite no app e manda no grupo.",
  "Quem abre o link vê o servidor, cria a conta com Google, Apple ou Twitch e entra.",
  "Tudo pelo navegador. Ninguém precisa instalar nada pra cair na sala.",
];

export function Convite({ draft }: { draft: Draft }) {
  return (
    <section id="link" className="relative scroll-mt-16 py-16 sm:py-20">
      <div className={CONTAINER}>
        <SectionHead
          n="04"
          label="Manda o link"
          title="Depois é só mandar o link."
          lede="O convite é um endereço. Quem recebe abre no navegador, sem baixar nada."
        />

        <div className="mt-12 grid gap-8 lg:grid-cols-12 lg:gap-10">
          <div className="lg:col-span-6">
            <InviteCard draft={draft} />
            <p className="mt-3 text-xs leading-relaxed text-paper-muted">
              Prévia com o nome e os canais que você montou lá em cima. No app, o convite sai do servidor que você
              criar de verdade, e o endereço é outro.
            </p>
          </div>

          <div className="lg:col-span-6 lg:pt-2">
            <ol className="grid gap-0 border-t border-white/10">
              {LINK_STEPS.map((text, i) => (
                <li key={text} className="grid grid-cols-[40px_1fr] gap-3 border-b border-white/10 py-5">
                  <span className={cn(MONO, "pt-1 text-paper")}>{String(i + 1).padStart(2, "0")}</span>
                  <p className="text-base leading-relaxed text-paper sm:text-lg">{text}</p>
                </li>
              ))}
            </ol>
            <p className="mt-6 text-sm leading-relaxed text-paper-muted">
              Se preferirem app: tem para Mac, Windows e Linux, para Android no Google Play e uma versão beta para
              iPhone, pelo TestFlight.{" "}
              <Link to="/download" className={TEXT_LINK}>
                Ver os downloads
              </Link>
              .
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 05 O que ainda não temos                                            */
/* ------------------------------------------------------------------ */

const LIMITS: { status: string; title: string; text: ReactNode }[] = [
  {
    status: "Só estrutura",
    title: "Importar do Discord",
    text: "Traz canais, categorias e cargos. Não traz mensagens, anexos nem membros. E hoje a importação roda só na web.",
  },
  {
    status: "Beta",
    title: "App do iPhone",
    text: "Está em beta, pelo TestFlight. No Android o app já está no Google Play.",
  },
  {
    status: "Acesso antecipado",
    title: "Filme em grupo (watch party)",
    text: (
      <>
        Liberado servidor por servidor. Dá pra entrar na lista em{" "}
        <Link to="/watch-party" className={TEXT_LINK}>
          pqp.gg/watch-party
        </Link>
        .
      </>
    ),
  },
  {
    status: "Começando",
    title: "Bots e integrações",
    text: "Os webhooks são compatíveis com os do Discord. O resto das integrações está no começo.",
  },
  {
    status: "Depende",
    title: "Som na tela compartilhada",
    text: "Vai junto numa aba do Chrome ou do Edge e, no app de computador, só no Windows 11.",
  },
  {
    status: "Justo dizer",
    title: "Onde o Discord ainda faz melhor",
    text: (
      <>
        Os apps nativos são maduros e muito bons, o ecossistema de bots e integrações é gigante e a plataforma tem
        mais estrada. Se você depende disso hoje, dá pra usar os dois ao mesmo tempo.{" "}
        <Link to="/vs-discord" className={TEXT_LINK}>
          Comparação completa
        </Link>
        .
      </>
    ),
  },
];

export function Limites() {
  return (
    <section id="limites" className="relative scroll-mt-16 py-16 sm:py-20">
      <div className={CONTAINER}>
        <SectionHead
          n="05"
          label="O que ainda não temos"
          title="O que ainda não tem, dito sem rodeio."
          lede="O pqp está em beta aberto. Esta é a lista do que falta, do que é recente e do que o Discord faz melhor hoje."
        />
        <div className={cn(PANEL, "mt-12 overflow-hidden")}>
          <div className="hidden grid-cols-[200px_minmax(0,280px)_1fr] gap-6 border-b border-white/[0.08] px-5 py-3 md:grid">
            <span className={MONO}>Estado</span>
            <span className={MONO}>Assunto</span>
            <span className={MONO}>O que isso quer dizer</span>
          </div>
          <ul>
            {LIMITS.map((row) => (
              <li
                key={row.title}
                className="grid gap-2 border-b border-white/[0.08] px-5 py-5 last:border-b-0 md:grid-cols-[200px_minmax(0,280px)_1fr] md:gap-6"
              >
                <div>
                  <span className="inline-flex items-center rounded-md border border-white/15 px-2 py-0.5 font-mono text-[11px] text-paper">
                    {row.status}
                  </span>
                </div>
                <h3 className="font-display text-base font-semibold leading-snug">{row.title}</h3>
                <p className="text-sm leading-relaxed text-paper-muted">{row.text}</p>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* 06 Código aberto                                                    */
/* ------------------------------------------------------------------ */

const FACTS: { k: string; v: ReactNode }[] = [
  { k: "Preço", v: "De graça. Não tem plano pago nem cartão." },
  { k: "Licença", v: "AGPL. Qualquer pessoa pode ler o código." },
  { k: "Seus dados", v: "Dá pra exportar." },
  {
    k: "Rodar o seu",
    v: "Dá pra instalar uma cópia na sua máquina. Sem servidor de mídia, cada canal de voz comporta cerca de oito pessoas.",
  },
  {
    k: "Quem faz",
    v: "Dois irmãos.",
  },
  {
    k: "Doações",
    v: (
      <>
        Existem, ajudam com a hospedagem e não desbloqueiam nada.{" "}
        <Link to="/apoie" className={TEXT_LINK}>
          Como ajudar
        </Link>
        .
      </>
    ),
  },
];

export function Codigo() {
  return (
    <section id="codigo" className="relative scroll-mt-16 py-16 sm:py-20">
      <div className={CONTAINER}>
        <SectionHead
          n="06"
          label="Código aberto"
          title="O código é aberto e o pqp é de graça."
          lede="O código do pqp fica num repositório público. Você lê, confere e, se quiser, roda uma cópia."
        />
        <div className="mt-12 grid gap-4 lg:grid-cols-12">
          <div className={cn(PANEL, "lg:col-span-8")}>
            <PanelHead label="Ficha técnica" />
            <dl>
              {FACTS.map((row) => (
                <div
                  key={row.k}
                  className="grid gap-1 border-b border-white/[0.08] px-5 py-4 last:border-b-0 sm:grid-cols-[160px_1fr] sm:gap-6"
                >
                  <dt className={cn(MONO, "pt-0.5")}>{row.k}</dt>
                  <dd className="text-sm leading-relaxed text-paper">{row.v}</dd>
                </div>
              ))}
            </dl>
          </div>
          <div className={cn(PANEL, "flex flex-col justify-between gap-6 p-5 lg:col-span-4")}>
            <div>
              <Code2 className="h-6 w-6 text-paper-muted" aria-hidden />
              <h3 className="mt-4 font-display text-xl font-semibold">Dá uma olhada no código</h3>
              <p className="mt-2 text-sm leading-relaxed text-paper-muted">
                O repositório fica no GitHub, com a licença e as instruções pra rodar a sua cópia.
              </p>
            </div>
            <a href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer" className={cn(BTN_SECONDARY, "w-full")}>
              Abrir o repositório
              <ArrowUpRight className="h-4 w-4" aria-hidden />
            </a>
          </div>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */
/* Closer                                                              */
/* ------------------------------------------------------------------ */

export function Fim() {
  return (
    <section id="fim" className="relative scroll-mt-16 pb-24 pt-8 sm:pb-32">
      <div className={CONTAINER}>
        <div className={cn(PANEL, "c4-dots overflow-hidden")}>
          <div className="grid gap-8 bg-gradient-to-b from-transparent to-ink-2 p-6 sm:p-10 lg:grid-cols-12 lg:items-end lg:p-14">
            <div className="lg:col-span-7">
              <p className={MONO}>Pronto?</p>
              <h2 className="mt-4 font-display text-[clamp(2.2rem,5vw,4rem)] font-bold leading-[1.02] tracking-[-0.025em] text-balance">
                Agora é montar a sala de verdade.
              </h2>
              <p className="mt-4 max-w-md text-base leading-relaxed text-paper-muted sm:text-lg">
                Escolhe o nome e os canais de novo, dentro do app, e manda o link pra galera.
              </p>
            </div>
            <div className="lg:col-span-5">
              <div className="flex flex-col gap-2 sm:flex-row lg:justify-end">
                <JoinButton intent={IMPORT_INTENT} className={cn(BTN_SECONDARY, "bg-ink/60")}>
                  Trazer do Discord
                </JoinButton>
                <JoinButton intent={CREATE_INTENT} className={BTN_PRIMARY}>
                  Criar a sala de verdade
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </JoinButton>
              </div>
              <p className="mt-3 text-sm text-paper-muted lg:text-right">
                Grátis, sem cartão. Entra com Google, Apple ou Twitch.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
