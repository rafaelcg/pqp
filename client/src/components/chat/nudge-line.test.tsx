import { renderToStaticMarkup } from "react-dom/server";
import { NUDGE_FRESH_MS } from "@pqp/shared";
import { beforeEach, describe, expect, it } from "vitest";
import { NudgeButton } from "@/components/dm/nudge-button";
import { TooltipProvider } from "@/components/ui/tooltip";
import { nudgeShakeKind } from "@/hooks/use-nudge-shake";
import { translateMessage } from "@/lib/i18n";
import {
  handleNudgeRefused,
  resetNudgeStateForTests,
  setNudgeEnabledForTests,
} from "@/lib/nudge";
import { NudgeLine, NudgeNotice, nudgeRefusalKey } from "./nudge-line";

const CHANNEL = "11111111-1111-4111-8111-111111111111";
const ID = "44444444-4444-4444-8444-444444444444";

beforeEach(() => {
  resetNudgeStateForTests();
});

describe("NudgeLine", () => {
  const justNow = () => new Date().toISOString();

  it("says who called whose attention", () => {
    const theirs = renderToStaticMarkup(
      <NudgeLine messageId={ID} createdAt={justNow()} mine={false} name="Lu" />,
    );
    expect(theirs).toContain("Lu nudged you!");
    const mine = renderToStaticMarkup(
      <NudgeLine messageId={ID} createdAt={justNow()} mine name="Lu" />,
    );
    expect(mine).toContain("You nudged Lu.");
  });

  it("animates in only when fresh: history just sits there", () => {
    const fresh = renderToStaticMarkup(
      <NudgeLine messageId={ID} createdAt={justNow()} mine={false} name="Lu" />,
    );
    expect(fresh).toContain("nudge-line-in");
    expect(fresh).toContain("nudge-wiggle");
    const old = new Date(Date.now() - NUDGE_FRESH_MS - 5_000).toISOString();
    const history = renderToStaticMarkup(
      <NudgeLine messageId={ID} createdAt={old} mine={false} name="Lu" />,
    );
    expect(history).not.toContain("nudge-line-in");
    expect(history).not.toContain("nudge-wiggle");
  });

  it("offers report on theirs and delete on mine, never the other way round", () => {
    const theirs = renderToStaticMarkup(
      <NudgeLine
        messageId={ID}
        createdAt={justNow()}
        mine={false}
        name="Lu"
        onReport={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(theirs).toContain(`aria-label="${translateMessage("chat.report")}"`);
    expect(theirs).not.toContain(`aria-label="${translateMessage("chat.delete")}"`);
    const mine = renderToStaticMarkup(
      <NudgeLine
        messageId={ID}
        createdAt={justNow()}
        mine
        name="Lu"
        onReport={() => {}}
        onDelete={() => {}}
      />,
    );
    expect(mine).toContain(`aria-label="${translateMessage("chat.delete")}"`);
    expect(mine).not.toContain(`aria-label="${translateMessage("chat.report")}"`);
  });
});

describe("NudgeNotice", () => {
  it("words each refusal, naming the friend where it should", () => {
    handleNudgeRefused({ channelId: CHANNEL, reason: "unanswered" });
    expect(renderToStaticMarkup(<NudgeNotice channelId={CHANNEL} name="Lu" />)).toContain(
      "Lu hasn&#x27;t answered yet. Send a message instead.",
    );
    for (const reason of ["cooldown", "unanswered", "busy", "self-off", "unavailable"] as const) {
      expect(translateMessage(nudgeRefusalKey(reason), { name: "Lu" })).not.toBe(
        nudgeRefusalKey(reason),
      );
    }
  });

  it("is nothing when nothing was refused", () => {
    expect(renderToStaticMarkup(<NudgeNotice channelId={CHANNEL} name="Lu" />)).toBe("");
  });
});

describe("NudgeButton", () => {
  const render = () =>
    renderToStaticMarkup(
      <TooltipProvider>
        <NudgeButton channelId={CHANNEL} send={() => {}} isConnected={() => true} />
      </TooltipProvider>,
    );

  it("does not exist while the flag is off", () => {
    expect(render()).toBe("");
  });

  it("is ready, then shows the wait the server announced", () => {
    setNudgeEnabledForTests(true);
    expect(render()).toContain('data-state="ready"');
    handleNudgeRefused({ channelId: CHANNEL, reason: "cooldown", retryAfterMs: 7_000 });
    const cooling = render();
    expect(cooling).toContain('data-state="cooldown"');
    expect(cooling).toContain('aria-disabled="true"');
    expect(cooling).toContain("nudge-cooldown-bar");
  });
});

describe("the pane's effect", () => {
  it("shakes by default and only pulses its border under reduced motion", () => {
    expect(nudgeShakeKind(false)).toBe("shake");
    expect(nudgeShakeKind(true)).toBe("pulse");
  });
});
