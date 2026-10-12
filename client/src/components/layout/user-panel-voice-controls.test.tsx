import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { UserPanel } from "./user-panel";

/**
 * The mute and deafen buttons in the user panel. Deafening shows both red
 * slashes. A mute that outlives the deafen keeps only the mic slash.
 *
 * The "also turns sound back on" line is a tooltip detail. Radix does not
 * render tooltip content while it is closed, so these asserts stay on the
 * buttons.
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
        inVoice
        canSpeak
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

describe("user panel mute and deafen", () => {
  it("shows neither slash while the mic is open and hearing is on", () => {
    const html = panel();
    expect(html).toContain('aria-label="Mute microphone"');
    expect(html).toContain('aria-label="Deafen"');
    expect(html).not.toContain("text-danger");
  });

  it("shows both red slashes while deafened", () => {
    const html = panel({ isMuted: true, isDeafened: true });
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html).toContain('aria-label="Unmute microphone"');
    expect(html).toContain('aria-label="Undeafen"');
    expect(html.match(/text-danger/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("keeps the mic slash after undeafen when the mic stays muted", () => {
    const html = panel({ isMuted: true, isDeafened: false });
    expect(html).toContain('aria-label="Unmute microphone"');
    expect(html).toContain('aria-label="Deafen"');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain("text-danger");
  });

  it("still slashes the mic when deafen is the only flag set", () => {
    const html = panel({ isMuted: false, isDeafened: true });
    expect(html).toContain('aria-label="Unmute microphone"');
    expect(html).toContain('aria-label="Undeafen"');
    expect(html.match(/text-danger/g)?.length).toBeGreaterThanOrEqual(2);
  });
});
