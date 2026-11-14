import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserPanel } from "./user-panel";

/**
 * The user panel at a narrow sidebar (QA-047). The name column used to take
 * whatever the four icon buttons left, which at 200px with Não Perturbe on was
 * nothing. The name now has a minimum width and the controls wrap under it.
 * Markup only: jsdom has no layout, so the measured widths were checked in a
 * browser.
 */

function panel(props: Partial<Parameters<typeof UserPanel>[0]> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <UserPanel
        displayName="Dev User"
        tag="dev_user#7159"
        handle={null}
        avatarUrl={null}
        isMuted={false}
        isDeafened={false}
        inVoice={false}
        canSpeak
        showUserButton={false}
        manualStatus="dnd"
        effectiveStatus="dnd"
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

describe("user panel at a narrow width", () => {
  it("wraps the row and gives the name column a minimum width", () => {
    const html = panel();
    expect(html).toContain("flex-wrap");
    expect(html).toContain("min-w-[var(--user-panel-name-min,7rem)]");
  });

  it("keeps the controls together in one group, Não Perturbe included", () => {
    const html = panel();
    const group = /<div class="[^"]*ml-auto flex shrink-0[^"]*">(.*)$/.exec(html);
    expect(group).not.toBeNull();
    const inside = group![1]!;
    expect(inside).toContain('aria-label="Mute microphone"');
    expect(inside).toContain('aria-label="Deafen"');
    expect(inside.match(/<button/g)?.length).toBe(4);
  });

  it("does not wrap the compact rail variant", () => {
    const html = panel({ compact: true });
    expect(html).not.toContain("flex-wrap");
    expect(html).not.toContain("ml-auto");
  });
});
