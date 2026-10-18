import { Info } from "lucide-react";
import { type ReactNode, useEffect, useState } from "react";
import { cn } from "@/lib/utils";
import { Avatar, Name, type Person } from "../shared/mock";
import { useInView, useReducedMotion } from "../shared/motion";
import "./thread.css";

/**
 * The thread. Every row is a `li > article` in one ordered list. The first
 * pqp message and its pinned card are drawn at once (the headline never waits
 * on an observer); everything below fades and lifts in as it scrolls into
 * view. Reduced motion draws the whole thread from the first frame.
 */

const REVEAL = "transition-[opacity,transform] duration-500 ease-out";
const SHOWN = "translate-y-0 opacity-100";
const HIDDEN = "translate-y-3 opacity-0";

/** Fades and lifts a block in once it is on screen. */
export function Reveal({
  children,
  className,
  instant = false,
  after = true,
}: {
  children: ReactNode;
  className?: string;
  instant?: boolean;
  /** Hold the reveal until something else (the message text) has appeared. */
  after?: boolean;
}) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLDivElement>();
  const on = reduced || instant || (inView && after);
  return (
    <div ref={ref} className={cn(REVEAL, on ? SHOWN : HIDDEN, className)}>
      {children}
    </div>
  );
}

/** Flips to true `ms` after `start` turns true. Never flips back. */
function useTyped(start: boolean, ms: number) {
  const [typed, setTyped] = useState(false);
  useEffect(() => {
    if (!start) return;
    const id = window.setTimeout(() => setTyped(true), ms);
    return () => window.clearTimeout(id);
  }, [start, ms]);
  return typed;
}

/** The label every friend carries. These conversations are scripted. */
export function Exemplo({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded border border-white/20 px-1.5 py-px text-[10px] font-semibold uppercase leading-4 tracking-wider text-paper-muted",
        className,
      )}
    >
      exemplo
    </span>
  );
}

/** "pqp está digitando": three dots, decorative. */
export function TypingDots({ className }: { className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("inline-flex items-center gap-1 rounded-full bg-ink-3 px-3 py-2", className)}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          className="c3-dot h-1.5 w-1.5 rounded-full bg-paper-muted"
          style={{ animationDelay: `${i * 0.16}s` }}
        />
      ))}
    </span>
  );
}

export interface MsgProps {
  person: Person;
  /** Shown on the first message of a cluster. */
  time?: string;
  /** A second message from the same person: no avatar, no header. */
  cont?: boolean;
  /** A friend in the scripted conversation. */
  example?: boolean;
  /** Show "digitando" for this long before the text appears. */
  typingMs?: number;
  /** Draw at once, no reveal (the first screen). */
  instant?: boolean;
  reactions?: { emoji: string; count: number; mine?: boolean }[];
  /** The rich card this message expands into. */
  card?: ReactNode;
  /** Anchor for the chapter index. */
  id?: string;
  className?: string;
  children: ReactNode;
}

export function Msg({
  person,
  time,
  cont = false,
  example = false,
  typingMs = 0,
  instant = false,
  reactions,
  card,
  id,
  className,
  children,
}: MsgProps) {
  const reduced = useReducedMotion();
  const [ref, inView] = useInView<HTMLElement>();
  const immediate = reduced || instant;
  const typed = useTyped(inView && !immediate && typingMs > 0, typingMs);

  const isPqp = person.name === "pqp";
  const headOn = immediate || inView;
  const textOn = immediate || (typingMs > 0 ? typed : inView);
  const typingNow = !immediate && typingMs > 0 && inView && !typed;

  const label = cont
    ? person.name
    : `${person.name}${example ? ", mensagem de exemplo" : ""}${time ? `, ${time}` : ""}`;

  return (
    <li id={id} className={cn("scroll-mt-28", cont ? "pt-1.5" : "pt-8", className)}>
      <article
        ref={ref}
        aria-label={label}
        className="grid grid-cols-[2.5rem_minmax(0,1fr)] items-start gap-x-3 sm:grid-cols-[2.75rem_minmax(0,1fr)] sm:gap-x-4"
      >
        {!cont && (
          <span className={cn(REVEAL, headOn ? SHOWN : HIDDEN, "sm:row-span-2")}>
            <Avatar person={person} size={40} accent={isPqp} className={cn(!isPqp && "[&>span]:text-paper")} />
          </span>
        )}
        {!cont && (
          <header className={cn(REVEAL, headOn ? SHOWN : HIDDEN, "flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 self-center sm:self-end")}>
            {isPqp ? (
              <>
                <span className="font-display text-[16px] font-bold text-signal">pqp</span>
                <span className="rounded border border-signal/40 bg-signal/10 px-1.5 py-px text-[10px] font-bold uppercase leading-4 tracking-wider text-signal">
                  oficial
                </span>
              </>
            ) : (
              <>
                <Name person={person} className="text-[16px]" />
                {example && <Exemplo />}
              </>
            )}
            {time && <span className="text-xs tabular-nums text-paper-muted">{time}</span>}
          </header>
        )}

        <div
          className={cn(
            "relative col-span-2 min-w-0 sm:col-span-1 sm:col-start-2",
            cont ? "col-start-1" : "mt-2 sm:mt-1",
          )}
        >
          <div
            className={cn(
              REVEAL,
              textOn ? SHOWN : HIDDEN,
              isPqp
                ? "text-[18px] leading-[1.45] text-paper sm:text-[19px]"
                : "text-[16px] leading-relaxed text-paper/90 sm:text-[17px]",
            )}
          >
            {children}
          </div>
          {typingNow && (
            <span aria-hidden className="absolute left-0 top-0 inline-flex items-center gap-2 text-xs text-paper-muted">
              <TypingDots />
              {person.name} está digitando
            </span>
          )}
          {reactions && (
            <div className={cn(REVEAL, textOn ? SHOWN : HIDDEN, "mt-2 flex flex-wrap gap-1.5")}>
              {reactions.map((r) => (
                <span
                  key={r.emoji}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-xs tabular-nums",
                    r.mine
                      ? "border-signal/50 bg-signal/10 text-signal"
                      : "border-white/10 bg-white/[0.04] text-paper-muted",
                  )}
                >
                  <span aria-hidden className="text-sm leading-none">
                    {r.emoji}
                  </span>
                  <span aria-hidden>{r.count}</span>
                  <span className="sr-only">{`${r.count} reações`}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        {card && (
          <Reveal
            instant={instant}
            after={textOn}
            className="col-span-2 mt-4 min-w-0 sm:col-span-1 sm:col-start-2"
          >
            {card}
          </Reveal>
        )}
      </article>
    </li>
  );
}

/** "hoje", "mais tarde", "Novas mensagens": the lines that break a thread up. */
export function Divider({ children, tone = "plain" }: { children: ReactNode; tone?: "plain" | "new" }) {
  return (
    <li className="pt-8">
      <div className="flex items-center gap-4" role="presentation">
        <span aria-hidden className={cn("h-px flex-1", tone === "new" ? "bg-signal/40" : "bg-white/10")} />
        <span
          className={cn(
            "rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-[0.16em]",
            tone === "new"
              ? "border-signal/40 bg-signal/10 text-signal"
              : "border-white/10 bg-ink-2 text-paper-muted",
          )}
        >
          {children}
        </span>
        <span aria-hidden className={cn("h-px flex-1", tone === "new" ? "bg-signal/40" : "bg-white/10")} />
      </div>
    </li>
  );
}

/** A line from the system, centred, like the app's join notices. */
export function SystemNote({ children }: { children: ReactNode }) {
  return (
    <li className="pt-5">
      <p className="mx-auto flex max-w-lg items-start gap-2.5 rounded-xl border border-white/10 bg-white/[0.03] px-3.5 py-2.5 text-[13.5px] leading-snug text-paper-muted">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-paper-muted" aria-hidden />
        <span>{children}</span>
      </p>
    </li>
  );
}

/** Somebody typing at the tail of the thread. Decorative. */
export function TypingRow({ children }: { children: ReactNode }) {
  return (
    <li aria-hidden className="pt-8">
      <div className="flex items-center gap-3 text-[13px] text-paper-muted">
        <TypingDots />
        {children}
      </div>
    </li>
  );
}
