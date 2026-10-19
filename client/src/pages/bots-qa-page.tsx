import {
  BOT_COLORS,
  BOT_FACES,
  botActionCardSchema,
  type BotActionCard as BotActionCardData,
  type BotNotice,
} from "@pqp/shared";
import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { BotFace } from "@/components/bots/bot-face";
import { BotActionCard, BotNoticeRow } from "@/components/chat/bot-action-card";
import { TooltipProvider } from "@/components/ui/tooltip";
import { isDesktopApp } from "@/lib/desktop";
import { isDevAuthBypassEnabled } from "@/lib/dev-auth";
import { useTranslation, type MessageKey } from "@/lib/i18n";

/**
 * Every state a server bot draws, side by side: the card in each of its
 * moments, the notices, and Breu in every colour and face. The review sheet
 * for the bot redesign, the way `/qa/ui` is for the design system. Dev bypass
 * only, like `/qa/ui`.
 */

const ME = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const PLAN = "00000000-0000-4000-8000-0000000000cc";
const NOW = Date.now();

function card(input: Partial<BotActionCardData> & Pick<BotActionCardData, "kind" | "items">): BotActionCardData {
  return botActionCardSchema.parse(input);
}

const steps = (statuses: Array<"pending" | "ok" | "failed" | "unknown">) =>
  [
    { tool: "delete_channel", label: "Apagar #memes-antigos", status: statuses[0] ?? "pending", detail: null },
    { tool: "create_channel", label: "Criar #memes em Texto", status: statuses[1] ?? "pending", detail: null },
  ] as BotActionCardData["items"];

const waitingPlan = {
  kind: "plan" as const,
  confirmBy: "gui",
  confirmById: ME,
  planId: PLAN,
  expiresAt: new Date(NOW + 252_000).toISOString(),
};

const CARDS: Array<[MessageKey, BotActionCardData, string]> = [
  ["qaBots.card.waitingMine", card({ ...waitingPlan, items: steps(["pending", "pending"]) }), ME],
  ["qaBots.card.lastMinute", card({ ...waitingPlan, expiresAt: new Date(NOW + 38_000).toISOString(), items: steps([]) }), ME],
  ["qaBots.card.waitingOther", card({ ...waitingPlan, items: steps([]) }), OTHER],
  ["qaBots.card.running", card({ ...waitingPlan, state: "confirmed", items: steps(["ok", "pending"]) }), OTHER],
  ["qaBots.card.done", card({ ...waitingPlan, state: "confirmed", items: steps(["ok", "ok"]) }), OTHER],
  ["qaBots.card.cancelled", card({ ...waitingPlan, state: "cancelled", items: steps([]) }), OTHER],
  ["qaBots.card.expired", card({ ...waitingPlan, state: "expired", items: steps([]) }), OTHER],
  [
    "qaBots.card.resultOk",
    card({
      kind: "result",
      confirmBy: "bia",
      items: [
        { tool: "create_channel", label: "Criar #torneio em Jogos", status: "ok", detail: null },
        { tool: "pin_message", label: "Fixar “Regras do campeonato”", status: "ok", detail: null },
        { tool: "create_poll", label: "Criar enquete “Horário de sábado”", status: "ok", detail: null },
      ],
    }),
    OTHER,
  ],
  [
    "qaBots.card.resultFailed",
    card({
      kind: "result",
      confirmBy: "bia",
      items: [
        { tool: "create_channel", label: "Criar #torneio em Jogos", status: "ok", detail: null },
        {
          tool: "pin_message",
          label: "Fixar a regra em #torneio",
          status: "failed",
          detail: "O cargo do Tico não pode fixar mensagens.",
        },
      ],
    }),
    OTHER,
  ],
  [
    "qaBots.card.resultUnknown",
    card({
      kind: "result",
      items: [
        {
          tool: "create_invite",
          label: "Criar convite pro #lobby",
          status: "unknown",
          detail: "O servidor caiu no meio. Veja em Convites.",
        },
      ],
    }),
    OTHER,
  ],
];

const question = {
  kind: "ask" as const,
  items: [],
  lead: "Bora! Qual formato?",
  options: ["Mata-mata, 8 times", "Pontos corridos", "Só um x1 rápido"],
  confirmBy: "andre",
  confirmById: ME,
  expiresAt: new Date(NOW + 540_000).toISOString(),
};

const ASKS: Array<[MessageKey, BotActionCardData, string]> = [
  ["qaBots.ask.mine", card(question), ME],
  ["qaBots.ask.other", card(question), OTHER],
  ["qaBots.ask.answered", card({ ...question, state: "answered", answer: 0 }), OTHER],
  ["qaBots.ask.expired", card({ ...question, expiresAt: new Date(NOW - 1000).toISOString() }), ME],
];

const notice = (reason: BotNotice["reason"], limit: number | null): BotNotice => ({
  type: "bot-notice",
  channelId: PLAN,
  botUserId: OTHER,
  botName: "Tico",
  reason,
  limit,
  retryAt: reason === "busy" ? null : new Date(NOW + 3 * 3600_000).toISOString(),
});

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="font-display text-xl font-extrabold text-text">{title}</h2>
      {children}
    </section>
  );
}

export function BotsQaPage() {
  const { t } = useTranslation();
  if (!isDevAuthBypassEnabled()) {
    return <Navigate to={isDesktopApp() ? "/app" : "/"} replace />;
  }
  return (
    <TooltipProvider>
      <main className="mx-auto flex max-w-6xl flex-col gap-12 bg-surface-0 px-5 py-10 text-text">
        <h1 className="font-display text-3xl font-extrabold">{t("qaBots.title")}</h1>

        <Section title={t("qaBots.cards")}>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-3">
            {CARDS.map(([label, data, viewer]) => (
              <div key={label}>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-text-tertiary">{t(label)}</p>
                <BotActionCard card={data} messageId={PLAN} createdAt="2026-01-01T00:00:00Z" currentUserId={viewer} botName="Tico" />
              </div>
            ))}
          </div>
        </Section>

        <Section title={t("qaBots.asks")}>
          <div className="grid gap-6 md:grid-cols-2 xl:grid-cols-4">
            {ASKS.map(([label, data, viewer]) => (
              <div key={label}>
                <p className="mb-1 text-xs font-bold uppercase tracking-wide text-text-tertiary">{t(label)}</p>
                <BotActionCard card={data} messageId={PLAN} createdAt="2026-01-01T00:00:00Z" currentUserId={viewer} botName="Tico" />
              </div>
            ))}
          </div>
        </Section>

        <Section title={t("qaBots.notices")}>
          <div className="max-w-xl space-y-2">
            {(
              [
                ["busy", null],
                ["member-hour", 20],
                ["server-day", 200],
                ["budget", null],
              ] as const
            ).map(([reason, limit]) => (
              <BotNoticeRow key={reason} notice={notice(reason, limit)} onDismiss={() => {}} />
            ))}
          </div>
        </Section>

        <Section title={t("qaBots.faces")}>
          <div className="space-y-3">
            {BOT_COLORS.map((color) => (
              <div key={color} className="flex flex-wrap items-end gap-4">
                {BOT_FACES.map((face) => (
                  <BotFace key={face} color={color} face={face} variant="full" className="h-16 w-16" />
                ))}
                {["h-10 w-10", "h-6 w-6", "h-4 w-4"].map((size) => (
                  <BotFace key={size} color={color} face="oi" className={size} />
                ))}
              </div>
            ))}
          </div>
        </Section>
      </main>
    </TooltipProvider>
  );
}
