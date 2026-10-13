import type { BotActionCard as BotActionCardData } from "@pqp/shared";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { I18nProvider } from "@/lib/i18n";
import { BotActionCard, BotNoticeRow } from "./bot-action-card";

const ASKER = "00000000-0000-4000-8000-0000000000aa";
const PLAN = "00000000-0000-4000-8000-0000000000bb";

function render(
  card: Partial<BotActionCardData> & Pick<BotActionCardData, "kind" | "items">,
  options: { createdAt?: string; viewer?: string | null } = {},
): string {
  const full: BotActionCardData = {
    lead: null,
    confirmBy: null,
    expiresAt: null,
    planId: null,
    confirmById: null,
    state: null,
    options: null,
    answer: null,
    ...card,
  };
  return renderToStaticMarkup(
    <I18nProvider>
      <BotActionCard
        card={full}
        messageId="00000000-0000-4000-8000-0000000000dd"
        createdAt={options.createdAt ?? new Date().toISOString()}
        currentUserId={options.viewer ?? null}
      />
    </I18nProvider>,
  );
}

const waitingPlan = {
  kind: "plan" as const,
  items: [{ tool: "delete_channel", label: "Apagar #velho", status: "pending" as const, detail: null }],
  confirmBy: "@rafa",
  confirmById: ASKER,
  planId: PLAN,
  expiresAt: new Date(Date.now() + 300_000).toISOString(),
};

describe("BotActionCard", () => {
  it("draws each step with its outcome, and the reason a step failed", () => {
    const html = render({
      kind: "result",
      items: [
        { tool: "create_channel", label: 'Criar canal de voz "lobby-cs2"', status: "ok", detail: null },
        { tool: "delete_channel", label: "Apagar #velho", status: "failed", detail: "Forbidden" },
      ],
    });
    expect(html).toContain('data-bot-card="result"');
    expect(html).toContain("lobby-cs2");
    expect(html).toContain("Forbidden");
    expect(html).toContain("1 failed");
  });

  it("gives the member who asked Confirm and Cancel", () => {
    const html = render(waitingPlan, { viewer: ASKER });
    expect(html).toContain("Waiting for you");
    expect(html).toContain('role="timer"');
    expect(html).toContain(">Confirm<");
    expect(html).toContain(">Cancel<");
  });

  it("tells everybody else who may confirm, with no buttons", () => {
    const html = render(waitingPlan, { viewer: "00000000-0000-4000-8000-0000000000cc" });
    expect(html).toContain("Only @rafa can confirm");
    expect(html).not.toContain(">Confirm<");
  });

  it("drops the buttons once the plan is decided or runs out", () => {
    expect(render({ ...waitingPlan, state: "confirmed" }, { viewer: ASKER })).toContain("Confirmed by @rafa");
    expect(render({ ...waitingPlan, state: "confirmed" }, { viewer: ASKER })).not.toContain(">Confirm<");
    const expired = render(
      { ...waitingPlan, expiresAt: new Date(Date.now() - 1000).toISOString() },
      { viewer: ASKER },
    );
    expect(expired).toContain("Plan expired");
    expect(expired).not.toContain(">Confirm<");
  });

  const question = {
    kind: "ask" as const,
    items: [],
    lead: "Qual canal?",
    options: ["Geral", "Memes"],
    confirmBy: "@rafa",
    confirmById: ASKER,
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };

  it("gives the member who was asked one button per answer", () => {
    const html = render(question, { viewer: ASKER });
    expect(html).toContain('data-bot-card="ask"');
    expect(html).toContain("Pick one");
    expect(html).toContain("<button");
    expect(html).toContain("Memes");
  });

  it("shows everybody else the answers, with no buttons", () => {
    const html = render(question, { viewer: "00000000-0000-4000-8000-0000000000cc" });
    expect(html).toContain("Only @rafa can answer");
    expect(html).not.toContain("<button");
  });

  it("marks the chosen answer once it is answered, and drops the buttons when it runs out", () => {
    const answered = render({ ...question, state: "answered", answer: 1 }, { viewer: ASKER });
    expect(answered).toContain("@rafa chose");
    expect(answered).toContain('aria-label="Chosen"');
    expect(answered).not.toContain("<button");
    const expired = render(
      { ...question, expiresAt: new Date(Date.now() - 1000).toISOString() },
      { viewer: ASKER },
    );
    expect(expired).toContain("Question expired");
    expect(expired).not.toContain("<button");
  });

  it("plays its entrance only when it just arrived", () => {
    const card = {
      kind: "result" as const,
      items: [{ tool: "pin_message", label: "Fixar", status: "ok" as const, detail: null }],
    };
    expect(render(card)).toContain("bot-step-in");
    expect(render(card, { createdAt: new Date(Date.now() - 3_600_000).toISOString() })).not.toContain(
      "bot-step-in",
    );
  });
});

describe("BotNoticeRow", () => {
  const notice = (reason: "busy" | "member-hour", retryAt: string | null) =>
    renderToStaticMarkup(
      <I18nProvider>
        <BotNoticeRow
          notice={{
            type: "bot-notice",
            channelId: "00000000-0000-4000-8000-0000000000ee",
            botUserId: "00000000-0000-4000-8000-0000000000ff",
            botName: "Julius",
            reason,
            limit: reason === "member-hour" ? 20 : null,
            retryAt,
          }}
          onDismiss={() => {}}
        />
      </I18nProvider>,
    );

  it("says which limit stopped the bot, when it answers again, and that only you see it", () => {
    const html = notice("member-hour", new Date(Date.now() + 600_000).toISOString());
    expect(html).toContain("limit of 20 questions an hour");
    expect(html).toContain("It answers you again at");
    expect(html).toContain("Only you can see this.");
    expect(notice("busy", null)).toContain("still answering your earlier questions");
  });
});
