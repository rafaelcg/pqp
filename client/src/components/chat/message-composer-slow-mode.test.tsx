import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { MessageComposer } from "./message-composer";

/**
 * The honest half of slow mode.
 *
 * A bare rejection is what this replaces: the composer stays on screen, the
 * field stays usable, and the send pill says how long is left. Asserted here
 * is the label and the disabled state at a given instant -- the tick itself is
 * a `setInterval` in an effect, and effects do not run through
 * `react-dom/server`, so the countdown is driven by rendering at several
 * instants rather than by waiting through one.
 */
function render(slowModeUntil: number | null) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <MessageComposer
        onSend={() => {}}
        channelId="11111111-1111-4111-8111-111111111111"
        slowModeUntil={slowModeUntil}
      />
    </TooltipProvider>,
  );
}

/** The submit pill, which is the only control slow mode touches. */
function sendButton(html: string): string {
  const match = html.match(/<button[^>]*type="submit"[^>]*>.*?<\/button>/s);
  if (!match) {
    throw new Error("no submit button in the composer");
  }
  return match[0];
}

describe("composer under slow mode", () => {
  it("counts the wait down on the send action and clears it when it runs out", () => {
    expect(sendButton(render(Date.now() + 12_000))).toContain(">12s<");
    expect(sendButton(render(Date.now() + 2_400))).toContain(">3s<");
    expect(sendButton(render(Date.now() + 1_100))).toContain(">2s<");

    // A hold in the past is no hold, and neither is no hold at all: the pill
    // is back to Send with no number on it. (It is still disabled here, but
    // for the ordinary reason -- there is nothing typed to send.)
    for (const cleared of [render(Date.now() - 1_000), render(null)]) {
      const pill = sendButton(cleared);
      expect(pill).toContain(">Send<");
      expect(pill).not.toMatch(/>\d+s</);
    }
  });

  /**
   * The wait has to reach someone who cannot see the pill. The visible label
   * is a bare "30s", so the accessible name carries the sentence, and the
   * field points at the live region that announces it. Neither of those is a
   * side effect of anything else on the composer -- an empty draft greys the
   * pill out too, which is why "is it disabled" is not the assertion here.
   */
  it("explains the wait rather than only greying the pill out", () => {
    const html = render(Date.now() + 30_000);
    const pill = sendButton(html);
    expect(pill).toMatch(/aria-label="[^"]*30s[^"]*"/);

    const textarea = html.match(/<textarea[^>]*>/)![0];
    const describedBy = textarea.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(describedBy).toBeTruthy();
    expect(html).toContain(`id="${describedBy}"`);
    expect(html).toContain('role="status"');

    // With no hold there is nothing to describe, so the field does not point
    // at a region that would then be empty.
    const off = render(null);
    expect(off.match(/<textarea[^>]*>/)![0]).not.toContain("aria-describedby");
  });

  /**
   * The one thing a person cannot forgive. A refusal arrives while the draft
   * is still in the field, so the hold must disable the send action and
   * nothing else -- a disabled textarea would eat the next keystroke and,
   * worse, invite a "clear it, they can retype" fix later.
   */
  it("leaves the field itself usable while holding", () => {
    const html = render(Date.now() + 30_000);
    expect(html).toContain("<textarea");
    const textarea = html.match(/<textarea[^>]*>/)![0];
    // `disabled:opacity-50` lives in the class list, so match the attribute.
    expect(textarea).not.toMatch(/\sdisabled=/);
    expect(textarea).not.toMatch(/\sreadonly/i);
  });
});
