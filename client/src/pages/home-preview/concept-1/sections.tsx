import { ArrowRight } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { type LiveState, REGIONS, type RegionId } from "@/lib/where-we-run";
import { IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { ageLabel, useLiveStatus } from "../shared/live-status";
import { BTN_PRIMARY, H2, Hi, LINK, Lede, Reveal, Shell, Tag } from "./ui";

/* ------------------------------------------------------------------ */
/* 01  Vem junto, não vem                                               */
/* ------------------------------------------------------------------ */

interface Item {
  title: string;
  note?: string;
}

const COMES: Item[] = [
  { title: "Nome e ícone do servidor" },
  { title: "Categorias", note: "Na mesma ordem da barra lateral." },
  { title: "Canais de texto e de voz", note: "Na mesma ordem." },
  { title: "Tópicos dos canais" },
  { title: "Cargos", note: "Nome, cor e permissões. Administrador nunca vem." },
  { title: "Canais privados", note: "Com quem pode ver, escrever e entrar." },
];

const STAYS: Item[] = [
  { title: "Membros", note: "Cada pessoa entra pelo convite do pqp." },
  { title: "Mensagens e anexos", note: "O histórico fica no Discord." },
  { title: "Emoji e figurinhas personalizados", note: "Dá pra criar de novo no pqp." },
  { title: "Soundboard" },
  { title: "Webhooks", note: "Os do pqp são compatíveis com os do Discord." },
  { title: "Banimentos" },
  { title: "Convites do Discord" },
];

function Ledger({
  title,
  kicker,
  items,
  tone,
  className,
}: {
  title: string;
  kicker: string;
  items: Item[];
  tone: "in" | "out";
  className?: string;
}) {
  return (
    <div className={className}>
      <h3
        className={cn(
          "font-display text-3xl font-bold tracking-[-0.02em] sm:text-4xl",
          tone === "in" ? "text-signal" : "text-zinc-400",
        )}
      >
        {title}
      </h3>
      <p className="mt-1 text-sm text-paper-muted">{kicker}</p>
      <ul className="mt-8">
        {items.map((item) => (
          <li key={item.title} className="flex gap-4 border-t border-white/10 py-4">
            <span
              aria-hidden
              className={cn("mt-[0.7em] h-1.5 w-1.5 shrink-0 rounded-full", tone === "in" ? "bg-signal" : "bg-zinc-600")}
            />
            <div className="min-w-0">
              <p
                className={cn(
                  "font-display text-lg font-semibold leading-snug sm:text-xl",
                  tone === "in" ? "text-paper" : "text-zinc-400",
                )}
              >
                {item.title}
              </p>
              {item.note && <p className="mt-1 text-sm leading-relaxed text-paper-muted">{item.note}</p>}
            </div>
          </li>
        ))}
        <li aria-hidden className="border-t border-white/10" />
      </ul>
    </div>
  );
}

const BEFORE_PASTING: { title: string; body: ReactNode }[] = [
  {
    title: "No Discord",
    body: "Abre as configurações do servidor, vai na aba do modelo, cria o modelo e copia o link (discord.new/…).",
  },
  {
    title: "Quem pode",
    body: "O dono do servidor ou quem tem a permissão Gerenciar servidor, no computador ou no navegador. O app do celular não cria modelo.",
  },
  {
    title: "No pqp",
    body: "Cola o link, confere a prévia e confirma. A importação roda pela web hoje. O Discord não muda, e dá pra rodar os dois ao mesmo tempo.",
  },
];

export function Junto() {
  return (
    <Shell id="junto" index="01" label="A mudança">
      <Reveal>
        <H2 id="junto-t">
          O que vem junto, e o que <Hi>fica</Hi> no Discord.
        </H2>
        <Lede>
          A importação é oficial: sem bot, sem login do Discord, sem token. Você cola o link do modelo, vê uma prévia do
          que vai ser criado e só então confirma.
        </Lede>
      </Reveal>

      <Reveal className="mt-14 grid gap-14 md:grid-cols-2 md:gap-0" delay={80}>
        <Ledger title="Vem junto" kicker="Chega pronto no pqp." items={COMES} tone="in" className="md:pr-12" />
        <Ledger
          title="Não vem"
          kicker="Fica onde está."
          items={STAYS}
          tone="out"
          className="md:border-l md:border-white/10 md:pl-12"
        />
      </Reveal>

      <Reveal className="mt-20" delay={80}>
        <h3 className="text-[11px] font-semibold uppercase tracking-[0.22em] text-paper-muted">Antes de colar</h3>
        <ol className="mt-5 grid gap-8 md:grid-cols-3 md:gap-10">
          {BEFORE_PASTING.map((step, i) => (
            <li key={step.title} className="border-t border-white/10 pt-4">
              <p className="font-display text-sm font-bold tabular-nums text-paper-muted">0{i + 1}</p>
              <p className="mt-2 font-display text-lg font-semibold">{step.title}</p>
              <p className="mt-2 text-[15px] leading-relaxed text-paper-muted">{step.body}</p>
            </li>
          ))}
        </ol>
        <div className="mt-10 flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <JoinButton intent={IMPORT_INTENT} className={BTN_PRIMARY}>
            Trazer meu servidor
            <ArrowRight className="h-4 w-4" aria-hidden />
          </JoinButton>
          <p className="text-sm text-paper-muted">Grátis, sem cartão. Você vê a prévia antes de criar.</p>
        </div>
      </Reveal>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 02  Tela com som e filme em grupo                                    */
/* ------------------------------------------------------------------ */

const SOUND_ROWS: { where: string; what: string; yes: boolean }[] = [
  { where: "Aba do Chrome ou do Edge", what: "O som vai junto", yes: true },
  { where: "App de computador, no Windows 11", what: "O som do computador vai junto", yes: true },
  { where: "App de computador, no Mac, no Linux e no Windows 10", what: "Só o vídeo", yes: false },
];

export function Tela() {
  return (
    <Shell id="tela" index="02" label="Tela e filme">
      <Reveal>
        <H2 id="tela-t">
          Passa a tela, o som vai junto. <Hi>Depois bota o filme.</Hi>
        </H2>
      </Reveal>

      <div className="mt-14 grid gap-14 lg:grid-cols-2 lg:gap-0">
        <Reveal className="lg:pr-12" delay={60}>
          <h3 className="font-display text-2xl font-bold tracking-[-0.01em]">Tela com som</h3>
          <p className="mt-3 max-w-lg text-[17px] leading-relaxed text-paper-muted">
            Vários compartilhamentos ao mesmo tempo: dois em salas menores, até quatro em salas grandes. A qualidade vai
            de 360p a 1080p. Quem está no celular consegue assistir, e no Android dá pra compartilhar também.
          </p>
          <table className="mt-8 w-full border-collapse text-left">
            <caption className="pb-3 text-left text-[11px] font-semibold uppercase tracking-[0.22em] text-paper-muted">
              Quando o som vai junto
            </caption>
            <tbody>
              {SOUND_ROWS.map((row) => (
                <tr key={row.where} className="border-t border-white/10">
                  <th scope="row" className="py-3 pr-4 text-left text-[15px] font-normal leading-snug text-paper">
                    {row.where}
                  </th>
                  <td
                    className={cn(
                      "py-3 text-right text-[15px] leading-snug",
                      row.yes ? "font-medium text-signal" : "text-paper-muted",
                    )}
                  >
                    {row.what}
                  </td>
                </tr>
              ))}
              <tr aria-hidden className="border-t border-white/10">
                <td colSpan={2} />
              </tr>
            </tbody>
          </table>
        </Reveal>

        <Reveal className="lg:border-l lg:border-white/10 lg:pl-12" delay={140}>
          <div className="flex flex-wrap items-center gap-3">
            <h3 className="font-display text-2xl font-bold tracking-[-0.01em]">Filme em grupo</h3>
            <Tag tone="lime">acesso antecipado</Tag>
          </div>
          <p className="mt-3 max-w-lg text-[17px] leading-relaxed text-paper-muted">
            Mais de 100 pessoas assistiram juntas na mesma sala em 5 de setembro de 2026. O recurso é liberado servidor
            por servidor.{" "}
            <Link to="/watch-party" className={LINK}>
              Entrar na lista de espera
            </Link>
            .
          </p>
          <figure className="mt-8">
            <div className="overflow-hidden rounded-xl border border-white/10 bg-rail">
              <img
                src="/images/streamers/watch-pt-BR-720.webp"
                alt="Captura do pqp: um filme ocupa a tela e o chat fica ao lado."
                width={720}
                height={450}
                loading="lazy"
                decoding="async"
                className="block h-auto w-full"
              />
            </div>
            <figcaption className="mt-3 flex items-center gap-2 text-xs text-paper-muted">
              <Tag>exemplo</Tag>
              Captura do pqp.
            </figcaption>
          </figure>
        </Reveal>
      </div>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 03  Voz em São Paulo, Miami e Londres                                */
/* ------------------------------------------------------------------ */

const CITY: Record<RegionId, string> = { gru: "São Paulo", mia: "Miami", lhr: "Londres" };

const STATE_VIEW: Record<LiveState, { label: string; dot: string; text: string }> = {
  operational: { label: "No ar", dot: "bg-success", text: "text-paper" },
  degraded: { label: "Instável", dot: "bg-warning", text: "text-paper" },
  down: { label: "Fora do ar", dot: "bg-danger", text: "text-paper" },
  unknown: { label: "Sem leitura", dot: "border border-paper-muted", text: "text-paper-muted" },
};

export function Voz() {
  const reading = useLiveStatus();
  const checking = reading === null;
  const failed = reading === "unavailable";
  const live = reading && reading !== "unavailable" ? reading : null;

  return (
    <Shell id="voz" index="03" label="Voz">
      <Reveal>
        <H2 id="voz-t">
          Voz em São Paulo, Miami e <Hi>Londres</Hi>.
        </H2>
        <Lede>
          Calls maiores passam por um servidor de voz em São Paulo, Miami ou Londres, o mais perto de onde está a maioria
          das pessoas daquele servidor. DMs e servidores pequenos falam direto entre as pessoas.
        </Lede>
      </Reveal>

      <Reveal className="mt-12 max-w-3xl" delay={80}>
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Estado dos três servidores de voz, lido de /status.json</caption>
          <thead>
            <tr className="text-[11px] font-semibold uppercase tracking-[0.2em] text-paper-muted">
              <th scope="col" className="pb-3 text-left font-semibold">
                Cidade
              </th>
              <th scope="col" className="hidden pb-3 text-left font-semibold sm:table-cell">
                O quê
              </th>
              <th scope="col" className="pb-3 text-right font-semibold">
                Agora
              </th>
            </tr>
          </thead>
          <tbody>
            {REGIONS.map((region) => {
              const view = live ? STATE_VIEW[live.regions[region.id]] : null;
              return (
                <tr key={region.id} className="border-t border-white/10">
                  <th scope="row" className="py-4 pr-4 text-left font-display text-xl font-semibold sm:text-2xl">
                    {CITY[region.id]}
                  </th>
                  <td className="hidden py-4 pr-4 text-[15px] text-paper-muted sm:table-cell">Servidor de voz</td>
                  <td className="py-4 text-right text-[15px]">
                    {view ? (
                      <span className={cn("inline-flex items-center gap-2.5", view.text)}>
                        <span aria-hidden className={cn("h-2 w-2 rounded-full", view.dot)} />
                        {view.label}
                      </span>
                    ) : (
                      <span className="text-paper-muted">{checking ? "Lendo o status…" : "Sem leitura"}</span>
                    )}
                  </td>
                </tr>
              );
            })}
            <tr aria-hidden className="border-t border-white/10">
              <td colSpan={3} />
            </tr>
          </tbody>
        </table>

        <div className="mt-5 text-sm leading-relaxed text-paper-muted" aria-live="polite">
          {failed && (
            <p>
              Não deu pra ler o status agora. Isso não quer dizer que algo caiu, só que esta página não conseguiu
              perguntar.{" "}
              <Link to="/status" className={LINK}>
                Ver o status completo
              </Link>
              .
            </p>
          )}
          {live && (
            <p>
              Leitura de {ageLabel(live.checkedAt)}. Só aparece &ldquo;No ar&rdquo; quando o servidor responde que está.{" "}
              <Link to="/status" className={LINK}>
                Ver o status completo
              </Link>
              .
            </p>
          )}
          {checking && <p>Perguntando pro /status.json.</p>}
        </div>

        <p className="mt-8 max-w-xl border-t border-white/10 pt-5 text-sm leading-relaxed text-paper-muted">
          A API e o banco de dados também ficam em São Paulo. Os backups noturnos ficam na América do Norte.
        </p>
      </Reveal>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 04  O que ainda não temos                                            */
/* ------------------------------------------------------------------ */

const MISSING: Item[] = [
  { title: "Histórico de mensagens e membros", note: "A importação traz a estrutura. As mensagens ficam no Discord." },
  { title: "Importar pelo celular", note: "A importação roda pela web hoje." },
  { title: "App no iPhone", note: "Está em beta, pelo TestFlight." },
  { title: "Filme em grupo para todo mundo", note: "É acesso antecipado, liberado servidor por servidor." },
  { title: "Bots e integrações", note: "Estão só começando." },
  { title: "Som em toda tela compartilhada", note: "Depende do navegador e do sistema, como mostra a tabela acima." },
];

const DISCORD_BETTER: Item[] = [
  { title: "Apps nativos", note: "Maduros e muito bons, no computador e no celular." },
  { title: "Bots e integrações", note: "Um ecossistema gigante." },
  { title: "Maturidade", note: "O pqp é um beta aberto. O Discord tem dez anos de estrada." },
];

interface CompareRow {
  label: string;
  pqp: string;
  discord: string;
}

/** The claims of /vs-discord that match what pqp does today. */
const COMPARE: CompareRow[] = [
  { label: "Preço", pqp: "De graça", discord: "De graça (recursos pagos via Nitro)" },
  { label: "Código aberto", pqp: "Sim", discord: "Não" },
  { label: "Rodar no seu próprio servidor", pqp: "Sim", discord: "Não" },
  {
    label: "Apps nativos (desktop e celular)",
    pqp: "Desktop já tem. Android já está na Google Play. iPhone em beta pelo TestFlight.",
    discord: "Sim, e são ótimos",
  },
  { label: "Ecossistema (bots, integrações)", pqp: "Começando", discord: "Gigante" },
  { label: "Maturidade", pqp: "Beta aberto", discord: "Dez anos de estrada" },
  { label: "Servidores no Brasil", pqp: "Sim", discord: "Sim" },
];

function PlainList({ items }: { items: Item[] }) {
  return (
    <ul className="mt-6">
      {items.map((item) => (
        <li key={item.title} className="border-t border-white/10 py-4">
          <p className="font-display text-lg font-semibold leading-snug">{item.title}</p>
          {item.note && <p className="mt-1 text-[15px] leading-relaxed text-paper-muted">{item.note}</p>}
        </li>
      ))}
      <li aria-hidden className="border-t border-white/10" />
    </ul>
  );
}

export function Limites() {
  return (
    <Shell id="limites" index="04" label="O que falta">
      <Reveal>
        <H2 id="limites-t">O que o pqp ainda não faz.</H2>
        <Lede>Melhor saber antes de mudar. Se a sua galera depende de algo daqui hoje, vale rodar os dois por um tempo.</Lede>
      </Reveal>

      <Reveal className="mt-14 grid gap-14 lg:grid-cols-2 lg:gap-0" delay={60}>
        <div className="lg:pr-12">
          <h3 className="font-display text-2xl font-bold tracking-[-0.01em]">O que ainda não temos</h3>
          <PlainList items={MISSING} />
        </div>
        <div className="lg:border-l lg:border-white/10 lg:pl-12">
          <h3 className="font-display text-2xl font-bold tracking-[-0.01em]">O que o Discord faz melhor hoje</h3>
          <PlainList items={DISCORD_BETTER} />
        </div>
      </Reveal>

      <Reveal className="mt-20" delay={60}>
        <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
          <h3 className="font-display text-2xl font-bold tracking-[-0.01em]">Lado a lado, em poucas linhas</h3>
          <p className="text-sm text-paper-muted">Conferido em 16 de outubro de 2026</p>
        </div>

        <table className="mt-6 w-full border-collapse text-left">
          <caption className="sr-only">Comparação rápida entre o pqp e o Discord, conferida em 16 de outubro de 2026</caption>
          <thead className="hidden sm:table-header-group">
            <tr className="text-[11px] font-semibold uppercase tracking-[0.2em]">
              <th scope="col" className="w-[34%] pb-3 pr-6 text-left font-semibold text-paper-muted">
                Coisa
              </th>
              <th scope="col" className="w-[36%] pb-3 pr-6 text-left font-semibold text-signal">
                pqp
              </th>
              <th scope="col" className="pb-3 text-left font-semibold text-zinc-400">
                Discord
              </th>
            </tr>
          </thead>
          <tbody>
            {COMPARE.map((row) => (
              <tr key={row.label} className="grid grid-cols-2 gap-x-6 border-t border-white/10 py-4 sm:table-row">
                <th
                  scope="row"
                  className="col-span-2 mb-2 text-left text-[15px] font-medium leading-snug text-paper sm:mb-0 sm:table-cell sm:py-4 sm:pr-6"
                >
                  {row.label}
                </th>
                <td className="min-w-0 text-[15px] leading-snug text-paper sm:table-cell sm:py-4 sm:pr-6">
                  <span aria-hidden className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-signal sm:hidden">
                    pqp
                  </span>
                  {row.pqp}
                </td>
                <td className="min-w-0 text-[15px] leading-snug text-zinc-400 sm:table-cell sm:py-4">
                  <span aria-hidden className="mb-1 block text-[10px] font-semibold uppercase tracking-[0.18em] text-zinc-500 sm:hidden">
                    Discord
                  </span>
                  {row.discord}
                </td>
              </tr>
            ))}
            <tr aria-hidden className="border-t border-white/10">
              <td colSpan={3} />
            </tr>
          </tbody>
        </table>

        <p className="mt-5 text-sm leading-relaxed text-paper-muted">
          Cada linha é uma afirmação sobre os dois produtos nesta data. Produtos mudam.{" "}
          <Link to="/vs-discord" className={LINK}>
            Veja a comparação completa
          </Link>
          .
        </p>
      </Reveal>
    </Shell>
  );
}

/* ------------------------------------------------------------------ */
/* 05  Código aberto                                                    */
/* ------------------------------------------------------------------ */

const OPEN_FACTS: { term: string; body: ReactNode }[] = [
  { term: "De graça", body: "Sem plano pago e sem cartão. Doar não desbloqueia nada." },
  { term: "Quem ajuda", body: "Quem quiser ajudar com a hospedagem pode doar." },
  { term: "Quem faz", body: "Dois irmãos. O pqp está em beta aberto." },
];

export function Codigo() {
  return (
    <Shell id="codigo" index="05" label="Código aberto">
      <Reveal>
        <H2 id="codigo-t">O código é público. Quem quiser pode conferir.</H2>
        <Lede>
          O pqp é de código aberto, sob a licença AGPL. Você pode ler o código, exportar os seus dados ou rodar a sua
          própria cópia na sua máquina. Uma cópia sem servidor de mídia aguenta cerca de oito pessoas por canal de voz.
        </Lede>
      </Reveal>

      <Reveal className="mt-12" delay={60}>
        <dl className="max-w-3xl">
          {OPEN_FACTS.map((fact) => (
            <div key={fact.term} className="grid gap-1 border-t border-white/10 py-4 sm:grid-cols-[200px_minmax(0,1fr)] sm:gap-6">
              <dt className="font-display text-lg font-semibold">{fact.term}</dt>
              <dd className="text-[15px] leading-relaxed text-paper-muted">{fact.body}</dd>
            </div>
          ))}
          <div aria-hidden className="border-t border-white/10" />
        </dl>
        <p className="mt-8 flex flex-wrap items-center gap-x-6 gap-y-3 text-[15px]">
          <a
            href={SOURCE_REPO_URL}
            target="_blank"
            rel="noreferrer noopener"
            className={cn(LINK, "inline-flex min-h-10 items-center [overflow-wrap:anywhere]")}
          >
            Ver o código no GitHub
          </a>
          <Link to="/apoie" className={cn(LINK, "inline-flex min-h-10 items-center")}>
            Como o pqp se paga
          </Link>
        </p>
      </Reveal>
    </Shell>
  );
}
