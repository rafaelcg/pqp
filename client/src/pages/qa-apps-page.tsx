import { useState, type ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { AppJoinSheet, type AppJoinSheetProps } from "@/components/apps/app-join-sheet";
import { AppSessionStrip, type StripShareState } from "@/components/apps/app-session-strip";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CardPerson } from "@/lib/apps/card-model";
import type { EndedStripModel, LiveStripModel } from "@/lib/apps/strip-model";
import { isDesktopApp } from "@/lib/desktop";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";

/**
 * The session strip in every state of mock 03, on one page, at the width the
 * page has (desktop) and at a phone's 390 (the collapsed bar and its sheet).
 *
 * Like `/qa/ui` it is a workbench: it exists for whoever is changing the strip
 * and for the screenshots a PR carries, it needs no account, no socket and no
 * apps origin, and off the dev auth bypass it behaves like an unknown path.
 * Some states cannot be reached from a local checkout at all (the host's
 * countdown needs the sweep job, a share needs a picker a headless browser
 * does not have), which is the reason this page exists next to the live
 * two-user checks and does not replace them.
 */

const people = (names: string[]): CardPerson[] =>
  names.map((name) => ({ userId: `id-${name}`, displayName: name, avatarUrl: null }));

const APP = { id: "pqp-eco", name: "Sala de jogos", icon: "gamepad" } as const;

const ROSTER: LiveStripModel["roster"] = [
  { userId: "id-bia", name: "bia", avatarUrl: null, host: true, spectator: false, reconnecting: false },
  { userId: "id-leo", name: "leo", avatarUrl: null, host: false, spectator: false, reconnecting: false },
  { userId: "id-duda", name: "duda", avatarUrl: null, host: false, spectator: false, reconnecting: false },
];

function live(over: Partial<LiveStripModel>): LiveStripModel {
  return {
    kind: "live",
    sessionId: "qa",
    app: APP,
    phase: "participant",
    tone: "normal",
    line: { kind: "hostIs", name: "bia" },
    people: people(["bia", "leo", "duda"]),
    more: 0,
    count: { kind: "of", players: 3, max: 4, watching: 0 },
    roster: ROSTER,
    seated: true,
    isHost: false,
    spectating: false,
    showPane: true,
    actions: { leave: true, end: false, enter: null, takeHost: false, share: false },
    ...over,
  };
}

const HOST = live({
  phase: "host",
  isHost: true,
  line: { kind: "host" },
  actions: { leave: true, end: true, enter: null, takeHost: false, share: true },
});

const SHARE_OFF: StripShareState = {
  visible: true,
  on: false,
  pending: false,
  needsCall: false,
  viewers: 0,
  wholeTab: false,
};

interface Case {
  id: string;
  title: string;
  note: string;
  model: LiveStripModel | EndedStripModel;
  share?: StripShareState;
}

const CASES: Case[] = [
  {
    id: "host-share-off",
    title: "Estado 1: host, app com compartilhar tela, desligado",
    note: "A chave só existe se o manifesto diz share: pane e o servidor permite.",
    model: HOST,
    share: SHARE_OFF,
  },
  {
    id: "host-sharing",
    title: "Estado 2: host compartilhando",
    note: "O selo verde é role=status e conta quem está na call.",
    model: HOST,
    share: { ...SHARE_OFF, on: true, viewers: 7 },
  },
  {
    id: "host-needs-call",
    title: "Host fora da call: a chave diz por quê",
    note: "Mostrada, não escondida: o motivo vem escrito.",
    model: HOST,
    share: { ...SHARE_OFF, needsCall: true },
  },
  {
    id: "participant",
    title: "Estado 3: participante",
    note: "Sem Encerrar. Sair não termina a sessão pros outros.",
    model: live({}),
  },
  {
    id: "host-no-share",
    title: "Estado 4: app que não compartilha, tu és host",
    note: "O controle simplesmente não existe.",
    model: live({
      phase: "host",
      isHost: true,
      line: { kind: "host" },
      people: people(["duda", "bia", "leo", "rafa"]),
      count: { kind: "open", players: 4, watching: 0 },
      actions: { leave: true, end: true, enter: null, takeHost: false, share: false },
    }),
  },
  {
    id: "spectator",
    title: "Estado 5: espectador",
    note: "Mesmo layout do participante; o texto troca pra Assistindo.",
    model: live({
      phase: "spectator",
      spectating: true,
      line: { kind: "watching", name: "bia" },
      count: { kind: "of", players: 4, max: 4, watching: 2 },
    }),
  },
  {
    id: "handoff-you",
    title: "Estado 6: host saiu, tu és o próximo",
    note: "Amarela (warning-soft), contagem de 1:48, Assumir agora.",
    model: live({
      phase: "handoff-you",
      tone: "warn",
      line: { kind: "handoffYou", host: "bia", seconds: 108 },
      count: { kind: "of", players: 2, max: 4, watching: 0 },
      actions: { leave: true, end: false, enter: null, takeHost: true, share: false },
    }),
  },
  {
    id: "handoff-other",
    title: "Estado 7: host saiu, vista dos demais",
    note: "Só o texto. O servidor escolhe quem assume.",
    model: live({
      phase: "handoff-other",
      tone: "warn",
      line: { kind: "handoffOther", host: "bia", next: "leo", seconds: 108 },
      count: { kind: "of", players: 2, max: 4, watching: 0 },
    }),
  },
  {
    id: "reconnecting",
    title: "Estado 8: sem conexão",
    note: "O painel congela com véu de 40 %; o lugar fica guardado por 90 s.",
    model: live({
      phase: "reconnecting",
      tone: "off",
      line: { kind: "reconnecting" },
      people: [],
    }),
  },
  {
    id: "lost",
    title: "Passados os 90 s",
    note: "O lugar foi liberado; Sair some, o painel também.",
    model: live({
      phase: "lost",
      tone: "off",
      line: { kind: "lost" },
      people: [],
      showPane: false,
      actions: { leave: true, end: false, enter: null, takeHost: false, share: false },
    }),
  },
  {
    id: "outside",
    title: "Sessão viva e tu não estás nela",
    note: "A faixa fica enquanto a sessão existir, mesmo depois de sair e voltar.",
    model: live({
      phase: "outside",
      seated: false,
      showPane: false,
      actions: { leave: false, end: false, enter: "join", takeHost: false, share: false },
    }),
  },
  {
    id: "outside-full",
    title: "Sala cheia, o app aceita espectadores",
    note: "Assistir no lugar de Entrar.",
    model: live({
      phase: "outside",
      seated: false,
      showPane: false,
      count: { kind: "of", players: 4, max: 4, watching: 2 },
      actions: { leave: false, end: false, enter: "watch", takeHost: false, share: false },
    }),
  },
  {
    id: "ended",
    title: "Estado 9: encerrada",
    note: "Recolhe sozinha em 8 s, sem mover o foco; Fechar recolhe já.",
    model: {
      kind: "ended",
      sessionId: "qa",
      app: APP,
      disabled: false,
      cause: { kind: "host", name: "bia", self: false },
      summary: { participants: 4, durationSeconds: 23 * 60 },
    },
  },
  {
    id: "ended-disabled",
    title: "Estado 10: o operador desligou o app",
    note: "A razão sem culpa: diz que desligou.",
    model: {
      kind: "ended",
      sessionId: "qa",
      app: APP,
      disabled: true,
      cause: { kind: "unknown" },
      summary: null,
    },
  },
];

const SHEET_FACES: Array<{ id: string; label: string; props: Partial<AppJoinSheetProps> }> = [
  { id: "ask", label: "Estado 1: primeira vez", props: { face: "ask" } },
  { id: "ask-id", label: "Estado 2: o app pede o id", props: { face: "ask", asksForId: true } },
  { id: "entering", label: "Estado 3: entrando", props: { face: "entering" } },
  { id: "failed", label: "Estado 4: falhou por conexão", props: { face: "failed" } },
  { id: "full", label: "Estado 5: a sala encheu", props: { face: "full" } },
  { id: "ended", label: "Estado 6: já terminou", props: { face: "ended" } },
  { id: "disabled", label: "Estado 7: desligado", props: { face: "disabled" } },
];

function SheetCases() {
  const [open, setOpen] = useState<string | null>(null);
  const [identity, setIdentity] = useState(false);
  const chosen = SHEET_FACES.find((one) => one.id === open);
  return (
    <section data-case="join-sheet" className="flex flex-col gap-2">
      <h2 className="text-sm font-semibold">Diálogo de entrada (mock 04)</h2>
      <div className="flex flex-wrap gap-2">
        {SHEET_FACES.map((one) => (
          <button
            key={one.id}
            type="button"
            data-sheet={one.id}
            className="rounded-[var(--radius-control)] border border-border px-3 py-1 text-xs"
            onClick={() => setOpen(one.id)}
          >
            {one.label}
          </button>
        ))}
      </div>
      {chosen ? (
        <AppJoinSheet
          open
          face="ask"
          app={{
            name: "Sala de jogos",
            icon: "gamepad",
            notice: "Teu jogo fica no teu computador. O pqp não guarda nem envia jogos.",
          }}
          starterName="bia"
          countLine="3 dentro, cabem 4"
          viewer={{ name: "rafa", avatarUrl: null }}
          asksForId={false}
          identityChecked={identity}
          onIdentityChange={setIdentity}
          failure="connection"
          canWatch
          fullLine="4 de 4 jogando. 2 assistindo."
          endedLine="bia encerrou Sala de jogos há 1 min."
          onEnter={() => {}}
          onWatch={() => {}}
          onClose={() => setOpen(null)}
          {...chosen.props}
        />
      ) : null}
    </section>
  );
}

function Frame({ children, width }: { children: ReactNode; width: number }) {
  return (
    <div
      className="overflow-hidden rounded-xl border border-border bg-surface-0"
      style={{ width, maxWidth: "100%" }}
    >
      {children}
      <div className="grid h-24 place-items-center bg-surface-0 text-xs text-text-tertiary">
        (o app aparece aqui)
      </div>
    </div>
  );
}

export function QaAppsPage() {
  const [compact, setCompact] = useState(false);
  if (!isDevAuthBypassEnabled() || isDesktopApp()) {
    return <Navigate to="/" replace />;
  }
  // The pane share is never offered on a phone.
  const cases = compact ? CASES.filter((one) => one.share === undefined) : CASES;
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-5xl flex-col gap-8 p-6 text-text">
        <header className="flex flex-wrap items-center gap-4">
          <h1 className="font-display text-2xl font-bold">Faixa da sessão</h1>
          <button
            type="button"
            className="rounded-[var(--radius-control)] border border-border px-3 py-1 text-sm"
            aria-pressed={compact}
            onClick={() => setCompact((value) => !value)}
          >
            {compact ? "Celular 390" : "Desktop"}
          </button>
        </header>
        <SheetCases />
        {cases.map((one) => (
          <section key={one.id} data-case={one.id} className="flex flex-col gap-2">
            <h2 className="text-sm font-semibold">{one.title}</h2>
            <Frame width={compact ? 390 : 968}>
              <AppSessionStrip model={one.model} compact={compact} share={one.share} />
            </Frame>
            <p className="max-w-xl text-xs text-text-tertiary">{one.note}</p>
          </section>
        ))}
      </main>
    </TooltipProvider>
  );
}
