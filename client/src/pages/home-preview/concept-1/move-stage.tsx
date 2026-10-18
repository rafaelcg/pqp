import { ArrowRight, Lock, Pause, Play, Volume2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { useReducedMotion } from "../shared/motion";
import "./move.css";
import { Tag } from "./ui";

/**
 * The hero: one sample server shown twice. On the left, a plain grey sidebar
 * labelled "No Discord" (no logo, no brand colour). On the right, the pqp
 * sidebar. Rows cross from left to right in sidebar order, which is what the
 * import does with a Discord template. What does not come (messages, members,
 * emoji) stays on the left, and the pqp side shows an empty slot for it.
 *
 * Motion: a short state machine ticks every 300 ms. It stops while the stage
 * is off screen, the tab is hidden, or the visitor pressed pause. Reduced
 * motion, and a paused stage, show the finished scene.
 */

type RoleChip = { name: string; dot: string };

type Row =
  | { kind: "server"; name: string; initials: string }
  | { kind: "cat"; label: string }
  | { kind: "text"; name: string; locked?: boolean }
  | { kind: "voice"; name: string; live?: boolean }
  | { kind: "roles"; roles: RoleChip[] }
  | { kind: "stays"; label: string; note?: string }
  | { kind: "gap" };

const ROWS: Row[] = [
  { kind: "server", name: "A Mesa", initials: "AM" },
  { kind: "cat", label: "Texto" },
  { kind: "text", name: "geral" },
  { kind: "text", name: "fichas" },
  { kind: "text", name: "bastidores", locked: true },
  { kind: "cat", label: "Voz" },
  { kind: "voice", name: "Lobby", live: true },
  { kind: "voice", name: "Mesa 1" },
  { kind: "cat", label: "Cargos" },
  {
    kind: "roles",
    roles: [
      { name: "Mestre", dot: "bg-amber-400" },
      { name: "Mod", dot: "bg-sky-400" },
    ],
  },
  { kind: "gap" },
  { kind: "stays", label: "Mensagens e anexos", note: "fica no Discord" },
  { kind: "stays", label: "Membros" },
  { kind: "stays", label: "Emoji e figurinhas" },
];

const moves = (row: Row) => row.kind !== "stays" && row.kind !== "gap";

/** Position of each moving row among the moving rows, null for the others. */
const ORDER: (number | null)[] = (() => {
  let n = 0;
  return ROWS.map((row) => (moves(row) ? n++ : null));
})();
const MOVING = ORDER.filter((n) => n !== null).length;

const TICK_MS = 300;
const EMPTY_TICKS = 2;
const HOLD_TICKS = 12;
const LOOP_TICKS = EMPTY_TICKS + MOVING + HOLD_TICKS;
/** The first pass starts with a few rows already landed, never an empty stage. */
const HEAD_START = 4;

type Side = "left" | "right" | "ghost";

const TONE = {
  left: {
    text: "text-zinc-400",
    strong: "text-zinc-200",
    cat: "text-zinc-500",
    icon: "text-zinc-500",
    mark: "bg-zinc-700 text-zinc-300",
    chip: "border-zinc-700 text-zinc-400",
  },
  right: {
    text: "text-paper",
    strong: "text-paper",
    cat: "text-paper-muted",
    icon: "text-paper-muted",
    mark: "bg-signal text-ink",
    chip: "border-white/15 text-paper",
  },
  ghost: {
    text: "text-signal",
    strong: "text-signal",
    cat: "text-signal",
    icon: "text-signal",
    mark: "bg-signal/30 text-signal",
    chip: "border-signal/40 text-signal",
  },
} as const;

function RowBody({ row, side }: { row: Row; side: Side }) {
  const tone = TONE[side];
  switch (row.kind) {
    case "server":
      return (
        <>
          <span
            className={cn(
              "grid h-[18px] w-[18px] shrink-0 place-items-center rounded-[5px] text-[8px] font-bold sm:h-5 sm:w-5 sm:text-[9px]",
              tone.mark,
            )}
          >
            {row.initials}
          </span>
          <span className={cn("truncate font-semibold", tone.strong)}>{row.name}</span>
        </>
      );
    case "cat":
      return (
        <span className={cn("pt-1.5 text-[10px] font-semibold uppercase tracking-[0.16em]", tone.cat)}>
          {row.label}
        </span>
      );
    case "text":
      return (
        <>
          <span className={cn("w-3 shrink-0 text-center", tone.icon)}>#</span>
          <span className={cn("truncate", tone.text)}>{row.name}</span>
          {row.locked && <Lock className={cn("ml-auto h-3 w-3 shrink-0", tone.icon)} aria-hidden />}
        </>
      );
    case "voice":
      return (
        <>
          <Volume2
            className={cn("h-3 w-3 shrink-0", row.live && side === "right" ? "text-signal" : tone.icon)}
            aria-hidden
          />
          <span className={cn("truncate", tone.text)}>{row.name}</span>
        </>
      );
    case "roles":
      return (
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          {row.roles.map((role) => (
            <span
              key={role.name}
              className={cn(
                "inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-[11px] leading-none",
                tone.chip,
              )}
            >
              <span
                className={cn("h-1.5 w-1.5 rounded-full", side === "left" ? "bg-zinc-500" : side === "ghost" ? "bg-signal" : role.dot)}
              />
              {role.name}
            </span>
          ))}
        </span>
      );
    case "stays":
      return <span className="truncate text-zinc-500">{row.label}</span>;
    case "gap":
      return null;
  }
}

/** One side of the stage: every row, at one height. */
function Column({
  side,
  arrived,
  from,
}: {
  side: Side;
  /** How many moving rows have landed. */
  arrived: number;
  /** Rows before this one landed without a flight (the head start). */
  from: number;
}) {
  return (
    <>
      {ROWS.map((row, i) => {
        const order = ORDER[i];
        const key = `${row.kind}-${i}`;

        if (row.kind === "gap") return <div key={key} className="h-2" />;

        const frame = "flex h-[var(--mv-row)] items-center gap-2 px-1.5 text-[12.5px] sm:px-2 sm:text-[13.5px]";

        if (row.kind === "stays") {
          if (side === "ghost") return <div key={key} className="h-[var(--mv-row)]" />;
          if (side === "left") return <div key={key} className={frame}><RowBody row={row} side="left" /></div>;
          // pqp side: an empty slot where the row did not come.
          return (
            <div
              key={key}
              className="flex h-[var(--mv-row)] items-center rounded-md border border-dashed border-white/10 px-2 text-[11px] text-paper-muted"
            >
              <span className="truncate">{row.note ?? "fica no Discord"}</span>
            </div>
          );
        }

        const on = order !== null && order < arrived;
        const go = order !== null && order >= from && order < arrived;

        if (side === "left") {
          return (
            <div key={key} data-go={go} className={cn("mv-src", frame)}>
              <RowBody row={row} side="left" />
            </div>
          );
        }
        if (side === "ghost") {
          return (
            <div key={key} data-go={go} className={cn("mv-ghost", frame)}>
              <RowBody row={row} side="ghost" />
            </div>
          );
        }
        return (
          <div key={key} data-on={on} className={cn("mv-in", frame)}>
            <RowBody row={row} side="right" />
          </div>
        );
      })}
    </>
  );
}

/** Ticks while the stage is on screen and nobody paused it. */
function useMoveClock(running: boolean) {
  const [state, setState] = useState({ tick: EMPTY_TICKS + HEAD_START, from: HEAD_START });
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setState((s) => (s.tick + 1 >= LOOP_TICKS ? { tick: 0, from: 0 } : { tick: s.tick + 1, from: s.from }));
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [running]);
  return [state, setState] as const;
}

export function MoveStage({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const rootRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(true);
  const [paused, setPaused] = useState(false);

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    io.observe(el);
    const onVisibility = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, []);

  const running = !reduced && !paused && visible;
  const [state, setState] = useMoveClock(running);

  // A paused stage and reduced motion both show the finished scene.
  const finished = reduced || paused;
  const arrived = finished ? MOVING : Math.min(MOVING, Math.max(0, state.tick - EMPTY_TICKS));
  const from = finished ? MOVING : state.from;

  return (
    <div ref={rootRef} className={cn("mv", className)}>
      <p className="sr-only">
        Exemplo animado: um servidor de exemplo chamado A Mesa. À esquerda, a barra lateral no Discord, com um servidor,
        categorias, canais de texto e de voz, um canal privado e cargos. À direita, a mesma barra lateral no pqp, com
        tudo no mesmo lugar. As mensagens, os membros e os emoji ficam no Discord.
      </p>

      <div aria-hidden>
        <div className="mv-cols mb-2.5 items-center text-[11px] font-semibold uppercase tracking-[0.2em]">
          <p className="pl-1 text-zinc-400">No Discord</p>
          <ArrowRight className="mx-auto h-3.5 w-3.5 text-signal" />
          <p className="pl-1 text-signal">No pqp</p>
        </div>

        <div className="relative">
          <div className="mv-cols">
            <div className="mv-panel border-zinc-800 bg-zinc-900">
              <Column side="left" arrived={arrived} from={from} />
            </div>
            <div className="flex justify-center py-3">
              <span className="h-full w-px border-l border-dashed border-white/10" />
            </div>
            <div className="mv-panel border-signal/25 bg-ink-2 shadow-[0_30px_90px_-45px_var(--color-accent)]">
              <Column side="right" arrived={arrived} from={from} />
            </div>
          </div>
          <div className="mv-cols pointer-events-none absolute inset-0">
            <div className="mv-panel border-transparent">
              <Column side="ghost" arrived={arrived} from={from} />
            </div>
          </div>
        </div>
      </div>

      <div className="mt-3 flex items-start justify-between gap-4">
        <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-xs leading-relaxed text-paper-muted">
          <Tag>exemplo</Tag>
          <span>Servidor de exemplo. Mensagens, membros e emoji ficam no Discord.</span>
        </p>
        {!reduced && (
          <button
            type="button"
            onClick={() => {
              if (paused) setState({ tick: 0, from: 0 });
              setPaused((p) => !p);
            }}
            aria-pressed={paused}
            className="inline-flex h-10 shrink-0 items-center gap-1.5 rounded-full px-3 text-xs font-medium text-paper-muted transition-colors hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
          >
            {paused ? <Play className="h-3 w-3" aria-hidden /> : <Pause className="h-3 w-3" aria-hidden />}
            {paused ? "Tocar" : "Pausar"}
          </button>
        )}
      </div>
    </div>
  );
}
