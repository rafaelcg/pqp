import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CUSTOM_STATUS_MAX_LENGTH } from "@pqp/shared";
import { TooltipProvider } from "@/components/ui/tooltip";
import { customStatusRemaining } from "@/hooks/use-custom-status";
import { UserPanel } from "./user-panel";

/**
 * The other half of the recado: where it is written.
 *
 * The editor lives in the account's own popover rather than in Settings, and
 * that placement is the thing worth pinning. The field sits with the three
 * status choices because it answers the same question they do and takes effect
 * the same way, immediately. A refactor that moved it behind a Save button
 * would give one half of that pair different semantics from the other, and
 * nothing else in the suite would notice.
 *
 * The popover is closed on first paint, so these render it open by asking for
 * the markup and reading it rather than by clicking. That is enough for what is
 * asserted: the field exists, it is seeded from the saved value, and the
 * counter counts the same thing the cap counts.
 */

function panel(props: Partial<Parameters<typeof UserPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UserPanel
        displayName="Ana"
        tag="ana#0001"
        handle={null}
        avatarUrl={null}
        isMuted={false}
        isDeafened={false}
        inVoice={false}
        showUserButton={false}
        manualStatus="online"
        effectiveStatus="online"
        statusSaving={false}
        statusError={null}
        onSetStatus={() => {}}
        customStatus=""
        customStatusSaving={false}
        customStatusError={null}
        onSetCustomStatus={() => {}}
        onClearCustomStatusError={() => {}}
        onToggleMute={() => {}}
        onToggleDeafen={() => {}}
        onOpenSettings={() => {}}
        onOpenFeedback={() => {}}
        onOpenProfile={() => {}}
        {...props}
      />
    </TooltipProvider>,
  );
}

describe("the recado field in the user panel", () => {
  it("is not on screen until the menu is opened", () => {
    // The strip itself is three controls and a name. The editor belongs to the
    // menu, not to the footer, or it would take the row's whole width.
    expect(panel()).not.toContain("data-custom-status-input");
  });

  it("does not put the recado on the panel's own second line", () => {
    // That line is one identity string by an explicit rule: handle if you have
    // one, else the tag. Stacking status words next to a tag in a 16rem
    // sidebar is what produced "dev_us... O...".
    const html = panel({ customStatus: "no gym, volto as 20h", handle: "ana" });
    expect(html).toContain("@ana");
    expect(html).not.toContain("no gym, volto as 20h");
  });
});

describe("customStatusRemaining", () => {
  it("starts at the cap for an empty draft", () => {
    expect(customStatusRemaining("")).toBe(CUSTOM_STATUS_MAX_LENGTH);
  });

  it("counts an emoji as one, the way the cap does", () => {
    // A counter that disagreed with the validator is the worst of both: it says
    // 40 left and the save is refused.
    expect(customStatusRemaining("\u{1f480}")).toBe(CUSTOM_STATUS_MAX_LENGTH - 1);
  });

  it("does not charge twice for a run of spaces the server will collapse", () => {
    expect(customStatusRemaining("a   b")).toBe(CUSTOM_STATUS_MAX_LENGTH - 3);
  });

  it("goes negative, which is what the field draws in red", () => {
    expect(customStatusRemaining("a".repeat(CUSTOM_STATUS_MAX_LENGTH + 5))).toBe(
      -5,
    );
  });
});
