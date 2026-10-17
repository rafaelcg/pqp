import {
  ArrowRight,
  ArrowUpRight,
  Check,
  CircleDashed,
  Globe,
  Link2,
  MonitorUp,
  Mic,
  MicOff,
  Pin,
  Play,
  Plus,
  Radio,
  RefreshCw,
  SlidersHorizontal,
  Volume2,
  VolumeX,
  X,
  type LucideIcon,
} from "lucide-react";
import { type ReactNode, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { HeroDownload } from "@/components/marketing/hero-download";
import { SOURCE_REPO_URL } from "@/lib/downloads";
import {
  GRID,
  SAMPLE_CALLERS,
  arcPath,
  landDotsPath,
  project,
  regionById,
  type LiveState,
  type RegionId,
} from "@/lib/where-we-run";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { ageLabel, useLiveStatus } from "../shared/live-status";
import {
  AppWindow,
  CAST,
  CallTile,
  SectionLabel,
  SoundBars,
  TextChannel,
  VoiceChannel,
  type Person,
} from "../shared/mock";
import { useReducedMotion } from "../shared/motion";
import { BTN_PRIMARY, BTN_SECONDARY, FOCUS_RING } from "./data";
import { useOnScreen } from "./hooks";
import { Exemplo } from "./thread";

/* -------------------------------------------------------------------------- */
/* The card frame                                                              */

const SMALL_LINK =
  "text-paper underline decoration-paper-muted/40 underline-offset-4 transition-colors hover:text-signal hover:decoration-signal/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal rounded-sm";

function ChapterCard({
  id,
  icon: Icon,
  title,
  tag,
  children,
}: {
  id: string;
  icon: LucideIcon;
  title: ReactNode;
  tag?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section
      aria-labelledby={`${id}-h`}
      className="@container overflow-hidden rounded-2xl border border-white/10 bg-ink-2/70 shadow-[0_28px_70px_-40px_black]"
    >
      <header className="flex items-center gap-3 border-b border-white/[0.07] px-4 py-3.5 sm:px-5">
        <span className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-signal/10 text-signal ring-1 ring-inset ring-signal/20">
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <h2
          id={`${id}-h`}
          className="min-w-0 flex-1 text-balance font-display text-[19px] font-bold leading-tight tracking-[-0.01em] sm:text-[22px]"
        >
          {title}
        </h2>
        {tag}
      </header>
      {children}
    </section>
  );
}

function H3({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <h3 className={cn("text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted", className)}>
      {children}
    </h3>
  );
}

function IconChip({ icon: Icon }: { icon: LucideIcon }) {
  return (
    <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-white/[0.06] text-paper">
      <Icon className="h-4 w-4" aria-hidden />
    </span>
  );
}

/* -------------------------------------------------------------------------- */
/* 0. The pinned message: where the buttons live                              */

export function PinnedCard() {
  return (
    <section
      aria-label="Mensagem fixada: como entrar"
      className="overflow-hidden rounded-2xl border border-signal/25 bg-gradient-to-br from-signal/[0.09] to-ink-2/40"
    >
      <p className="flex items-center gap-2 border-b border-signal/15 px-4 py-2.5 text-xs font-medium text-paper-muted sm:px-5">
        <Pin className="h-3.5 w-3.5 text-signal" aria-hidden />
        <span>
          Mensagem fixada <span className="text-paper-muted/70">por pqp</span>
        </span>
      </p>
      <div className="p-4 sm:p-5">
        <p className="font-display text-[19px] font-bold tracking-[-0.01em] sm:text-xl">Pra entrar na conversa:</p>
        <div className="mt-4 flex flex-col gap-3 sm:flex-row">
          <JoinButton intent={CREATE_INTENT} className={BTN_PRIMARY}>
            Criar a sala da galera
            <ArrowRight className="h-4 w-4" aria-hidden />
          </JoinButton>
          <JoinButton intent={IMPORT_INTENT} className={BTN_SECONDARY}>
            Trazer do Discord
          </JoinButton>
        </div>
        <p className="mt-4 text-sm text-paper-muted">Grátis, sem cartão. Entra com Google, Apple ou Twitch.</p>
        <HeroDownload tone="ink" className="mt-2" />
        <p className="mt-3 border-t border-white/[0.07] pt-3 text-xs leading-relaxed text-paper-muted">
          O filme em grupo (watch party) está em acesso antecipado, liberado servidor por servidor.
        </p>
      </div>
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* 1. "cai na call?": a live call card                                         */

const YOU: Person = { name: "Você", tone: "plain" };

const CALL_FACTS: { icon: LucideIcon; title: string; body: string }[] = [
  { icon: Mic, title: "Push-to-talk ou voz ativa", body: "Você escolhe como o microfone abre." },
  { icon: SlidersHorizontal, title: "Volume e mudo por pessoa", body: "Aquele amigo alto demais fica no seu controle." },
  {
    icon: RefreshCw,
    title: "A call volta se a página recarregar",
    body: "No site e no desktop, a call costuma continuar de pé.",
  },
  { icon: Globe, title: "Nada pra instalar", body: "Roda no navegador. Tem app pra quem prefere." },
];

export function CallCard() {
  const reduced = useReducedMotion();
  const [rootRef, onScreen] = useOnScreen<HTMLDivElement>();
  const [joined, setJoined] = useState(false);
  const [muted, setMuted] = useState(false);
  const [tick, setTick] = useState(0);
  const friends = [CAST.bia, CAST.caio, CAST.nico];

  useEffect(() => {
    if (reduced || !onScreen) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1500);
    return () => window.clearInterval(id);
  }, [reduced, onScreen]);

  const speaker = friends[tick % friends.length].name;

  return (
    <ChapterCard id="card-call" icon={Volume2} title="Cai na call. É só entrar." tag={<Exemplo />}>
      <div ref={rootRef} className="grid gap-5 p-4 sm:p-5 @lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)] @lg:gap-6">
        <div>
          <div className="rounded-xl bg-rail p-2.5 ring-1 ring-inset ring-white/5">
            <p className="flex items-center gap-1.5 px-1 pb-2 text-xs text-paper-muted">
              <Volume2 className="h-3.5 w-3.5 text-signal" aria-hidden />
              <span className="font-medium text-paper">Lobby</span>
              <span aria-live="polite">{joined ? "4 na call" : "3 na call"}</span>
            </p>
            <div className="grid grid-cols-2 gap-2">
              {friends.map((p) => (
                <CallTile key={p.name} person={p} speaking={speaker === p.name} className="aspect-[4/3]" />
              ))}
              {joined ? (
                <CallTile person={YOU} muted={muted} className="hp-pop aspect-[4/3] border-signal/30" />
              ) : (
                <button
                  type="button"
                  onClick={() => setJoined(true)}
                  className={cn(
                    "group grid aspect-[4/3] place-items-center rounded-xl border border-dashed border-white/20 text-paper-muted transition-colors hover:border-signal/60 hover:bg-signal/[0.06] hover:text-signal",
                    FOCUS_RING,
                  )}
                >
                  <span className="flex flex-col items-center gap-1.5 px-2 text-center text-[13px] font-medium">
                    <Plus className="h-5 w-5" aria-hidden />
                    Entrar na call
                  </span>
                </button>
              )}
            </div>
            <div className="mt-2.5 flex min-h-11 items-center justify-between gap-2 px-1">
              {joined ? (
                <>
                  <button
                    type="button"
                    aria-pressed={muted}
                    onClick={() => setMuted((m) => !m)}
                    className={cn(
                      "inline-flex h-10 items-center gap-2 rounded-lg px-3 text-[13px] font-medium ring-1 ring-inset transition-colors",
                      muted ? "bg-danger/15 text-danger ring-danger/30" : "bg-white/[0.06] text-paper ring-white/10 hover:bg-white/10",
                      FOCUS_RING,
                    )}
                  >
                    {muted ? <MicOff className="h-4 w-4" aria-hidden /> : <Mic className="h-4 w-4" aria-hidden />}
                    {muted ? "Microfone mudo" : "Microfone aberto"}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setJoined(false);
                      setMuted(false);
                    }}
                    className={cn(
                      "inline-flex h-10 items-center rounded-lg px-3 text-[13px] font-medium text-paper-muted ring-1 ring-inset ring-white/10 transition-colors hover:bg-white/[0.06] hover:text-paper",
                      FOCUS_RING,
                    )}
                  >
                    Sair
                  </button>
                </>
              ) : (
                <p className="px-0.5 text-xs text-paper-muted">Demonstração: ninguém te ouve de verdade.</p>
              )}
            </div>
          </div>
        </div>

        <ul className="flex flex-col gap-4 self-center">
          {CALL_FACTS.map((f) => (
            <li key={f.title} className="flex items-start gap-3">
              <IconChip icon={f.icon} />
              <div className="min-w-0">
                <p className="text-[15px] font-semibold leading-snug">{f.title}</p>
                <p className="mt-0.5 text-sm leading-snug text-paper-muted">{f.body}</p>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </ChapterCard>
  );
}

/* -------------------------------------------------------------------------- */
/* 2. "passa a tela": the share card                                           */

const SHARE_MODES = [
  {
    id: "tab",
    label: "Aba do Chrome ou Edge",
    sound: true,
    note: "O som da aba vai junto.",
  },
  {
    id: "win11",
    label: "App de desktop, Windows 11",
    sound: true,
    note: "O som do computador vai junto.",
  },
  {
    id: "other",
    label: "App de desktop, Mac, Linux ou Windows 10",
    sound: false,
    note: "Vai só o vídeo. Pra levar o som, compartilha uma aba do Chrome ou do Edge.",
  },
] as const;

const SHARE_FACTS = [
  "Qualidade de 360p a 1080p",
  "Duas telas ao mesmo tempo, até quatro em sala grande",
  "Quem tá no celular assiste",
  "No Android dá pra compartilhar",
];

export function ShareCard() {
  const [mode, setMode] = useState<(typeof SHARE_MODES)[number]["id"]>("tab");
  const current = SHARE_MODES.find((m) => m.id === mode) ?? SHARE_MODES[0];

  return (
    <ChapterCard id="card-share" icon={MonitorUp} title="Passa a tela, o som vai junto." tag={<Exemplo />}>
      <div className="grid gap-5 p-4 sm:p-5 @lg:grid-cols-2 @lg:gap-6">
        <div aria-hidden>
          <AppWindow url="aba compartilhada" className="shadow-none" bodyClassName="aspect-video">
            <div className="absolute inset-0 bg-gradient-to-br from-sky-500/25 via-violet-500/10 to-ink-2" />
            <div className="absolute inset-0 grid place-items-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-black/45 text-white">
                <Play className="h-5 w-5 fill-current" />
              </span>
            </div>
            <span className="absolute left-2.5 top-2.5 inline-flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-[11px] text-white">
              <MonitorUp className="h-3 w-3" />
              Nico compartilha
            </span>
            <span
              className={cn(
                "absolute bottom-3.5 right-2.5 inline-flex items-center gap-1.5 rounded-md bg-black/55 px-2 py-1 text-[11px]",
                current.sound ? "text-signal" : "text-paper-muted",
              )}
            >
              {current.sound ? <SoundBars /> : <VolumeX className="h-3 w-3" />}
              {current.sound ? "com som" : "sem som"}
            </span>
            <span className="absolute inset-x-0 bottom-0 h-1 bg-white/15">
              <span className="block h-full w-[38%] bg-signal" />
            </span>
          </AppWindow>
          <p className="sr-only">Exemplo: a tela de uma aba de vídeo, compartilhada na call.</p>
        </div>

        <div className="flex flex-col">
          <H3>Como você compartilha?</H3>
          <div role="group" aria-label="Como você compartilha" className="mt-3 flex flex-col gap-2">
            {SHARE_MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                aria-pressed={m.id === mode}
                onClick={() => setMode(m.id)}
                className={cn(
                  "flex min-h-11 items-center gap-2.5 rounded-xl px-3.5 py-2 text-left text-[14px] font-medium leading-snug ring-1 ring-inset transition-colors",
                  m.id === mode
                    ? "bg-signal/10 text-paper ring-signal/50"
                    : "bg-white/[0.03] text-paper-muted ring-white/10 hover:bg-white/[0.06] hover:text-paper",
                  FOCUS_RING,
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "grid h-4 w-4 shrink-0 place-items-center rounded-full border",
                    m.id === mode ? "border-signal bg-signal text-ink" : "border-white/25",
                  )}
                >
                  {m.id === mode && <Check className="h-3 w-3" strokeWidth={3} />}
                </span>
                {m.label}
              </button>
            ))}
          </div>
          <p
            aria-live="polite"
            className={cn(
              "mt-3 flex items-start gap-2.5 rounded-xl border px-3.5 py-3 text-[14.5px] leading-snug",
              current.sound ? "border-signal/30 bg-signal/[0.06] text-paper" : "border-white/10 bg-white/[0.03] text-paper",
            )}
          >
            {current.sound ? (
              <Volume2 className="mt-0.5 h-4 w-4 shrink-0 text-signal" aria-hidden />
            ) : (
              <VolumeX className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
            )}
            <span>{current.note}</span>
          </p>
        </div>
      </div>
      <ul className="flex flex-wrap gap-2 border-t border-white/[0.07] px-4 py-3.5 sm:px-5">
        {SHARE_FACTS.map((f) => (
          <li
            key={f}
            className="rounded-full border border-white/10 bg-white/[0.03] px-3 py-1 text-xs font-medium text-paper-muted"
          >
            {f}
          </li>
        ))}
      </ul>
    </ChapterCard>
  );
}

/** The watch party follow-up: a plain line with one link. */
export function WatchPartyNote() {
  return (
    <p>
      Quando uma tela só não basta, tem o filme em grupo (watch party): mais de 100 pessoas já assistiram
      juntas numa sala só, em 5 de setembro de 2026. Ainda é acesso antecipado, liberado servidor por
      servidor.{" "}
      <Link to="/watch-party" className={SMALL_LINK}>
        Entrar na lista de espera
      </Link>
      .
    </p>
  );
}

/* -------------------------------------------------------------------------- */
/* 3. "e o servidor do Discord?": the import card                              */

const COMES = [
  "Nome e ícone do servidor",
  "Categorias",
  "Canais de texto e de voz, na mesma ordem",
  "Tópicos dos canais",
  "Cargos: nome, cor e permissões (nunca Administrador)",
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

const STEPS = ["Cola o link do modelo", "Vê a prévia", "Cria a comunidade"];

const SAMPLE_ROLES = [
  { name: "Mestre", dot: "bg-amber-300" },
  { name: "Jogador", dot: "bg-sky-400" },
  { name: "Visitante", dot: "bg-paper-muted" },
];

function stagger(i: number) {
  return { animationDelay: `${i * 70}ms` };
}

export function ImportCard() {
  const [done, setDone] = useState(false);

  return (
    <ChapterCard id="card-import" icon={Link2} title="Traz o servidor. A estrutura vem junto.">
      <div className="p-4 sm:p-5">
        <ol className="grid gap-2 @lg:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s} className="flex items-center gap-2.5 text-[14px] font-medium">
              <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full border border-signal/30 bg-signal/10 font-display text-xs font-bold text-signal">
                {i + 1}
              </span>
              {s}
            </li>
          ))}
        </ol>

        <div className="mt-4 grid gap-3 rounded-xl bg-rail p-3 ring-1 ring-inset ring-white/5 @lg:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] @lg:gap-4">
          <div className="flex flex-col justify-between gap-3">
            <div>
              <p className="flex items-center gap-2 text-xs text-paper-muted">
                Link do modelo <Exemplo />
              </p>
              <p className="mt-2 flex items-center gap-2 break-all rounded-lg border border-white/10 bg-ink px-3 py-2.5 font-mono text-[13px] text-paper">
                <Link2 className="h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
                discord.new/exemplo
              </p>
            </div>
            <button
              type="button"
              aria-expanded={done}
              aria-controls="c3-import-preview"
              onClick={() => setDone((d) => !d)}
              className={cn(
                "inline-flex h-11 items-center justify-center gap-2 rounded-xl px-4 text-sm font-semibold transition-colors",
                done
                  ? "bg-white/[0.06] text-paper ring-1 ring-inset ring-white/10 hover:bg-white/10"
                  : "bg-signal text-ink hover:bg-signal-dim",
                FOCUS_RING,
              )}
            >
              {done ? "Desfazer a prévia" : "Ver a prévia do exemplo"}
            </button>
          </div>

          <div
            id="c3-import-preview"
            className="min-h-24 @lg:min-h-[13rem] rounded-lg border border-white/[0.07] bg-ink-2/60 pb-3"
          >
            {done ? (
              <div>
                <p className="flex items-center gap-2 px-3 pt-3 font-display text-sm font-bold">Mesa do Rafa <Exemplo /></p>
                <div className="hp-pop" style={stagger(0)}>
                  <SectionLabel>Texto</SectionLabel>
                </div>
                <div className="space-y-0.5">
                  {["geral", "fichas", "off-topic"].map((c, i) => (
                    <div key={c} className="hp-pop" style={stagger(i + 1)}>
                      <TextChannel name={c} active={i === 0} />
                    </div>
                  ))}
                </div>
                <div className="hp-pop" style={stagger(4)}>
                  <SectionLabel>Voz</SectionLabel>
                </div>
                <div className="space-y-0.5">
                  {["Lobby", "Mesa 1"].map((c, i) => (
                    <div key={c} className="hp-pop" style={stagger(i + 5)}>
                      <VoiceChannel name={c} />
                    </div>
                  ))}
                </div>
                <ul className="mx-3 mt-3 flex flex-wrap gap-1.5">
                  {SAMPLE_ROLES.map((r, i) => (
                    <li
                      key={r.name}
                      className="hp-pop inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11px] text-paper-muted"
                      style={stagger(i + 7)}
                    >
                      <span aria-hidden className={cn("h-2 w-2 rounded-full", r.dot)} />
                      {r.name}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div className="grid h-full min-h-24 place-items-center @lg:min-h-[13rem] px-4 text-center">
                <p className="max-w-[16rem] text-[13px] leading-snug text-paper-muted">
                  A prévia aparece aqui: canais, categorias e cargos, antes de você criar qualquer coisa.
                </p>
              </div>
            )}
          </div>
        </div>

        <div className="mt-5 grid gap-5 @lg:grid-cols-2 @lg:gap-6">
          <div>
            <H3>Vem junto</H3>
            <ul className="mt-3 space-y-2.5">
              {COMES.map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-[15px] leading-snug">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-signal" strokeWidth={2.5} aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
          <div>
            <H3>Não vem</H3>
            <ul className="mt-3 space-y-2.5">
              {STAYS.map((t) => (
                <li key={t} className="flex items-start gap-2.5 text-[15px] leading-snug text-paper-muted">
                  <X className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted/70" strokeWidth={2.5} aria-hidden />
                  {t}
                </li>
              ))}
            </ul>
          </div>
        </div>

        <ul className="mt-5 space-y-2 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-3.5 text-sm leading-relaxed text-paper-muted">
          <li>
            Quem gera o link do modelo é o dono do servidor ou quem tem “Gerenciar servidor”, no computador ou
            no navegador (não no app do celular).
          </li>
          <li>Sem bot, sem login no Discord, sem token. A importação do pqp roda na web hoje.</li>
          <li>O Discord não muda. Dá pra usar os dois ao mesmo tempo.</li>
        </ul>

        <div className="mt-5">
          <JoinButton intent={IMPORT_INTENT} className={BTN_PRIMARY}>
            Importar o meu de verdade
            <ArrowRight className="h-4 w-4" aria-hidden />
          </JoinButton>
        </div>
      </div>
    </ChapterCard>
  );
}

/* -------------------------------------------------------------------------- */
/* 4. "onde fica o servidor?": the regions card, read live                     */

const REGION_INFO: Record<RegionId, { city: string; role: string }> = {
  gru: { city: "São Paulo", role: "Voz e vídeo. A API e o banco de dados também ficam aqui." },
  mia: { city: "Miami", role: "Voz e vídeo, mais perto da América do Norte." },
  lhr: { city: "Londres", role: "Voz e vídeo, mais perto da Europa." },
};

const REGION_ORDER: RegionId[] = ["gru", "mia", "lhr"];

const STATE_UI: Record<LiveState, { label: string; dot: string; text: string; pin: string }> = {
  operational: { label: "No ar", dot: "bg-success", text: "text-success", pin: "fill-success" },
  degraded: { label: "Instável", dot: "bg-warning", text: "text-warning", pin: "fill-warning" },
  down: { label: "Fora do ar", dot: "bg-danger", text: "text-danger", pin: "fill-danger" },
  unknown: { label: "Sem leitura", dot: "bg-paper-muted/60", text: "text-paper-muted", pin: "fill-paper-muted" },
};

const LAND_PATH = landDotsPath();

/** The arcs are examples of the routing rule, one per box. Not traffic. */
const EXAMPLE_ARCS = [0, 3, 6].map((i) => {
  const caller = SAMPLE_CALLERS[i];
  const from = project(caller);
  const to = project(regionById(caller.region));
  return { from, d: arcPath(from, to), region: caller.region };
});

function DotMap({ states }: { states: Record<RegionId, LiveState> }) {
  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${GRID.cols} ${GRID.rows}`}
        role="img"
        aria-label="Mapa com os três servidores de voz do pqp: São Paulo, Miami e Londres."
        className="h-auto w-full"
      >
        <path d={LAND_PATH} fill="none" stroke="currentColor" strokeWidth={1.15} strokeLinecap="round" className="text-paper-muted/30" />
        {EXAMPLE_ARCS.map((a) => (
          <g key={a.region}>
            <path d={a.d} fill="none" strokeWidth={0.35} strokeDasharray="0.9 1.1" className="stroke-signal/55" />
            <circle cx={a.from.x} cy={a.from.y} r={0.8} className="fill-paper-muted/80" />
          </g>
        ))}
        {REGION_ORDER.map((id) => {
          const p = project(regionById(id));
          const ui = STATE_UI[states[id]];
          return (
            <g key={id}>
              <circle cx={p.x} cy={p.y} r={3.4} className={cn(ui.pin, "opacity-20")} />
              <circle cx={p.x} cy={p.y} r={1.7} className={cn(ui.pin, "stroke-ink")} strokeWidth={0.6} />
            </g>
          );
        })}
      </svg>
      {REGION_ORDER.map((id) => {
        const p = project(regionById(id));
        return (
          <span
            key={id}
            aria-hidden
            className="pointer-events-none absolute -translate-x-1/2 whitespace-nowrap rounded-md bg-ink/85 px-1.5 py-0.5 text-[11px] font-semibold text-paper ring-1 ring-white/10"
            style={{ left: `${(p.x / GRID.cols) * 100}%`, top: `calc(${(p.y / GRID.rows) * 100}% + 0.7rem)` }}
          >
            {REGION_INFO[id].city}
          </span>
        );
      })}
    </div>
  );
}

export function RegionsCard() {
  const reading = useLiveStatus();
  const states = useMemo<Record<RegionId, LiveState>>(
    () =>
      reading && reading !== "unavailable"
        ? reading.regions
        : { gru: "unknown", mia: "unknown", lhr: "unknown" },
    [reading],
  );

  let summary: ReactNode;
  if (reading === null) {
    summary = (
      <>
        <span aria-hidden className="h-2 w-2 animate-pulse rounded-full bg-paper-muted motion-reduce:animate-none" />
        Conferindo os servidores agora…
      </>
    );
  } else if (reading === "unavailable") {
    summary = (
      <>
        <span aria-hidden className="h-2 w-2 rounded-full bg-paper-muted/60" />
        <span>
          Não deu pra ler o status agora, então nenhum servidor aparece como no ar.{" "}
          <Link to="/status" className={SMALL_LINK}>
            Ver o status ao vivo
          </Link>
        </span>
      </>
    );
  } else {
    const ui = STATE_UI[reading.overall];
    const sentence =
      reading.overall === "operational"
        ? "Os três estão no ar agora."
        : reading.overall === "degraded"
          ? "Um deles está instável agora."
          : reading.overall === "down"
            ? "Um deles está fora do ar agora."
            : "A leitura veio incompleta.";
    summary = (
      <>
        <span aria-hidden className={cn("h-2 w-2 rounded-full", ui.dot)} />
        <span>
          {sentence}{" "}
          <span className="text-paper-muted">
            {reading.checkedAt ? `Conferido ${ageLabel(reading.checkedAt)}.` : "Leitura sem horário."}
          </span>{" "}
          <Link to="/status" className={SMALL_LINK}>
            Status ao vivo
          </Link>
        </span>
      </>
    );
  }

  return (
    <ChapterCard id="card-regions" icon={Radio} title="Voz em São Paulo, Miami e Londres.">
      <div className="grid gap-5 p-4 sm:p-5 @lg:grid-cols-[minmax(0,1.05fr)_minmax(0,1fr)] @lg:gap-6">
        <div>
          <DotMap states={states} />
          <p className="mt-2 text-xs leading-snug text-paper-muted">
            As linhas são exemplos de onde uma call abre. Não é tráfego de verdade.
          </p>
        </div>
        <div className="flex flex-col">
          <ul className="divide-y divide-white/[0.07]">
            {REGION_ORDER.map((id) => {
              const ui = STATE_UI[states[id]];
              const loading = reading === null;
              return (
                <li key={id} className="flex items-start justify-between gap-3 py-3 first:pt-0">
                  <div className="min-w-0">
                    <p className="font-display text-[17px] font-bold leading-tight">{REGION_INFO[id].city}</p>
                    <p className="mt-1 text-[13px] leading-snug text-paper-muted">{REGION_INFO[id].role}</p>
                  </div>
                  <span
                    className={cn(
                      "mt-0.5 inline-flex shrink-0 items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.03] px-2.5 py-1 text-xs font-medium",
                      loading ? "text-paper-muted" : ui.text,
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "h-1.5 w-1.5 rounded-full",
                        loading ? "animate-pulse bg-paper-muted motion-reduce:animate-none" : ui.dot,
                      )}
                    />
                    {loading ? "Conferindo" : ui.label}
                  </span>
                </li>
              );
            })}
          </ul>
          <p aria-live="polite" className="mt-1 flex items-start gap-2 border-t border-white/[0.07] pt-3 text-[13px] leading-snug">
            {summary}
          </p>
        </div>
      </div>
      <ul className="grid gap-x-6 gap-y-3 border-t border-white/[0.07] px-4 py-4 text-[14px] leading-snug text-paper-muted sm:px-5 @lg:grid-cols-3">
        <li>
          <span className="font-semibold text-paper">Call grande:</span> abre no servidor mais perto da maioria
          das pessoas do servidor.
        </li>
        <li>
          <span className="font-semibold text-paper">DM e servidor pequeno:</span> a voz vai direto entre as
          pessoas.
        </li>
        <li>
          <span className="font-semibold text-paper">Backups:</span> toda noite, na América do Norte.
        </li>
      </ul>
    </ChapterCard>
  );
}

/* -------------------------------------------------------------------------- */
/* 5. "o que ainda não tem?": the honest card                                  */

const LIMITS = [
  "A importação traz a estrutura, não as mensagens nem os membros.",
  "A importação só roda na web, por enquanto.",
  "O app de iPhone está em beta, pelo TestFlight.",
  "O filme em grupo (watch party) está em acesso antecipado: a gente libera servidor por servidor.",
  "Bots e integrações estão só começando.",
  "O som numa tela compartilhada depende do navegador e do sistema, como no cartão lá em cima.",
];

const DISCORD_BETTER = [
  "Os apps nativos são mais maduros.",
  "O ecossistema de bots e integrações é enorme.",
  "Tem muito mais tempo de estrada.",
];

export function LimitsCard() {
  return (
    <ChapterCard id="card-limits" icon={CircleDashed} title="O que o pqp ainda não tem.">
      <div className="grid gap-6 p-4 sm:p-5 @lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] @lg:gap-8">
        <div>
          <H3>Ainda não</H3>
          <ul className="mt-3 space-y-3">
            {LIMITS.map((t) => (
              <li key={t} className="flex items-start gap-3 text-[15px] leading-snug">
                <CircleDashed className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
                {t}
              </li>
            ))}
          </ul>
        </div>
        <div className="@lg:border-l @lg:border-white/[0.07] @lg:pl-8">
          <H3>O que o Discord faz melhor hoje</H3>
          <ul className="mt-3 space-y-3">
            {DISCORD_BETTER.map((t) => (
              <li key={t} className="flex items-start gap-3 text-[15px] leading-snug">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" strokeWidth={2.5} aria-hidden />
                {t}
              </li>
            ))}
          </ul>
          <p className="mt-4 text-sm leading-relaxed text-paper-muted">
            Dá pra usar os dois ao mesmo tempo, então ninguém precisa mudar tudo no mesmo dia.
          </p>
        </div>
      </div>
      <div className="space-y-3 border-t border-white/[0.07] px-4 py-4 text-sm leading-relaxed text-paper-muted sm:px-5">
        <p>
          Sobre dados: o site usa estatística sem cookies (Umami e Cloudflare Web Analytics), relatório de
          erros (Grafana Faro) e a tag de anúncios do Google, que usa cookies. Tudo explicado em linguagem
          simples em{" "}
          <Link to="/privacy" className={SMALL_LINK}>
            pqp.gg/privacy
          </Link>
          .
        </p>
        <p className="flex flex-wrap gap-x-5 gap-y-2">
          <Link to="/vs-discord" className={cn(SMALL_LINK, "inline-flex items-center gap-1")}>
            Comparação completa com o Discord
            <ArrowRight className="h-3.5 w-3.5" aria-hidden />
          </Link>
          <a
            href={SOURCE_REPO_URL}
            target="_blank"
            rel="noreferrer"
            className={cn(SMALL_LINK, "inline-flex items-center gap-1")}
          >
            Ler o código
            <ArrowUpRight className="h-3.5 w-3.5" aria-hidden />
          </a>
        </p>
      </div>
    </ChapterCard>
  );
}

/* -------------------------------------------------------------------------- */
/* 6. The closer: a composer that holds the buttons                            */

export function CloserCard() {
  return (
    <section aria-label="Entrar na conversa" className="rounded-2xl border border-white/10 bg-ink-2/80 p-3 shadow-[0_28px_70px_-40px_black] sm:p-4">
      <div className="flex items-center gap-3 rounded-xl border border-white/[0.08] bg-ink px-3.5 py-3 text-[15px] text-paper-muted">
        <span aria-hidden className="grid h-7 w-7 shrink-0 place-items-center rounded-full bg-white/[0.07]">
          <Plus className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1 truncate">Entra pra responder em papo-reto</span>
        <span aria-hidden className="c3-caret h-5 w-0.5 rounded-full bg-signal" />
      </div>
      <div className="mt-3 flex flex-col gap-3 sm:flex-row">
        <JoinButton intent={CREATE_INTENT} className={cn(BTN_PRIMARY, "sm:flex-1")}>
          Criar a sala da galera
          <ArrowRight className="h-4 w-4" aria-hidden />
        </JoinButton>
        <JoinButton intent={IMPORT_INTENT} className={cn(BTN_SECONDARY, "sm:flex-1")}>
          Trazer do Discord
        </JoinButton>
      </div>
      <p className="mt-3 px-0.5 text-sm text-paper-muted">Grátis, sem cartão. Entra com Google, Apple ou Twitch.</p>
      <ul className="mt-3 flex flex-wrap gap-x-5 gap-y-1.5 border-t border-white/[0.07] px-0.5 pt-3 text-[13px] text-paper-muted">
        <li>Código aberto (AGPL)</li>
        <li>Feito por dois irmãos</li>
        <li>
          Doar em{" "}
          <Link to="/apoie" className={SMALL_LINK}>
            /apoie
          </Link>{" "}
          não desbloqueia nada
        </li>
      </ul>
    </section>
  );
}
