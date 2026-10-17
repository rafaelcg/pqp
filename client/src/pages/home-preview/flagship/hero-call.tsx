import { Hand, MonitorUp, Pause, Play, Plus, SendHorizontal } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import {
  AppWindow,
  Avatar,
  CAST,
  CallControls,
  CallTile,
  ChatMessage,
  SectionLabel,
  ServerRail,
  SoundBars,
  TextChannel,
  VoiceChannel,
  type Person,
} from "../shared/mock";
import { useReducedMotion } from "../shared/motion";

/**
 * The hero: a pqp call, drawn in the DOM and played as a short script.
 * Somebody asks "entra na call?", people drop in, a screen goes up with its
 * sound, the chat reacts. It is a demo, labelled as one, and everything in
 * it ships today.
 *
 * Reduced motion and a paused loop both show the finished scene. The loop
 * also stops while the window is off screen or the tab is hidden.
 */

type Line = { id: string; who: Person; text: string; reactions?: { emoji: string; count: number; mine?: boolean }[] };

interface Scene {
  inCall: Person[];
  sharing: Person | null;
  lines: Line[];
  you: boolean;
}

const BASE_LINES: Line[] = [
  { id: "a", who: CAST.rafa, text: "Mesa sábado às 20h. Traz a ficha." },
  { id: "b", who: CAST.bia, text: "dessa vez o mestre sou eu, se preparem" },
];

/** Each step applies on top of the previous ones. Times in ms. */
const STEPS: { at: number; apply: (s: Scene) => Scene }[] = [
  {
    at: 1200,
    apply: (s) => ({ ...s, lines: [...s.lines, { id: "c", who: CAST.caio, text: "entra na call?" }] }),
  },
  { at: 2600, apply: (s) => ({ ...s, inCall: [...s.inCall, CAST.caio] }) },
  {
    at: 4000,
    apply: (s) => ({
      ...s,
      lines: [...s.lines, { id: "d", who: CAST.nico, text: "bora. vou passar a tela, com som" }],
    }),
  },
  { at: 4600, apply: (s) => ({ ...s, inCall: [...s.inCall, CAST.nico] }) },
  { at: 5800, apply: (s) => ({ ...s, sharing: CAST.nico }) },
  {
    at: 7600,
    apply: (s) => ({
      ...s,
      lines: s.lines.map((l) =>
        l.id === "d" ? { ...l, reactions: [{ emoji: "🔥", count: 3 }, { emoji: "😂", count: 1 }] } : l,
      ),
    }),
  },
  {
    at: 9000,
    apply: (s) => ({
      ...s,
      lines: [...s.lines, { id: "e", who: CAST.bia, text: "o som do jogo tá chegando aqui" }],
    }),
  },
  { at: 10400, apply: (s) => ({ ...s, inCall: [...s.inCall, CAST.leo] }) },
  {
    at: 11400,
    apply: (s) => ({ ...s, lines: [...s.lines, { id: "f", who: CAST.leo, text: "cheguei, cadê a ficha" }] }),
  },
];

const LOOP_MS = 15000;

const START: Scene = { inCall: [CAST.rafa, CAST.bia, CAST.duda], sharing: null, lines: BASE_LINES, you: false };

function sceneAt(t: number, you: boolean): Scene {
  let s: Scene = { ...START, you };
  for (const step of STEPS) {
    if (t >= step.at) s = step.apply(s);
  }
  return s;
}

const FINAL_T = STEPS[STEPS.length - 1].at;

const YOU: Person = { name: "Você", tone: "plain" };

export function HeroCall({ className }: { className?: string }) {
  const reduced = useReducedMotion();
  const [t, setT] = useState(reduced ? FINAL_T : 0);
  const [paused, setPaused] = useState(false);
  const [hover, setHover] = useState(false);
  const [visible, setVisible] = useState(true);
  const [you, setYou] = useState(false);
  const [tick, setTick] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const running = !reduced && !paused && !hover && visible;

  useEffect(() => {
    const el = rootRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(([e]) => setVisible(e.isIntersecting));
    io.observe(el);
    const onVis = () => setVisible(document.visibilityState === "visible");
    document.addEventListener("visibilitychange", onVis);
    return () => {
      io.disconnect();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, []);

  // The script clock. 200 ms is fine-grained enough for steps a second apart.
  useEffect(() => {
    if (!running) return;
    const id = window.setInterval(() => {
      setT((prev) => (prev + 200 >= LOOP_MS ? 0 : prev + 200));
    }, 200);
    return () => window.clearInterval(id);
  }, [running]);

  // Who is talking: a slow rotation, independent of the script.
  useEffect(() => {
    if (reduced || paused) return;
    const id = window.setInterval(() => setTick((n) => n + 1), 1300);
    return () => window.clearInterval(id);
  }, [reduced, paused]);

  const scene = useMemo(() => sceneAt(reduced || paused ? Math.max(t, FINAL_T) : t, you), [t, reduced, paused, you]);
  const people = scene.you ? [...scene.inCall, YOU] : scene.inCall;
  const speaker = people.length ? people[tick % people.length].name : "";
  const fading = !reduced && t > LOOP_MS - 900;

  return (
    <div
      ref={rootRef}
      className={cn("@container relative", className)}
      onPointerEnter={(e) => e.pointerType === "mouse" && setHover(true)}
      onPointerLeave={() => setHover(false)}
    >
      <p className="sr-only">
        Demonstração: uma call no pqp. Alguém pergunta no chat se o pessoal entra na call, os amigos
        entram no canal de voz, o Nico compartilha a tela com som e o chat reage.
      </p>
      <AppWindow bodyClassName="h-[420px] @[720px]:h-[460px]">
        <div
          aria-hidden
          className={cn("flex h-full transition-opacity duration-700", fading ? "opacity-0" : "opacity-100")}
        >
          <div className="hidden @[560px]:flex">
            <ServerRail />
          </div>
          {/* Channels */}
          <div className="hidden w-[188px] shrink-0 flex-col border-r border-white/5 bg-ink-2/60 @[720px]:flex">
            <div className="flex h-12 items-center gap-2 border-b border-white/5 px-3">
              <span className="font-display text-sm font-bold">A Mesa</span>
              <span className="text-[10px] uppercase tracking-wider text-paper-muted">dono</span>
            </div>
            <SectionLabel>Texto</SectionLabel>
            <TextChannel name="geral" active />
            <TextChannel name="fichas" />
            <SectionLabel>Voz</SectionLabel>
            <VoiceChannel
              name="Lobby"
              active
              people={people}
              speaking={[speaker]}
              sharing={scene.sharing?.name}
            />
            <div className="mt-auto flex items-center gap-2 border-t border-white/5 px-3 py-2.5">
              <Avatar person={CAST.rafa} size={28} accent status="online" />
              <div className="min-w-0 flex-1 text-[11px] leading-tight">
                <p className="font-semibold text-paper">Rafa</p>
                <p className="text-signal">Na call</p>
              </div>
            </div>
          </div>
          {/* Stage */}
          <div className="flex min-w-0 flex-1 flex-col bg-ink">
            <div className="flex h-12 items-center gap-2 border-b border-white/5 px-4 text-sm">
              <span className="font-semibold">Lobby</span>
              <span className="text-xs text-paper-muted">{people.length} na call</span>
              {scene.sharing && (
                <span className="hp-pop ml-auto inline-flex items-center gap-1.5 rounded-full bg-signal/15 px-2 py-0.5 text-[11px] font-medium text-signal">
                  <MonitorUp className="h-3 w-3" />
                  tela com som
                  <SoundBars className="text-signal" />
                </span>
              )}
            </div>
            <div className="flex min-h-0 flex-1 flex-col gap-2 p-3">
              {scene.sharing ? (
                <>
                  <div className="hp-pop relative min-h-0 flex-1 overflow-hidden rounded-xl border border-signal/40 bg-black">
                    <img
                      src="/images/hero/hero-800.webp"
                      alt=""
                      width={800}
                      height={533}
                      decoding="async"
                      className="h-full w-full object-cover"
                    />
                    <span className="absolute left-2 top-2 inline-flex items-center gap-1.5 rounded-md bg-black/60 px-1.5 py-0.5 text-[11px] text-white">
                      <MonitorUp className="h-3 w-3 text-signal" />
                      Tela do {scene.sharing.name}
                    </span>
                    <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-md bg-black/60 px-1.5 py-0.5 text-[10px] font-medium text-white">
                      1080p
                    </span>
                  </div>
                  <div className="grid h-[76px] shrink-0 grid-cols-4 gap-2">
                    {people.slice(0, 4).map((p) => (
                      <CallTile key={p.name} person={p} speaking={p.name === speaker} className="h-full [&>span:first-child]:scale-75" />
                    ))}
                  </div>
                </>
              ) : (
                <div className={cn("grid min-h-0 flex-1 gap-2", people.length > 4 ? "grid-cols-3" : "grid-cols-2")}>
                  {people.map((p) => (
                    <CallTile key={p.name} person={p} speaking={p.name === speaker} className="hp-pop min-h-0" />
                  ))}
                </div>
              )}
              <CallControls sharing={Boolean(scene.sharing)} className="shrink-0 pt-1" />
            </div>
          </div>
          {/* Chat */}
          <div className="hidden w-[244px] shrink-0 flex-col border-l border-white/5 bg-ink-2/40 @[900px]:flex">
            <div className="flex h-12 items-center gap-1.5 border-b border-white/5 px-4 text-sm font-semibold">
              <span className="text-paper-muted">#</span>geral
            </div>
            <div className="flex min-h-0 flex-1 flex-col justify-end overflow-hidden py-2">
              {scene.lines.slice(-5).map((line) => (
                <ChatMessage key={line.id} person={line.who} className="hp-pop" reactions={line.reactions}>
                  {line.text}
                </ChatMessage>
              ))}
            </div>
            <div className="m-3 flex items-center gap-2 rounded-lg bg-ink-3/70 px-3 py-2 text-[12px] text-paper-muted">
              <Plus className="h-3.5 w-3.5" />
              <span className="flex-1">Mensagem em #geral</span>
              <SendHorizontal className="h-3.5 w-3.5" />
            </div>
          </div>
        </div>
      </AppWindow>

      {/* The two things a visitor can do to the demo. Real buttons, outside
          the aria-hidden picture. */}
      <div className="mt-3 flex items-center justify-between gap-3 text-xs text-paper-muted">
        <span className="inline-flex items-center gap-1.5">
          <span className="rounded border border-white/15 px-1.5 py-px text-[10px] uppercase tracking-wider">demo</span>
          O app de verdade, com gente de exemplo.
        </span>
        <span className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => setYou((v) => !v)}
            aria-pressed={you}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-full px-3 font-medium transition-colors",
              you ? "bg-signal text-ink" : "bg-white/[0.06] text-paper hover:bg-white/10",
            )}
          >
            <Hand className="h-3.5 w-3.5" aria-hidden />
            {you ? "Você tá na call" : "Entra na call"}
          </button>
          {!reduced && (
            <button
              type="button"
              onClick={() => setPaused((p) => !p)}
              className="grid h-8 w-8 place-items-center rounded-full bg-white/[0.06] text-paper transition-colors hover:bg-white/10"
              aria-label={paused ? "Continuar a animação" : "Pausar a animação"}
            >
              {paused ? <Play className="h-3.5 w-3.5" aria-hidden /> : <Pause className="h-3.5 w-3.5" aria-hidden />}
            </button>
          )}
        </span>
      </div>
    </div>
  );
}
