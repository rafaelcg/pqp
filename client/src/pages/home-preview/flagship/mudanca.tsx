import {
  ArrowRight,
  AudioLines,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  CircleCheck,
  ClipboardPaste,
  FolderTree,
  Hash,
  Image,
  Info,
  Link2,
  Link2Off,
  LoaderCircle,
  Lock,
  MessageSquare,
  Minus,
  RotateCcw,
  Shield,
  Smile,
  TextQuote,
  Users,
  Volume2,
  Webhook,
  type LucideIcon,
} from "lucide-react";
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { useReducedMotion } from "../shared/motion";
import { PIN_MEDIA, Reveal, usePinnedScenes, useSceneProgress } from "./cinema";
import {
  BTN_DEMO,
  BTN_PRIMARY,
  CARD_RAISED,
  CONTAINER,
  CTA_IMPORT,
  ExampleTag,
  FreeLine,
  Glow,
  H3,
  HEADER_GAP,
  Hi,
  SectionHeader,
  Section,
} from "./ui";
import "./mudanca.css";

/**
 * The second act: the crew in the hero came from Discord, and this is how
 * their server got here. A sample Guild Template link (obviously fake, never
 * fetched) is "imported": a grey sidebar on the left is the source, and the
 * pqp sidebar on the right assembles row by row in the same order. Then a
 * preview before creating, then a small done state, as the real flow does.
 * Under the bench, one footnote holds the conditions: who makes the link and
 * where, and that the import is web only.
 *
 * Everything here is a demo. Nothing typed, fetched or stored. The lists of
 * what comes and what does not are static content and always readable.
 */

type RoleTone = "amber" | "sky" | "emerald";

type Row =
  | { kind: "server"; name: string; initials: string }
  | { kind: "category"; name: string }
  | { kind: "text"; name: string; privateTo?: string }
  | { kind: "voice"; name: string }
  | { kind: "label"; name: string }
  | { kind: "role"; name: string; tone: RoleTone };

/** One list drives both sidebars, so "same order" is true by construction. */
const ROWS: Row[] = [
  { kind: "server", name: "A Mesa", initials: "ME" },
  { kind: "category", name: "Informações" },
  { kind: "text", name: "regras" },
  { kind: "category", name: "Conversa" },
  { kind: "text", name: "geral" },
  { kind: "text", name: "fichas" },
  { kind: "category", name: "Voz" },
  { kind: "voice", name: "Lobby" },
  { kind: "voice", name: "Sessão de sábado" },
  { kind: "category", name: "Mestres" },
  { kind: "text", name: "bastidores", privateTo: "Mestre" },
  { kind: "label", name: "Cargos" },
  { kind: "role", name: "Mestre", tone: "amber" },
  { kind: "role", name: "Jogadores", tone: "sky" },
  { kind: "role", name: "Novatos", tone: "emerald" },
];

const ROW_COUNT = ROWS.length;
const firstIndex = (kind: Row["kind"]) => ROWS.findIndex((r) => r.kind === kind);
const PRIVATE_INDEX = ROWS.findIndex((r) => r.kind === "text" && Boolean(r.privateTo));

const ROLE_DOT: Record<RoleTone, string> = {
  amber: "bg-amber-300",
  sky: "bg-sky-400",
  emerald: "bg-emerald-400",
};
const ROLE_TEXT: Record<RoleTone, string> = {
  amber: "text-amber-300",
  sky: "text-sky-400",
  emerald: "text-emerald-400",
};

/* Sidebar geometry, shared by both panels and the lane between them, so a
   Discord row sits on the same line as its pqp twin. */
const LABEL_BLOCK = 36; // h-6 label + mb-3
const HEADER_H = 52;
const LIST_PAD = 8;
const ROW_H = 28;
const MARKER = 28;

function rowCenter(i: number) {
  if (i <= 0) return LABEL_BLOCK + 1 + HEADER_H / 2;
  return LABEL_BLOCK + 1 + HEADER_H + LIST_PAD + (i - 1) * ROW_H + ROW_H / 2;
}
const LANE_REST = LABEL_BLOCK + 1 + HEADER_H + LIST_PAD + ((ROW_COUNT - 1) * ROW_H) / 2;

const SAMPLE_PREFIX = "discord.new/";
/** Hyphens make it an impossible template code: it can never be somebody's server. */
const SAMPLE_CODE = "exemplo-da-mesa";

type Phase = "empty" | "filled" | "building" | "preview" | "done";

const COMES: { icon: LucideIcon; text: string; at: number }[] = [
  { icon: Image, text: "Nome e ícone do servidor", at: 0 },
  { icon: FolderTree, text: "Categorias", at: firstIndex("category") },
  { icon: Hash, text: "Canais de texto e de voz, na mesma ordem", at: firstIndex("voice") },
  { icon: TextQuote, text: "O tópico de cada canal", at: firstIndex("text") },
  {
    icon: Shield,
    text: "Cargos com nome, cor e permissões (nunca Administrador)",
    at: firstIndex("role"),
  },
  { icon: Lock, text: "Canais privados e quem pode ver, escrever e entrar", at: PRIVATE_INDEX },
];

const STAYS: { icon: LucideIcon; text: string }[] = [
  { icon: Users, text: "Membros" },
  { icon: MessageSquare, text: "Mensagens e anexos" },
  { icon: Smile, text: "Emoji e figurinhas" },
  { icon: AudioLines, text: "Soundboard" },
  { icon: Webhook, text: "Webhooks" },
  { icon: Ban, text: "Banimentos" },
  { icon: Link2Off, text: "Convites do Discord" },
];

/** A demo button that is not the next step (Recomeçar): outlined, not lime. */
const DEMO_QUIET = "border border-white/15 bg-transparent text-paper hover:bg-white/[0.06]";

export function Mudanca() {
  return (
    <Section id="mudanca" labelledBy="mudanca-title" divider={false} className="overflow-x-clip">
      <Glow intensity="soft" className="-right-48 top-[38%] h-[560px] w-[560px]" />
      <div className={cn(CONTAINER, "relative")}>
        <SectionHeader
          eyebrow="Vindo do Discord"
          titleId="mudanca-title"
          title={
            <>
              Traz o servidor do Discord. A{"\u00a0"}estrutura <Hi>vem junto</Hi>.
            </>
          }
          lede="Cola o link do modelo do servidor e o pqp monta a mesma barra lateral: categorias, canais e cargos, na mesma ordem. Sem bot e sem login no Discord. Você vê a prévia antes de criar."
        />

        <div className={HEADER_GAP}>
          <ImportBench />
        </div>

        {/* Under the bench: the conditions, then the section's one real call to action, on the lists' column. */}
        <div className="mt-8 grid gap-10 lg:grid-cols-12 lg:gap-0">
          <p className="flex gap-2.5 text-[13px] leading-relaxed text-paper-muted text-pretty sm:px-1 lg:col-span-8 lg:pr-12">
            <Info className="mt-[3px] h-3.5 w-3.5 shrink-0" aria-hidden />
            <span>
              Quem é dono do servidor ou tem a permissão Gerenciar servidor gera o link do modelo no Discord, pelo
              computador ou pelo navegador (o app do celular não cria modelo). Hoje, a importação do pqp é só pela
              web. O Discord não muda nada: dá pra usar os dois ao mesmo tempo.
            </span>
          </p>
          <Reveal className="lg:col-span-4 lg:pl-6">
            <ImportCta />
          </Reveal>
        </div>
      </div>
    </Section>
  );
}

/** The import CTA block carries this id, so the sticky bar can step aside only while it shows. */
export const MUDANCA_CTA_ID = "mudanca-cta";

/**
 * The section's one real call to action. It comes after the demo, so it reads
 * as "now with yours" (the end of the night just above has its own pair), with
 * the line that explains why the demo says comunidade.
 */
function ImportCta() {
  return (
    <div id={MUDANCA_CTA_ID}>
      <p className="max-w-sm text-base leading-snug text-paper text-pretty">
        No pqp, o servidor do Discord vira uma comunidade.
      </p>
      <JoinButton intent={IMPORT_INTENT} className={cn(BTN_PRIMARY, "mt-5 w-full sm:w-auto")}>
        {CTA_IMPORT}
        <ArrowRight className="h-4 w-4" aria-hidden />
      </JoinButton>
      <FreeLine className="mt-3 text-sm text-paper-muted text-pretty" />
    </div>
  );
}

/**
 * The bench's entrance at lg: the two sidebars start apart, out at the sides,
 * and slide into place as the bench comes up the screen, the lane between
 * them lighting up last. Both settle early (by the time the bench's top is a
 * little above the middle), so the nav link that jumps here lands on a
 * finished bench. Below lg (and with reduced motion) the bench simply rises in.
 */
const BENCH_RANGES = {
  side: [0.2, 0.75, "out"],
  lane: [0.5, 0.85, "out"],
} as const;

function slideStyle(from: "left" | "right"): CSSProperties {
  // The right one travels less: the lists column sits just past it.
  const dir = from === "left" ? -1 : 1;
  const travel = from === "left" ? 62 : 40;
  return {
    transform: `translate3d(calc((1 - var(--p-side)) * ${dir * travel}%), 0, 0) rotateY(calc((1 - var(--p-side)) * ${dir * -18}deg)) scale(calc(0.92 + 0.08 * var(--p-side)))`,
    transformOrigin: from === "left" ? "100% 50%" : "0% 50%",
    opacity: "calc(var(--p-side) * 1.25 - 0.1)",
    willChange: "transform, opacity",
  };
}

function ImportBench() {
  const reduced = useReducedMotion();
  const pinned = usePinnedScenes();
  const benchRef = useRef<HTMLDivElement>(null);
  useSceneProgress(benchRef, { mode: "enter", media: PIN_MEDIA, ranges: BENCH_RANGES });
  const [phase, setPhase] = useState<Phase>("empty");
  const [typed, setTyped] = useState(0);
  const [built, setBuilt] = useState(0);
  const [run, setRun] = useState(0);
  const [view, setView] = useState<"discord" | "pqp">("discord");

  const timers = useRef<number[]>([]);
  const mainRef = useRef<HTMLButtonElement>(null);
  const createRef = useRef<HTMLButtonElement>(null);
  const doneRef = useRef<HTMLParagraphElement>(null);
  const focusNext = useRef<"create" | "done" | null>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  // Set the moment the visitor uses any control, so the arrival run never fights them.
  const touched = useRef(false);
  const autoRun = useRef<() => void>(() => {});

  // Every timer dies with the component. The array is mutated in place, so
  // the copy taken here is the live list.
  useEffect(() => {
    const list = timers.current;
    return () => list.splice(0).forEach((id) => window.clearTimeout(id));
  }, []);

  // Move focus to the control that replaced the one just used.
  useEffect(() => {
    const target = focusNext.current;
    focusNext.current = null;
    if (target === "create") createRef.current?.focus({ preventScroll: true });
    if (target === "done") doneRef.current?.focus({ preventScroll: true });
  }, [phase]);

  const clearTimers = () => timers.current.splice(0).forEach((id) => window.clearTimeout(id));
  const later = (fn: () => void, ms: number) => {
    timers.current.push(window.setTimeout(fn, ms));
  };

  const fillExample = () => {
    clearTimers();
    setBuilt(0);
    setPhase("filled");
    if (reduced) {
      setTyped(SAMPLE_CODE.length);
      return;
    }
    setTyped(0);
    for (let i = 1; i <= SAMPLE_CODE.length; i++) later(() => setTyped(i), 80 + i * 30);
  };

  const startImport = () => {
    clearTimers();
    setTyped(SAMPLE_CODE.length);
    setRun((n) => n + 1);
    setView("pqp");
    const toPreview = () => {
      if (document.activeElement === mainRef.current) focusNext.current = "create";
      setPhase("preview");
    };
    if (reduced) {
      setBuilt(ROW_COUNT);
      toPreview();
      return;
    }
    setBuilt(0);
    setPhase("building");
    const READ_MS = 450;
    const STEP_MS = 150;
    for (let i = 1; i <= ROW_COUNT; i++) later(() => setBuilt(i), READ_MS + (i - 1) * STEP_MS);
    later(toPreview, READ_MS + ROW_COUNT * STEP_MS + 350);
  };

  const create = () => {
    touched.current = true;
    clearTimers();
    focusNext.current = "done";
    setPhase("done");
  };

  const reset = () => {
    touched.current = true;
    clearTimers();
    setPhase("empty");
    setTyped(0);
    setBuilt(0);
    setView("discord");
  };

  // The first time the bench is mostly on screen, play the import once on the
  // visitor's behalf: the same path as the buttons, ending on the preview.
  autoRun.current = () => {
    if (touched.current) return;
    if (reduced) {
      setTyped(SAMPLE_CODE.length);
      setBuilt(ROW_COUNT);
      setRun((n) => n + 1);
      setView("pqp");
      setPhase("preview");
      return;
    }
    fillExample();
    later(startImport, 80 + SAMPLE_CODE.length * 30 + 450);
  };

  useEffect(() => {
    const el = stageRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        autoRun.current();
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const onMain = () => {
    touched.current = true;
    if (phase === "empty") fillExample();
    else if (phase === "filled") startImport();
    else if (phase === "preview" || phase === "done") reset();
  };

  const finished = phase === "preview" || phase === "done";
  const shown = finished ? ROW_COUNT : phase === "building" ? built : 0;
  const copying = phase === "building" ? built - 1 : -1;
  const animate = phase === "building" && !reduced;
  const typing = phase === "filled" && typed < SAMPLE_CODE.length;

  const step = phase === "done" ? 2 : phase === "preview" ? 1 : 0;

  const announce: Record<Phase, string> = {
    empty: "",
    filled: "Link de exemplo colado no campo.",
    building: "Importando o modelo de exemplo.",
    preview:
      "Prévia pronta: quatro categorias, seis canais e três cargos, na mesma ordem do Discord. Nada foi criado ainda.",
    done: "Comunidade de exemplo criada. O Discord em si não mudou.",
  };

  const main: Record<Phase, { label: string; icon: LucideIcon; primary: boolean }> = {
    empty: { label: "Usar o exemplo", icon: ClipboardPaste, primary: true },
    filled: { label: "Importar exemplo", icon: ArrowRight, primary: true },
    building: { label: "Importando…", icon: LoaderCircle, primary: true },
    preview: { label: "Recomeçar", icon: RotateCcw, primary: false },
    done: { label: "Recomeçar", icon: RotateCcw, primary: false },
  };
  const action = main[phase];

  const card = (
    <div
      ref={benchRef}
      className={cn(
        CARD_RAISED,
        "relative",
        // Pinned, the sidebars fly in from outside the card, so it must not clip them.
        pinned ? "overflow-visible" : "overflow-hidden",
      )}
    >
      <p aria-live="polite" className="sr-only">
        {announce[phase]}
      </p>

      {/* The paste bar. */}
      <div className="border-b border-white/[0.06] px-4 py-5 sm:px-6">
        <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
          <p className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted">
            Link do modelo do Discord
            <ExampleTag />
          </p>
          <Stepper step={step} done={phase === "done"} />
        </div>
        <div className="mt-3 flex flex-col gap-3 sm:flex-row">
          <div
            aria-hidden
            className={cn(
              "flex h-10 min-w-0 items-center gap-2.5 rounded-lg border bg-ink px-3 font-mono text-[13px] transition-colors sm:flex-1 sm:text-sm",
              phase === "empty" ? "border-white/10" : "border-signal/40",
            )}
          >
            <Link2 className={cn("h-4 w-4 shrink-0", phase === "empty" ? "text-paper-muted" : "text-signal")} />
            {phase === "empty" ? (
              <span className="min-w-0 flex-1 truncate text-paper-muted/70">discord.new/…</span>
            ) : (
              <span className="min-w-0 flex-1 truncate">
                <span className="text-paper-muted">{SAMPLE_PREFIX}</span>
                <span className="text-paper">{SAMPLE_CODE.slice(0, typed)}</span>
                {typing && <span className="mu-caret ml-px inline-block h-4 w-px translate-y-[3px] bg-signal" />}
              </span>
            )}
            {finished ? (
              <Check className="h-4 w-4 shrink-0 text-signal" />
            ) : (
              <span className="hidden shrink-0 font-sans text-[11px] text-paper-muted sm:inline">
                só demonstração, nada é enviado
              </span>
            )}
          </div>
          <button
            ref={mainRef}
            type="button"
            onClick={onMain}
            aria-disabled={phase === "building" || undefined}
            aria-busy={phase === "building" || undefined}
            className={cn(BTN_DEMO, "h-10 w-full shrink-0 sm:w-auto sm:min-w-[184px]", !action.primary && DEMO_QUIET)}
          >
            <action.icon
              className={cn("h-4 w-4", phase === "building" && "motion-safe:animate-spin")}
              aria-hidden
            />
            {action.label}
          </button>
        </div>
        <p className="mt-2.5 text-[12px] text-paper-muted sm:hidden">Só demonstração: nada é buscado nem enviado.</p>
      </div>

      <div className="grid lg:grid-cols-12">
        {/* The two sidebars. */}
        <div ref={stageRef} className="min-w-0 p-4 sm:p-6 lg:col-span-8">
          <p className="sr-only">
            Demonstração: à esquerda, a barra lateral de um servidor de exemplo no Discord. À direita, a mesma
            barra montada no pqp, linha por linha e na mesma ordem: categorias, canais de texto e de voz, um
            canal privado e os cargos com suas cores.
          </p>

          <div
            role="group"
            aria-label="Qual lado mostrar"
            className="mb-4 grid grid-cols-2 gap-1 rounded-full border border-white/[0.07] bg-ink/70 p-1 md:hidden"
          >
            {(["discord", "pqp"] as const).map((side) => (
              <button
                key={side}
                type="button"
                aria-pressed={view === side}
                onClick={() => setView(side)}
                className={cn(
                  "inline-flex h-10 items-center justify-center gap-2 rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
                  view === side ? "bg-ink-3 text-paper ring-1 ring-inset ring-white/10" : "text-paper-muted",
                )}
              >
                {side === "pqp" && (
                  <span className={cn("h-1.5 w-1.5 rounded-full", finished ? "bg-signal" : "bg-white/25")} aria-hidden />
                )}
                {side === "discord" ? "No Discord" : "No pqp"}
              </button>
            ))}
          </div>

          <div
            className="grid md:grid-cols-[minmax(0,1fr)_48px_minmax(0,1fr)]"
            style={pinned ? { perspective: "1400px" } : undefined}
          >
            <div
              className={cn("flex min-w-0 flex-col", view === "pqp" && "max-md:hidden")}
              style={pinned ? slideStyle("left") : undefined}
            >
              <DiscordPanel copying={copying} />
            </div>
            <Lane phase={phase} copying={copying} style={pinned ? { opacity: "var(--p-lane)" } : undefined} />
            <div
              className={cn("flex min-w-0 flex-col", view === "discord" && "max-md:hidden")}
              style={pinned ? slideStyle("right") : undefined}
            >
              <PqpPanel phase={phase} shown={shown} animate={animate} run={run} />
            </div>
          </div>

          <StatusBar
            phase={phase}
            shown={shown}
            onCreate={create}
            createRef={createRef}
            doneRef={doneRef}
          />
        </div>

        {/* What comes and what stays, in the same frame. */}
        <div
          className="grid border-t border-white/[0.06] sm:grid-cols-2 lg:col-span-4 lg:grid-cols-1 lg:grid-rows-[auto_auto] lg:content-start lg:border-l lg:border-t-0"
        >
          <ListBlock
            title="Vem junto"
            sub="Nasce igual no pqp."
            badge={<Check className="h-4 w-4" aria-hidden />}
            badgeClass="bg-signal text-ink"
          >
            {COMES.map((item) => {
              const lit = shown > item.at;
              return (
                <Item key={item.text} icon={item.icon} lit={lit}>
                  {item.text}
                </Item>
              );
            })}
          </ListBlock>
          <ListBlock
            title="Não vem"
            sub="Fica no Discord. O modelo não leva isso."
            badge={<Minus className="h-4 w-4" aria-hidden />}
            badgeClass="bg-paper text-ink"
            className="border-t border-white/[0.06] sm:border-l sm:border-t-0 lg:border-l-0 lg:border-t"
          >
            {STAYS.map((item) => (
              <Item key={item.text} icon={item.icon} muted>
                {item.text}
              </Item>
            ))}
          </ListBlock>
        </div>
      </div>
    </div>
  );

  return pinned ? card : <Reveal variant="scale">{card}</Reveal>;
}

function Stepper({ step, done }: { step: number; done: boolean }) {
  const steps = ["Link", "Prévia", "Criada"];
  return (
    <ol aria-label="Etapas da importação" className="flex items-center gap-1.5 text-[12px]">
      {steps.map((label, i) => {
        const complete = i < step || (done && i === step);
        const current = i === step;
        return (
          <li key={label} className="flex items-center gap-1.5" aria-current={current ? "step" : undefined}>
            {i > 0 && <ChevronRight className="h-3 w-3 text-paper-muted/50" aria-hidden />}
            <span
              className={cn(
                "grid h-5 w-5 place-items-center rounded-full text-[10px] font-bold tabular-nums transition-colors",
                complete
                  ? "bg-signal text-ink"
                  : current
                    ? "bg-signal/15 text-signal ring-1 ring-inset ring-signal/40"
                    : "bg-white/[0.05] text-paper-muted",
              )}
            >
              {complete ? <Check className="h-3 w-3" aria-hidden /> : i + 1}
            </span>
            <span className={cn("font-medium", current || complete ? "text-paper" : "text-paper-muted")}>{label}</span>
          </li>
        );
      })}
    </ol>
  );
}

function PanelLabel({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div
      className={cn(
        "mb-3 flex h-6 min-w-0 items-center gap-2 whitespace-nowrap text-[11px] font-semibold uppercase tracking-[0.18em]",
        className,
      )}
    >
      {children}
    </div>
  );
}

function DiscordPanel({ copying }: { copying: number }) {
  const server = ROWS[0] as Extract<Row, { kind: "server" }>;
  return (
    <>
      <PanelLabel className="text-zinc-400">
        No Discord
        <span className="truncate font-normal normal-case tracking-normal text-paper-muted">o modelo do servidor</span>
      </PanelLabel>
      <div aria-hidden className="flex-1 overflow-hidden rounded-2xl border border-white/[0.07] bg-zinc-900/70">
        <div
          className={cn(
            "flex items-center gap-2.5 border-b border-white/[0.05] px-3 transition-colors duration-150",
            copying === 0 && "bg-white/[0.06]",
          )}
          style={{ height: HEADER_H }}
        >
          <span className="grid h-8 w-8 place-items-center rounded-full bg-zinc-700 text-[11px] font-bold text-zinc-300">
            {server.initials}
          </span>
          <span className={cn("truncate text-sm font-semibold", copying === 0 ? "text-zinc-100" : "text-zinc-300")}>
            {server.name}
          </span>
        </div>
        <ul style={{ paddingTop: LIST_PAD, paddingBottom: LIST_PAD }}>
          {ROWS.slice(1).map((row, k) => (
            <DiscordRow key={`${row.kind}-${row.name}`} row={row} active={copying === k + 1} />
          ))}
        </ul>
      </div>
    </>
  );
}

function DiscordRow({ row, active }: { row: Row; active: boolean }) {
  if (row.kind === "category" || row.kind === "label") {
    return (
      <li
        className={cn(
          "flex items-end gap-1 px-3 pb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] transition-colors duration-150",
          active ? "text-zinc-100" : "text-paper-muted",
        )}
        style={{ height: ROW_H }}
      >
        {row.kind === "category" && <ChevronDown className="mb-px h-3 w-3 shrink-0" />}
        <span className="truncate">{row.name}</span>
      </li>
    );
  }
  return (
    <li
      className={cn(
        "mx-2 flex items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150",
        active ? "bg-white/[0.08] text-zinc-100" : "text-zinc-400",
      )}
      style={{ height: ROW_H }}
    >
      {row.kind === "text" && <Hash className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
      {row.kind === "voice" && <Volume2 className="h-3.5 w-3.5 shrink-0 text-zinc-500" />}
      {row.kind === "role" && <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full bg-zinc-500" />}
      <span className="min-w-0 truncate">{row.name}</span>
      {row.kind === "text" && row.privateTo && <Lock className="ml-auto h-3 w-3 shrink-0 text-zinc-500" />}
    </li>
  );
}

/** The lane between the sidebars: a marker that follows the row being copied. */
function Lane({ phase, copying, style }: { phase: Phase; copying: number; style?: CSSProperties }) {
  const moving = phase === "building" && copying >= 0;
  const y = (moving ? rowCenter(copying) : LANE_REST) - MARKER / 2;
  const finished = phase === "preview" || phase === "done";
  return (
    <div aria-hidden className="relative hidden md:block" style={style}>
      <span
        className="absolute bottom-0 left-1/2 border-l border-dashed border-white/10"
        style={{ top: LABEL_BLOCK + 1 }}
      />
      <span
        className={cn(
          "mu-marker absolute left-1/2 top-0 -ml-[14px] grid place-items-center rounded-full border transition-colors duration-300",
          phase === "building" || finished
            ? "border-signal/50 bg-signal text-ink"
            : "border-white/15 bg-ink-3 text-paper-muted",
        )}
        style={{ width: MARKER, height: MARKER, transform: `translateY(${y}px)` }}
      >
        {finished ? (
          <Check className="h-3.5 w-3.5" />
        ) : (
          <ArrowRight className={cn("h-3.5 w-3.5", phase === "building" && "mu-nudge")} />
        )}
      </span>
    </div>
  );
}

function PqpPanel({ phase, shown, animate, run }: { phase: Phase; shown: number; animate: boolean; run: number }) {
  const server = ROWS[0] as Extract<Row, { kind: "server" }>;
  const finished = phase === "preview" || phase === "done";
  const chip =
    phase === "building" ? (
      <span className="rounded-full bg-signal/15 px-2 py-0.5 font-mono text-[10px] tracking-normal text-signal tabular-nums">
        montando {shown}/{ROW_COUNT}
      </span>
    ) : phase === "preview" ? (
      <span className="rounded-full px-2 py-0.5 text-[10px] tracking-[0.12em] text-signal ring-1 ring-inset ring-signal/50">
        prévia
      </span>
    ) : phase === "done" ? (
      <span className="inline-flex items-center gap-1 rounded-full bg-signal px-2 py-0.5 text-[10px] tracking-[0.12em] text-ink">
        <Check className="h-3 w-3" aria-hidden />
        criada
      </span>
    ) : (
      <span className="font-normal normal-case tracking-normal text-paper-muted">esperando o link</span>
    );

  return (
    <>
      <PanelLabel className="text-paper">
        No pqp
        <ExampleTag className="tracking-wider" />
        <span className="ml-auto">{chip}</span>
      </PanelLabel>
      <div
        aria-hidden
        className={cn(
          "relative flex-1 overflow-hidden rounded-2xl border bg-ink transition-colors duration-500",
          finished ? "border-signal/35" : "border-white/10",
        )}
      >
        <div key={run}>
          <div
            className="flex items-center gap-2.5 border-b border-white/[0.06] px-3"
            style={{ height: HEADER_H }}
          >
            {shown > 0 ? (
              <span className={cn("flex min-w-0 flex-1 items-center gap-2.5", animate && "mu-arrive")}>
                <span className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-signal font-display text-[11px] font-bold text-ink">
                  {server.initials}
                </span>
                <span className="truncate font-display text-[15px] font-bold text-paper">{server.name}</span>
              </span>
            ) : (
              <>
                <span className="h-8 w-8 shrink-0 rounded-xl border border-dashed border-white/15" />
                <span className="h-2.5 rounded-full bg-white/[0.07]" style={{ width: server.name.length * 9 }} />
              </>
            )}
          </div>
          <ul style={{ paddingTop: LIST_PAD, paddingBottom: LIST_PAD }}>
            {ROWS.slice(1).map((row, k) => (
              <PqpRow
                key={`${row.kind}-${row.name}`}
                row={row}
                state={shown > k + 1 ? (animate ? "arrive" : "built") : "ghost"}
              />
            ))}
          </ul>
        </div>
      </div>
    </>
  );
}

function PqpRow({ row, state }: { row: Row; state: "ghost" | "arrive" | "built" }) {
  const isLabel = row.kind === "category" || row.kind === "label";
  if (state === "ghost") {
    return isLabel ? (
      <li className="flex items-end px-3 pb-2" style={{ height: ROW_H }}>
        <span className="h-1.5 rounded-full bg-white/[0.06]" style={{ width: row.name.length * 7 }} />
      </li>
    ) : (
      <li className="mx-2 flex items-center gap-2 px-2" style={{ height: ROW_H }}>
        <span className={cn("h-3 w-3 shrink-0 bg-white/[0.06]", row.kind === "role" ? "rounded-full" : "rounded")} />
        <span className="h-2 rounded-full bg-white/[0.06]" style={{ width: row.name.length * 6.5 }} />
      </li>
    );
  }

  const arrive = state === "arrive" && "mu-arrive";
  if (isLabel) {
    return (
      <li
        className={cn(
          "flex items-end gap-1 px-3 pb-1.5 text-[10px] font-semibold uppercase tracking-[0.14em] text-paper-muted",
          arrive,
        )}
        style={{ height: ROW_H }}
      >
        {row.kind === "category" && <ChevronDown className="mb-px h-3 w-3 shrink-0" />}
        <span className="truncate">{row.name}</span>
      </li>
    );
  }
  return (
    <li className={cn("mx-2 flex items-center gap-2 rounded-md px-2 text-[13px] text-paper", arrive)} style={{ height: ROW_H }}>
      {row.kind === "text" && <Hash className="h-3.5 w-3.5 shrink-0 text-paper-muted" />}
      {row.kind === "voice" && <Volume2 className="h-3.5 w-3.5 shrink-0 text-signal" />}
      {row.kind === "role" && <span className={cn("mx-[3px] h-2 w-2 shrink-0 rounded-full", ROLE_DOT[row.tone])} />}
      <span className={cn("min-w-0 truncate", row.kind === "role" && cn("font-semibold", ROLE_TEXT[row.tone]))}>
        {row.name}
      </span>
      {row.kind === "text" && row.privateTo && (
        <span className="ml-auto inline-flex shrink-0 items-center gap-1 rounded-md bg-amber-300/10 px-1.5 py-px text-[10px] font-medium text-amber-300">
          <Lock className="h-2.5 w-2.5" />
          só {row.privateTo}
        </span>
      )}
    </li>
  );
}

/**
 * The line under the sidebars. Every phase is drawn in the same grid cell and
 * only the current one is shown, so the cell keeps the tallest phase's height
 * and the bench never jumps while the arrival run plays on a phone.
 */
function StatusBar({
  phase,
  shown,
  onCreate,
  createRef,
  doneRef,
}: {
  phase: Phase;
  shown: number;
  onCreate: () => void;
  createRef: React.RefObject<HTMLButtonElement | null>;
  doneRef: React.RefObject<HTMLParagraphElement | null>;
}) {
  return (
    <div className="mt-4 grid">
      <PhaseBox on={phase === "empty" || phase === "filled"} className="border-white/[0.07] bg-ink/60">
        <p className="flex items-start gap-3 text-sm leading-snug text-paper-muted">
          <ArrowRight className="mt-0.5 h-4 w-4 shrink-0 rotate-[-90deg] text-paper-muted sm:rotate-0" aria-hidden />
          {phase === "filled" ? (
            <span>
              Link no lugar. Aperta <span className="text-paper">Importar exemplo</span> e vê a sala nascer do lado
              do pqp, linha por linha.
            </span>
          ) : (
            <span>
              Aperta <span className="text-paper">Usar o exemplo</span> lá em cima: o pqp lê o modelo e monta a mesma
              barra, na mesma ordem.
            </span>
          )}
        </p>
      </PhaseBox>

      <PhaseBox on={phase === "building"} quiet className="border-white/[0.07] bg-ink/60 sm:gap-6">
        <p className="flex shrink-0 items-center gap-2 text-sm text-paper">
          <LoaderCircle className="h-4 w-4 text-signal motion-safe:animate-spin" />
          {shown === 0 ? "Lendo o modelo…" : "Montando na mesma ordem…"}
        </p>
        <span className="relative h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.07] max-sm:w-full max-sm:flex-none">
          <span
            className="mu-progress absolute inset-0 rounded-full bg-signal"
            style={{ transform: `scaleX(${shown / ROW_COUNT})` }}
          />
        </span>
      </PhaseBox>

      <PhaseBox on={phase === "preview"} rise className="border-signal/30 bg-signal/[0.06]">
        <div className="min-w-0 sm:flex-1">
          <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-paper-muted">Prévia antes de criar</p>
          <p className="mt-1 text-sm text-paper">É isso que vai ser criado. Nada foi criado ainda.</p>
        </div>
        <button
          ref={createRef}
          type="button"
          onClick={onCreate}
          className={cn(BTN_DEMO, "h-10 w-full shrink-0 px-4 sm:w-auto")}
        >
          Criar esta comunidade
        </button>
      </PhaseBox>

      <PhaseBox on={phase === "done"} rise className="border-signal/40 bg-ink">
        <div className="flex min-w-0 items-start gap-3 sm:flex-1">
          <CircleCheck className="mt-0.5 h-5 w-5 shrink-0 text-signal" aria-hidden />
          <div className="min-w-0">
            <p ref={doneRef} tabIndex={-1} className="font-semibold text-paper outline-none">
              Comunidade pronta. <span className="font-normal text-paper-muted">(exemplo)</span>
            </p>
            <p className="mt-0.5 text-sm text-paper-muted">
              O Discord em si não mudou. Agora é mandar o convite pra galera.
            </p>
          </div>
        </div>
      </PhaseBox>
    </div>
  );
}

/**
 * One phase of the status line. The others stay in the cell, invisible and
 * inert, so nothing in them can be focused, clicked or read out. `quiet`
 * hides a box from screen readers even while it shows (the live region speaks
 * for it); `rise` replays the entrance each time the phase comes back.
 */
function PhaseBox({
  on,
  quiet = false,
  rise = false,
  className,
  children,
}: {
  on: boolean;
  quiet?: boolean;
  rise?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <div
      inert={!on}
      aria-hidden={!on || quiet || undefined}
      className={cn(
        "flex min-h-[72px] flex-col justify-center gap-3 rounded-2xl border px-4 py-3.5 [grid-area:1/1] sm:flex-row sm:items-center sm:justify-start sm:gap-5",
        on ? rise && "mu-rise" : "invisible",
        className,
      )}
    >
      {children}
    </div>
  );
}

function ListBlock({
  title,
  sub,
  badge,
  badgeClass,
  className,
  children,
}: {
  title: string;
  sub: string;
  badge: React.ReactNode;
  badgeClass: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("min-w-0 p-5 sm:p-6", className)}>
      <div className="flex items-start gap-3">
        <span className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-full", badgeClass)}>{badge}</span>
        <div className="min-w-0">
          <H3>{title}</H3>
          <p className="mt-0.5 text-[13px] leading-snug text-paper-muted text-pretty">{sub}</p>
        </div>
      </div>
      <ul className="mt-5 grid gap-2.5">{children}</ul>
    </div>
  );
}

function Item({
  icon: Icon,
  lit = false,
  muted = false,
  children,
}: {
  icon: LucideIcon;
  lit?: boolean;
  muted?: boolean;
  children: React.ReactNode;
}) {
  return (
    <li className="flex items-start gap-3 text-[14px] leading-snug text-paper">
      <span
        className={cn(
          "grid h-6 w-6 shrink-0 place-items-center rounded-md transition-colors duration-300",
          lit ? "bg-signal/15 text-signal" : muted ? "text-paper-muted ring-1 ring-inset ring-white/10" : "bg-white/[0.05] text-paper-muted",
        )}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden />
      </span>
      <span className="pt-[3px]">{children}</span>
    </li>
  );
}
