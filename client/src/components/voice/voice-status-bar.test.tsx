import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ComponentProps } from "react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { VoiceStatusBar } from "./voice-status-bar";

function render(overrides: Partial<ComponentProps<typeof VoiceStatusBar>> = {}) {
  return renderToStaticMarkup(
    <TooltipProvider>
      <VoiceStatusBar
        channelName="Lobby"
        status="connected"
        peerCount={0}
        isMuted={false}
        usingSfu={false}
        canShareScreen
        onToggleCamera={() => {}}
        onToggleScreenShare={() => {}}
        onOpen={() => {}}
        onLeave={() => {}}
        {...overrides}
      />
    </TooltipProvider>,
  );
}

describe("VoiceStatusBar", () => {
  it("puts camera, share, and hang-up on the connected strip", () => {
    const html = render();
    expect(html).toContain('aria-label="Turn camera on"');
    expect(html).toContain('aria-label="Share screen"');
    expect(html).toContain('aria-label="Disconnect from voice"');
    expect(html).toContain("Live");
    expect(html).not.toContain("Mute microphone");
    expect(html).not.toContain("Deafen");
  });

  it("hides camera and share when STREAM is denied", () => {
    const html = render({ canStream: false });
    expect(html).not.toContain("Turn camera on");
    expect(html).not.toContain("Share screen");
    expect(html).toContain('aria-label="Disconnect from voice"');
  });

  it("hides share when this device cannot capture a screen", () => {
    const html = render({ canShareScreen: false });
    expect(html).toContain("Turn camera on");
    expect(html).not.toContain("Share screen");
  });

  it("marks camera and share as pressed while they are live", () => {
    const html = render({ isCameraOn: true, isSharingScreen: true });
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain("Turn camera off");
    expect(html).toContain("Stop sharing");
  });

  it("keeps hang-up while joining, without camera or share", () => {
    const html = render({ status: "joining" });
    expect(html).toContain("Disconnect from voice");
    expect(html).not.toContain("Turn camera on");
    expect(html).not.toContain("Share screen");
  });
});
