import { ArrowRight, Check, Hash, Info, Lock, Shuffle, Volume2 } from "lucide-react";
import { useEffect, useId, useRef, useState, type Dispatch, type SetStateAction } from "react";
import { cn } from "@/lib/utils";
import { CREATE_INTENT, IMPORT_INTENT, JoinButton } from "../shared/auth-buttons";
import { Avatar, AppWindow, CallControls, CallTile, ChatMessage, SectionLabel } from "../shared/mock";
import { useReducedMotion } from "../shared/motion";
import {
  CHANNELS,
  COLORS,
  LOBBY_PEOPLE,
  MESSAGES,
  NAME_MAX,
  SUGGESTIONS,
  type ChannelDef,
  type ChannelId,
  type ColorId,
} from "./data";
import { BTN_PRIMARY, BTN_SECONDARY, ExampleTag, MONO, PANEL, PanelHead } from "./ui";

/**
 * The builder. A draft in the page's state feeds three things: the inspector
 * (inputs), the live preview (a drawn pqp window) and, further down the page,
 * the invite card. It is a preview and nothing else: the sign-up intent only
 * opens "create community", so no name or channel ever travels with it. The
 * action bar says so next to the button.
 */

export interface Draft {
  name: string;
  color: ColorId;
  letters: 1 | 2;
  on: ChannelId[];
  active: ChannelId | null;
}

export const INITIAL_DRAFT: Draft = {
  name: "A Mesa",
  color: "violet",
  letters: 2,
  on: ["geral", "fichas", "lobby"],
  active: "geral",
};

export function displayName(draft: Draft): string {
  return draft.name.trim() || "Sem nome";
}

export function initials(name: string, letters: 1 | 2): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  if (letters === 1) return words[0].charAt(0).toUpperCase();
  if (words.length >= 2) return (words[0].charAt(0) + words[1].charAt(0)).toUpperCase();
  return words[0].slice(0, 2).toUpperCase();
}

/** The channel the preview shows: the one picked, or the first one still on. */
export function resolveActive(draft: Draft): ChannelId | null {
  if (draft.active && draft.on.includes(draft.active)) return draft.active;
  const firstText = CHANNELS.find((c) => c.kind !== "voice" && draft.on.includes(c.id));
  if (firstText) return firstText.id;
  return draft.on.includes("lobby") ? "lobby" : null;
}

export function ServerIcon({
  draft,
  className,
}: {
  draft: Draft;
  className?: string;
}) {
  const color = COLORS.find((c) => c.id === draft.color) ?? COLORS[0];
  return (
    <span
      aria-hidden
      className={cn(
        "grid shrink-0 place-items-center font-display font-bold text-zinc-950 transition-colors duration-300",
        color.cls,
        className,
      )}
    >
      {initials(draft.name, draft.letters)}
    </span>
  );
}

function channelIcon(kind: ChannelDef["kind"]) {
  return kind === "voice" ? Volume2 : kind === "private" ? Lock : Hash;
}

/* ------------------------------------------------------------------ */
/* Inspector                                                           */
/* ------------------------------------------------------------------ */

const FOCUS_RING =
  "peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-signal";

function NameField({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  const id = useId();
  const [next, setNext] = useState(1);
  return (
    <div>
      <div className="flex items-baseline justify-between">
        <label htmlFor={id} className={MONO}>
          Nome do servidor
        </label>
        <span className="font-mono text-[11px] tabular-nums text-paper-muted">
          {draft.name.length}/{NAME_MAX}
        </span>
      </div>
      <div className="relative mt-2">
        <input
          id={id}
          type="text"
          value={draft.name}
          maxLength={NAME_MAX}
          autoComplete="off"
          spellCheck={false}
          placeholder="Como a galera chama?"
          onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
          className="h-12 w-full rounded-xl border border-white/10 bg-ink px-4 pr-14 font-display text-lg font-semibold text-paper outline-none transition-colors placeholder:font-sans placeholder:text-base placeholder:font-normal placeholder:text-paper-muted/70 hover:border-white/20 focus:border-white/30 focus-visible:ring-2 focus-visible:ring-signal"
        />
        <button
          type="button"
          aria-label="Sugerir outro nome"
          onClick={() => {
            setDraft((d) => ({ ...d, name: SUGGESTIONS[next % SUGGESTIONS.length] }));
            setNext((n) => n + 1);
          }}
          className="absolute right-1 top-1 grid h-10 w-10 place-items-center rounded-lg text-paper-muted transition-colors hover:bg-white/10 hover:text-paper focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
        >
          <Shuffle className="h-4 w-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}

function IconField({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  const group = useId();
  const lettersGroup = useId();
  const twoLetters = initials(draft.name, 2);
  const oneLetter = initials(draft.name, 1);
  return (
    <div className="grid gap-4">
      <fieldset>
        <legend className={MONO}>Cor do ícone</legend>
        <div className="mt-2 flex flex-wrap gap-2">
          {COLORS.map((c) => {
            const on = draft.color === c.id;
            return (
              <label key={c.id} className="relative">
                <input
                  type="radio"
                  name={group}
                  value={c.id}
                  checked={on}
                  onChange={() => setDraft((d) => ({ ...d, color: c.id }))}
                  className="peer sr-only"
                />
                <span
                  title={c.label}
                  className={cn(
                    "grid h-10 w-10 cursor-pointer place-items-center rounded-xl text-zinc-950 transition-[box-shadow,transform] duration-200 hover:scale-105 sm:h-9 sm:w-9",
                    c.cls,
                    on && "ring-2 ring-paper ring-offset-2 ring-offset-ink-2",
                    FOCUS_RING,
                  )}
                >
                  {on && <Check className="h-4 w-4" strokeWidth={3} aria-hidden />}
                  <span className="sr-only">{c.label}</span>
                </span>
              </label>
            );
          })}
        </div>
      </fieldset>
      <fieldset>
        <legend className={MONO}>Letras no ícone</legend>
        <div className="mt-2 inline-flex rounded-xl border border-white/10 bg-ink p-1">
          {(
            [
              { v: 2, label: twoLetters },
              { v: 1, label: oneLetter },
            ] as const
          ).map((o) => (
            <label key={o.v} className="relative">
              <input
                type="radio"
                name={lettersGroup}
                value={o.v}
                checked={draft.letters === o.v}
                onChange={() => setDraft((d) => ({ ...d, letters: o.v }))}
                className="peer sr-only"
              />
              <span
                className={cn(
                  "grid h-10 min-w-14 cursor-pointer place-items-center rounded-lg px-4 font-display text-sm font-bold text-paper-muted transition-colors hover:text-paper peer-checked:bg-ink-3 peer-checked:text-paper sm:h-8",
                  FOCUS_RING,
                )}
              >
                {o.label}
                <span className="sr-only">
                  {o.v === 1 ? " (uma letra)" : " (duas letras)"}
                </span>
              </span>
            </label>
          ))}
        </div>
      </fieldset>
    </div>
  );
}

function ChannelToggle({
  def,
  on,
  onChange,
}: {
  def: ChannelDef;
  on: boolean;
  onChange: (on: boolean) => void;
}) {
  const Icon = channelIcon(def.kind);
  const voice = def.kind === "voice";
  return (
    <label className="relative block">
      <input
        type="checkbox"
        role="switch"
        checked={on}
        onChange={(e) => onChange(e.target.checked)}
        className="peer sr-only"
      />
      <span
        className={cn(
          "flex h-11 cursor-pointer items-center gap-1.5 rounded-xl border px-2.5 text-[13px] transition-colors sm:h-10 sm:gap-2 sm:px-3 sm:text-sm",
          on
            ? "border-white/25 bg-white/[0.07] text-paper"
            : "border-white/10 text-paper-muted hover:border-white/20 hover:text-paper",
          FOCUS_RING,
        )}
      >
        <Icon className={cn("h-4 w-4 shrink-0", on && voice ? "text-signal" : "opacity-70")} aria-hidden />
        <span className="min-w-0 flex-1 truncate">{def.name}</span>
        <span
          aria-hidden
          className={cn(
            "relative h-4 w-7 shrink-0 rounded-full transition-colors duration-200",
            on ? (voice ? "bg-signal" : "bg-paper") : "bg-white/15",
          )}
        >
          <span
            className={cn(
              "absolute left-0.5 top-0.5 h-3 w-3 rounded-full bg-ink transition-transform duration-200",
              on && "translate-x-3",
            )}
          />
        </span>
      </span>
    </label>
  );
}

function Inspector({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  const toggle = (id: ChannelId, on: boolean) =>
    setDraft((d) => ({
      ...d,
      on: on ? [...d.on.filter((x) => x !== id), id] : d.on.filter((x) => x !== id),
      active: on ? id : d.active,
    }));
  const text = CHANNELS.filter((c) => c.kind === "text");
  const rest = CHANNELS.filter((c) => c.kind !== "text");
  return (
    <>
      <div className={cn(PANEL, "order-1 lg:rounded-b-none")}>
        <PanelHead n="01" label="Servidor" />
        <div className="grid gap-5 p-4">
          <NameField draft={draft} setDraft={setDraft} />
          <IconField draft={draft} setDraft={setDraft} />
        </div>
      </div>
      <div className={cn(PANEL, "order-3 lg:order-2 lg:rounded-t-none lg:border-t-0")}>
        <PanelHead
          n="02"
          label="Canais"
          right={
            <span className="font-mono text-[11px] tabular-nums text-paper-muted" aria-live="polite">
              {draft.on.length} de {CHANNELS.length} ligados
            </span>
          }
        />
        <div className="grid gap-4 p-4">
          <fieldset>
            <legend className={MONO}>Texto</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {text.map((c) => (
                <ChannelToggle key={c.id} def={c} on={draft.on.includes(c.id)} onChange={(on) => toggle(c.id, on)} />
              ))}
            </div>
          </fieldset>
          <fieldset>
            <legend className={MONO}>Voz e privado</legend>
            <div className="mt-2 grid grid-cols-2 gap-2">
              {rest.map((c) => (
                <ChannelToggle key={c.id} def={c} on={draft.on.includes(c.id)} onChange={(on) => toggle(c.id, on)} />
              ))}
            </div>
          </fieldset>
        </div>
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Live preview                                                        */
/* ------------------------------------------------------------------ */

/** True while the element is on screen. Live, unlike `useInView`. */
function useOnScreen<T extends Element>() {
  const ref = useRef<T>(null);
  const [visible, setVisible] = useState(true);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting));
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return [ref, visible] as const;
}

/** Who is talking in the Lobby. Frozen when the page is out of view or motion is reduced. */
function useSpeaker(count: number, paused: boolean) {
  const [index, setIndex] = useState(1);
  useEffect(() => {
    if (paused) return;
    const timer = window.setInterval(() => setIndex((i) => (i + 1) % count), 2300);
    return () => window.clearInterval(timer);
  }, [count, paused]);
  return index;
}

function Rail({ draft }: { draft: Draft }) {
  return (
    <div
      className="hidden w-14 shrink-0 flex-col items-center gap-2 border-r border-white/5 bg-rail py-3 min-[420px]:flex"
      aria-hidden
    >
      <span className="relative">
        <ServerIcon draft={draft} className="h-9 w-9 rounded-xl text-xs" />
        <span className="absolute -left-3 top-2 h-5 w-1 rounded-r bg-paper" />
      </span>
      {["RP", "CS"].map((label) => (
        <span
          key={label}
          className="grid h-9 w-9 place-items-center rounded-full bg-ink-3 font-display text-[11px] font-bold text-paper-muted"
        >
          {label}
        </span>
      ))}
      <span className="grid h-9 w-9 place-items-center rounded-full bg-ink-3 text-lg text-paper-muted">+</span>
    </div>
  );
}

function ChannelRow({
  def,
  active,
  onPick,
}: {
  def: ChannelDef;
  active: boolean;
  onPick: () => void;
}) {
  const Icon = channelIcon(def.kind);
  const voice = def.kind === "voice";
  return (
    <button
      type="button"
      onClick={onPick}
      aria-current={active ? "true" : undefined}
      className={cn(
        "hp-pop mx-2 flex w-[calc(100%-1rem)] items-center gap-1.5 rounded-lg px-2 py-1.5 text-left text-[13px] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal",
        active
          ? voice
            ? "border border-signal/50 bg-signal/10 text-signal"
            : "bg-white/[0.06] text-paper"
          : "text-paper-muted hover:bg-white/[0.04] hover:text-paper",
      )}
    >
      <Icon className="h-3.5 w-3.5 shrink-0 opacity-80" aria-hidden />
      <span className="min-w-0 flex-1 truncate">{def.name}</span>
      {voice && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-signal" aria-hidden />}
    </button>
  );
}

function Sidebar({
  draft,
  active,
  onPick,
  speaker,
}: {
  draft: Draft;
  active: ChannelId | null;
  onPick: (id: ChannelId) => void;
  speaker: number;
}) {
  const on = (c: ChannelDef) => draft.on.includes(c.id);
  const texts = CHANNELS.filter((c) => c.kind !== "voice" && on(c));
  const lobby = CHANNELS.find((c) => c.kind === "voice" && on(c));
  return (
    <div className="flex min-w-0 flex-1 flex-col bg-ink-2/60 sm:w-[190px] sm:flex-none lg:w-[200px]">
      <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-3">
        <span className="min-w-0 truncate font-display text-[15px] font-semibold text-paper">
          {displayName(draft)}
        </span>
        <span className="shrink-0 font-mono text-[9px] uppercase tracking-[0.14em] text-paper-muted">dono</span>
      </div>
      <div className="c4-scroll min-h-0 flex-1 overflow-y-auto pb-3">
        {texts.length === 0 && !lobby && (
          <p className="px-4 pt-5 text-[13px] leading-snug text-paper-muted">
            Nenhum canal ligado. Liga um em &ldquo;Canais&rdquo; pra ele aparecer aqui.
          </p>
        )}
        {texts.length > 0 && <SectionLabel>Texto</SectionLabel>}
        {texts.map((c) => (
          <ChannelRow key={c.id} def={c} active={active === c.id} onPick={() => onPick(c.id)} />
        ))}
        {lobby && (
          <>
            <SectionLabel>Voz</SectionLabel>
            <ChannelRow def={lobby} active={active === lobby.id} onPick={() => onPick(lobby.id)} />
            <ul className="ml-5 mt-1 space-y-1 border-l border-white/5 pl-3">
              {LOBBY_PEOPLE.map((p, i) => (
                <li key={p.name} className="flex items-center gap-2 text-[12px] text-paper-muted">
                  <Avatar person={p} size={20} accent speaking={i === speaker} />
                  <span>{p.name}</span>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  );
}

function CallStage({ speaker }: { speaker: number }) {
  return (
    <div key="lobby" className="hp-pop flex min-h-0 flex-1 flex-col">
      <div className="grid min-h-0 flex-1 grid-cols-3 gap-2 p-3">
        {LOBBY_PEOPLE.map((p, i) => (
          <CallTile key={p.name} person={p} speaking={i === speaker} className="h-full" />
        ))}
      </div>
      <CallControls className="pb-3" />
    </div>
  );
}

function Chat({ id, name }: { id: Exclude<ChannelId, "lobby">; name: string }) {
  const priv = id === "bastidores";
  return (
    <div key={id} className="hp-pop flex min-h-0 flex-1 flex-col">
      {priv && (
        <p className="mx-4 mt-3 flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.03] px-3 py-2 text-[12px] text-paper-muted">
          <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Canal privado. Só quem tem permissão enxerga.
        </p>
      )}
      <div className="min-h-0 flex-1 overflow-hidden py-2">
        {MESSAGES[id].map((m) => (
          <ChatMessage key={m.text} person={m.who} time={m.time} reactions={m.reactions}>
            {m.text}
          </ChatMessage>
        ))}
      </div>
      <div
        className="mx-3 mb-3 flex h-10 shrink-0 items-center rounded-lg border border-white/10 bg-ink-2 px-3 text-[13px] text-paper-muted"
        aria-hidden
      >
        Mensagem em #{name}
      </div>
    </div>
  );
}

function ServerPreview({
  draft,
  onPick,
}: {
  draft: Draft;
  onPick: (id: ChannelId) => void;
}) {
  const reduced = useReducedMotion();
  const [ref, visible] = useOnScreen<HTMLDivElement>();
  const speaker = useSpeaker(LOBBY_PEOPLE.length, reduced || !visible);
  const active = resolveActive(draft);
  const activeDef = CHANNELS.find((c) => c.id === active);
  const hasLobby = draft.on.includes("lobby");
  const names = CHANNELS.filter((c) => draft.on.includes(c.id)).map((c) => c.name);

  return (
    <div
      ref={ref}
      className="c4-dots relative order-2 h-[400px] rounded-2xl border border-white/10 bg-ink-2/40 lg:order-none lg:col-start-2 lg:row-span-2 lg:row-start-1 lg:h-auto"
    >
      <div className="absolute inset-0 flex flex-col p-3 sm:p-4 lg:p-5">
        <div className="mb-3 flex shrink-0 items-center justify-between gap-3">
          <p className={MONO}>
            <span className="mr-2 inline-block h-1.5 w-1.5 rounded-full bg-signal align-middle" aria-hidden />
            Prévia ao vivo
          </p>
          <ExampleTag>conversa de exemplo</ExampleTag>
        </div>
        <p className="sr-only">
          Prévia do servidor {displayName(draft)}.{" "}
          {names.length > 0 ? `Canais ligados: ${names.join(", ")}.` : "Nenhum canal ligado."}
        </p>
        <AppWindow className="flex min-h-0 flex-1 flex-col" bodyClassName="flex min-h-0 flex-1">
          <Rail draft={draft} />
          <Sidebar draft={draft} active={active} onPick={onPick} speaker={speaker} />
          <div className="hidden min-w-0 flex-1 flex-col border-l border-white/5 sm:flex">
            <div className="flex h-12 shrink-0 items-center gap-2 border-b border-white/5 px-4">
              {activeDef ? (
                <>
                  {(() => {
                    const Icon = channelIcon(activeDef.kind);
                    return <Icon className="h-4 w-4 text-paper-muted" aria-hidden />;
                  })()}
                  <span className="font-display text-[15px] font-semibold">{activeDef.name}</span>
                  {activeDef.kind === "voice" && (
                    <span className="text-xs text-signal">{LOBBY_PEOPLE.length} na call</span>
                  )}
                </>
              ) : (
                <span className="text-sm text-paper-muted">Sem canal</span>
              )}
            </div>
            {activeDef?.kind === "voice" ? (
              <CallStage speaker={speaker} />
            ) : activeDef ? (
              <>
                {hasLobby && (
                  <button
                    type="button"
                    onClick={() => onPick("lobby")}
                    className="mx-4 mt-3 flex shrink-0 items-center gap-2 rounded-lg border border-signal/30 bg-signal/10 px-3 py-2 text-left text-xs text-signal transition-colors hover:bg-signal/15 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-signal"
                  >
                    <Volume2 className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="font-medium">Lobby</span>
                    <span className="text-paper-muted">{LOBBY_PEOPLE.length} na call</span>
                    <span className="ml-auto flex -space-x-1.5" aria-hidden>
                      {LOBBY_PEOPLE.map((p, i) => (
                        <Avatar
                          key={p.name}
                          person={p}
                          size={20}
                          accent
                          speaking={i === speaker}
                          className="[&>span:first-child]:ring-offset-1"
                        />
                      ))}
                    </span>
                  </button>
                )}
                <Chat id={activeDef.id as Exclude<ChannelId, "lobby">} name={activeDef.name} />
              </>
            ) : (
              <p className="m-auto max-w-[16rem] px-4 text-center text-sm leading-snug text-paper-muted">
                Sem canais, sem conversa. Liga um canal ao lado pra ver como fica.
              </p>
            )}
          </div>
        </AppWindow>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Action bar                                                          */
/* ------------------------------------------------------------------ */

function ActionBar() {
  return (
    <div className="order-4 lg:col-span-2 lg:mt-4">
      <div className={cn(PANEL, "flex flex-col gap-4 p-4 lg:flex-row lg:items-center lg:justify-between lg:gap-8 lg:px-5")}>
        <p className="flex max-w-xl items-start gap-3 text-sm leading-relaxed text-paper-muted">
          <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>
            <span className="text-paper">Isso aqui é uma prévia.</span> No app você cria a sala de verdade em
            segundos e escolhe tudo de novo.
          </span>
        </p>
        <div className="flex flex-col gap-2 sm:flex-row sm:shrink-0">
          <JoinButton intent={IMPORT_INTENT} className={BTN_SECONDARY}>
            Trazer do Discord
          </JoinButton>
          <JoinButton intent={CREATE_INTENT} className={BTN_PRIMARY}>
            Criar a sala de verdade
            <ArrowRight className="h-4 w-4" aria-hidden />
          </JoinButton>
        </div>
      </div>
      <p className="mt-3 text-sm text-paper-muted">Grátis, sem cartão. Entra com Google, Apple ou Twitch.</p>
    </div>
  );
}

export function Builder({
  draft,
  setDraft,
}: {
  draft: Draft;
  setDraft: Dispatch<SetStateAction<Draft>>;
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[400px_minmax(0,1fr)] lg:gap-x-4 lg:gap-y-0">
      <Inspector draft={draft} setDraft={setDraft} />
      <ServerPreview draft={draft} onPick={(id) => setDraft((d) => ({ ...d, active: id }))} />
      <ActionBar />
    </div>
  );
}
