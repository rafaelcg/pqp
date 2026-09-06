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
        isMuted={false}
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
  it("puts hang-up on the header, the channel under it, then camera and share", () => {
    const html = render();
    const hang = html.indexOf('aria-label="Disconnect from voice"');
    const open = html.indexOf('aria-label="Open voice channel Lobby"');
    const camera = html.indexOf('aria-label="Turn camera on"');
    const share = html.indexOf('aria-label="Share screen"');
    expect(hang).toBeGreaterThan(-1);
    expect(hang).toBeLessThan(open);
    expect(open).toBeLessThan(camera);
    expect(camera).toBeLessThan(share);
    expect(html).toContain("grid-cols-2");
    expect(html).not.toContain("grid-cols-3");
    expect(html).not.toContain("Live");
    expect(html).not.toContain("person");
    expect(html).not.toContain("SFU");
    expect(html).not.toContain("Mute microphone");
    expect(html).not.toContain("Deafen");
  });

  it("hides the action row when STREAM is denied, and keeps hang-up on the header", () => {
    const html = render({ canStream: false });
    expect(html).not.toContain("Turn camera on");
    expect(html).not.toContain("Share screen");
    expect(html).not.toContain("grid-cols-2");
    expect(html).toContain('aria-label="Disconnect from voice"');
    expect(html).toContain("Lobby");
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
    expect(html).not.toContain("Live");
    expect(html).not.toContain("Presenting");
  });

  it("keeps hang-up while joining, without camera or share", () => {
    const html = render({ status: "joining" });
    expect(html).toContain("Connecting");
    expect(html).toContain("Disconnect from voice");
    expect(html).not.toContain("Turn camera on");
    expect(html).not.toContain("Share screen");
    expect(html).not.toContain("grid-cols-2");
    expect(html).not.toContain("Open voice channel");
  });

  it("shows a tiny PTT when idle, and does not flash Live while talking", () => {
    const idle = render({
      inputMode: "push-to-talk",
      isTransmitting: false,
    });
    expect(idle).toContain("PTT");
    expect(idle).not.toContain("Live");

    const talking = render({
      inputMode: "push-to-talk",
      isTransmitting: true,
    });
    expect(talking).not.toContain("Live");
    expect(talking).not.toContain("PTT");
  });

  it("keeps listen-only as a compact hint, not a third tile", () => {
    const html = render({ listenOnly: true });
    expect(html).toContain("data-listen-only");
    expect(html).toContain("Listen only");
    expect(html).toContain("grid-cols-2");
    expect(html).not.toContain("grid-cols-3");
    expect(html).toContain('aria-label="Disconnect from voice"');
  });
});
