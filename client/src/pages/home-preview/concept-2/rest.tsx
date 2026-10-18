import { ArrowRight, Check, GitBranch, Server, X } from "lucide-react";
import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { BTN, CONTAINER, Drift, ExampleTag, Halftone, Kicker, LINK, Paste, Sheet, Stamp, Tape } from "./ui";

function Row({ ok, children }: { ok: boolean; children: ReactNode }) {
  const Icon = ok ? Check : X;
  return (
    <li className="flex gap-2.5">
      <Icon className="mt-1 h-4 w-4 shrink-0" strokeWidth={3} aria-hidden />
      <span>{children}</span>
    </li>
  );
}

/* ------------------------------------------------------------------ */

export function ImportPoster() {
  return (
    <section id="import" aria-labelledby="import-h" className="relative scroll-mt-16 py-16 sm:py-24">
      <div className={CONTAINER}>
        <Paste r="-0.6deg">
          <Sheet tone="paper" crease torn className="px-6 pb-14 pt-10 sm:px-10 sm:pb-16 sm:pt-12 lg:px-14">
            <Drift className="absolute -top-3 left-1/4" amp={10}>
              <Tape tone="lime" w={110} r={-3} />
            </Drift>
            <div className="grid gap-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-14">
              <div>
                <Kicker>Vindo do Discord</Kicker>
                <h2 id="import-h" className="mt-3 font-brand text-[clamp(2.3rem,8.6vw,5rem)] uppercase leading-[0.95] tracking-[-0.03em]">
                  <span className="block">Traz o servidor</span>
                  <span className="mt-[0.06em] inline-block bg-ink px-[0.12em] pb-[0.04em] pt-[0.02em] text-signal">do Discord.</span>
                </h2>
                <p className="mt-6 max-w-xl text-lg leading-snug">
                  Cola o link de modelo do servidor (o discord.new/...). Você vê uma prévia antes de criar. É a importação oficial: sem bot, sem login no Discord, sem token.
                </p>

                <div className="mt-8 grid gap-6 sm:grid-cols-2">
                  <div className="border-[3px] border-ink p-5">
                    <p className="font-display text-sm font-extrabold uppercase tracking-[0.16em]">Vem junto</p>
                    <ul className="mt-3 space-y-2 text-[15px] leading-snug">
                      <Row ok>Nome e ícone</Row>
                      <Row ok>Categorias e canais de texto e voz, na mesma ordem</Row>
                      <Row ok>Tópicos dos canais</Row>
                      <Row ok>Cargos, com nome, cor e permissões (nunca Administrador)</Row>
                      <Row ok>Canais privados e quem pode ver, escrever e entrar</Row>
                    </ul>
                  </div>
                  <div className="border-[3px] border-dashed border-ink/60 p-5">
                    <p className="font-display text-sm font-extrabold uppercase tracking-[0.16em]">Não vem</p>
                    <ul className="mt-3 space-y-2 text-[15px] leading-snug text-ink/80">
                      <Row ok={false}>Membros (a galera entra por convite)</Row>
                      <Row ok={false}>Mensagens e anexos</Row>
                      <Row ok={false}>Emoji e figurinhas personalizados</Row>
                      <Row ok={false}>Soundboard, webhooks e bans</Row>
                      <Row ok={false}>Convites do Discord</Row>
                    </ul>
                  </div>
                </div>

                <p className="mt-6 max-w-xl text-[15px] leading-snug text-ink/80">
                  O link de modelo precisa ser feito pelo dono ou por quem tem &quot;Gerenciar servidor&quot;, no computador ou no navegador (o app de celular do Discord não cria). Por enquanto a importação roda na web. O seu servidor no Discord não muda: dá pra usar os dois ao mesmo tempo.
                </p>
                <div className="mt-7 flex flex-wrap items-center gap-x-5 gap-y-3">
                  <JoinButton intent={IMPORT_INTENT} className={BTN.inkOnPaper}>
                    Importar meu servidor
                    <ArrowRight className="h-4 w-4" aria-hidden />
                  </JoinButton>
                  <Link to="/vs-discord" className={LINK.paper}>
                    pqp e Discord lado a lado
                  </Link>
                </div>
              </div>

              <figure className="relative mx-auto w-full max-w-[420px] lg:mt-4">
                <div className="c2-photo rotate-2 bg-ink">
                  <img
                    src="/images/product/import.webp"
                    width={1344}
                    height={1820}
                    loading="lazy"
                    decoding="async"
                    alt="Captura real da tela de importação do pqp, com a prévia dos canais e cargos que vêm do modelo do Discord."
                    className="block h-auto w-full"
                  />
                </div>
                <Drift className="absolute -top-3 left-6" amp={-10}>
                  <Tape tone="dark" w={80} r={-8} />
                </Drift>
                <Drift className="absolute -bottom-4 -left-3 sm:-left-6" amp={12}>
                  <Stamp r={-8} className="bg-paper text-[12px] text-ink sm:text-[13px]">
                    Prévia antes de criar
                  </Stamp>
                </Drift>
              </figure>
            </div>
          </Sheet>
        </Paste>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

const NOTES = [
  {
    from: "@bia",
    body: "Ninguém fica no vácuo na call da Bia. Se ela sumir, a gente já sabe: tá ouvindo música e esqueceu de desmutar.",
    r: -2.5,
    tape: -6,
  },
  {
    from: "@caio",
    body: "Ele caiu três vezes na mesma partida e jura que foi a internet. Nota dez em criatividade, zero em mira.",
    r: 1.8,
    tape: 5,
  },
  {
    from: "@nico",
    body: "Melhor mestre de RPG que eu conheço. Aceita qualquer rolagem, até a que ele inventou agora.",
    r: -1.2,
    tape: -3,
  },
];

export function Mural() {
  return (
    <section id="mural" aria-labelledby="mural-h" className="relative scroll-mt-16 py-16 sm:py-24">
      <div aria-hidden className="pointer-events-none absolute inset-y-0 right-0 hidden w-1/3 overflow-hidden text-signal/15 lg:block">
        <Halftone cols={40} rows={60} shape="left" max={4.4} />
      </div>
      <div className={cn(CONTAINER, "relative")}>
        <div className="grid gap-8 lg:grid-cols-[0.8fr_1.2fr] lg:gap-14">
          <div className="lg:sticky lg:top-24 lg:self-start">
            <Kicker className="text-signal">O mural</Kicker>
            <h2 id="mural-h" className="mt-3 font-display text-4xl font-extrabold leading-[1.02] tracking-tight sm:text-6xl">
              Seus amigos escrevem no seu mural.
            </h2>
            <p className="mt-5 max-w-md text-lg leading-snug text-paper-muted">
              Seu perfil em <span className="font-handle text-paper">pqp.gg/@voce</span> tem uma parede de depoimentos, no estilo Orkut. Os amigos escrevem e só aparece o que você aprovar.
            </p>
            <p className="mt-3 flex flex-wrap items-center gap-2 text-sm text-paper-muted">
              <ExampleTag className="text-signal" /> Os bilhetes ao lado são só exemplos do que dá pra escrever.
            </p>
            <Link to="/garanta" className={cn(LINK.ink, "mt-5")}>
              Garantir meu @
              <ArrowRight className="h-4 w-4" aria-hidden />
            </Link>
          </div>

          <ul className="grid gap-10 sm:grid-cols-2 sm:gap-x-8 sm:gap-y-12">
            {NOTES.map((n, i) => (
              <li key={n.from} className={cn(i === 2 && "sm:col-span-2 sm:mx-auto sm:w-[calc(50%+1rem)]")}>
                <Paste r={`${n.r}deg`} delay={i * 90}>
                  <Sheet tone="paper" className="px-5 pb-6 pt-8 shadow-[0_18px_30px_-18px_color-mix(in_oklch,black_80%,transparent)]">
                    <Drift className="absolute -top-3 left-1/2 -translate-x-1/2" amp={8 + i * 2}>
                      <Tape tone="light" w={74} r={n.tape} />
                    </Drift>
                    <div className="mb-2 flex items-center justify-between">
                      <ExampleTag className="text-ink" />
                      <span className="font-display text-[11px] font-bold uppercase tracking-[0.16em] text-ink/60">Depoimento</span>
                    </div>
                    <p className="c2-ruled font-display text-[17px] font-medium">{n.body}</p>
                    <p className="mt-3 text-right font-handle text-lg font-bold">{n.from}</p>
                  </Sheet>
                </Paste>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

export function Codigo() {
  return (
    <section id="codigo" aria-labelledby="codigo-h" className="relative scroll-mt-16 py-16 sm:py-24">
      <div className={CONTAINER}>
        <Paste r="0.5deg">
          <Sheet tone="ink" className="overflow-hidden px-6 pb-28 pt-10 sm:px-12 sm:pb-32 sm:pt-14">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 text-signal/30">
              <Halftone cols={90} rows={8} shape="up" max={4.4} />
            </div>
            <div className="relative grid gap-10 lg:grid-cols-[1.1fr_0.9fr] lg:gap-16">
              <div>
                <Stamp r={-4} className="text-[14px] text-signal sm:text-[16px]">
                  AGPL
                </Stamp>
                <h2 id="codigo-h" className="mt-6 font-display text-4xl font-extrabold leading-[1.02] tracking-tight sm:text-6xl">
                  O código é público.
                </h2>
                <p className="mt-5 max-w-xl text-lg leading-relaxed text-paper-muted">
                  O pqp é de graça e tem código aberto, sob a licença AGPL. Foi feito por dois irmãos. Qualquer pessoa pode ler o código, exportar os próprios dados ou rodar uma cópia na própria máquina.
                </p>
                <div className="mt-7 flex flex-wrap items-center gap-x-6 gap-y-3">
                  <a href={SOURCE_REPO_URL} target="_blank" rel="noopener noreferrer" className={BTN.lime}>
                    <GitBranch className="h-4 w-4" aria-hidden />
                    Ver o código
                  </a>
                  <Link to="/apoie" className={LINK.ink}>
                    Como apoiar (não desbloqueia nada)
                  </Link>
                </div>
              </div>
              <div className="space-y-5 text-[15px] leading-relaxed text-paper-muted">
                <p className="flex gap-3">
                  <Server className="mt-1 h-5 w-5 shrink-0 text-signal" aria-hidden />
                  <span>
                    Uma cópia sua, sem servidor de mídia, aguenta cerca de oito pessoas por canal de voz. Chamadas maiores pedem o servidor de voz.
                  </span>
                </p>
                <div className="border-t border-paper/15 pt-5">
                  <p className="font-display text-xs font-bold uppercase tracking-[0.18em] text-paper">O que ainda não tem</p>
                  <ul className="mt-3 list-disc space-y-1.5 pl-5">
                    <li>O app de iPhone ainda é beta, pelo TestFlight.</li>
                    <li>Bots e integrações estão começando.</li>
                    <li>A importação traz a estrutura, não o histórico.</li>
                  </ul>
                </div>
              </div>
            </div>
          </Sheet>
        </Paste>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------------ */

export function Closer() {
  return (
    <section aria-labelledby="fim-h" className="relative py-16 sm:py-24">
      <div className={CONTAINER}>
        <Paste r="-1.2deg">
          <Sheet tone="lime" crease className="overflow-hidden px-6 pb-28 pt-12 text-center sm:px-12 sm:pb-32 sm:pt-20">
            <div aria-hidden className="pointer-events-none absolute inset-x-0 bottom-0 h-20 text-ink/25">
              <Halftone cols={90} rows={8} shape="up" max={4.4} />
            </div>
            <Drift className="absolute -top-2 left-8" amp={10}>
              <Tape tone="light" w={100} r={-7} />
            </Drift>
            <Drift className="absolute -top-2 right-8" amp={-10}>
              <Tape tone="light" w={90} r={6} />
            </Drift>
            <div className="relative">
              <h2 id="fim-h" className="font-brand text-[clamp(3.2rem,13vw,9.5rem)] uppercase leading-[0.86] tracking-[-0.04em]">
                Chama a
                <br />
                galera.
              </h2>
              <p className="mx-auto mt-6 max-w-lg text-lg leading-snug">Cria a sala da galera ou traz o servidor que vocês já têm.</p>
              <div className="mt-8 flex flex-wrap justify-center gap-x-5 gap-y-4">
                <JoinButton intent={CREATE_INTENT} className={BTN.inkOnLime}>
                  Criar a sala da galera
                  <ArrowRight className="h-4 w-4" aria-hidden />
                </JoinButton>
                <JoinButton intent={IMPORT_INTENT} className={BTN.paperOnLime}>
                  Trazer do Discord
                </JoinButton>
              </div>
              <p className="mt-5 text-sm font-medium">Grátis, sem cartão. Entra com Google, Apple ou Twitch.</p>
              <div className="mx-auto mt-4 w-fit max-w-full rounded-md bg-ink px-4 py-2.5">
                <HeroDownload tone="ink" />
              </div>
            </div>
          </Sheet>
        </Paste>
      </div>
    </section>
  );
}
