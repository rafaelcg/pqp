import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VoiceParticipant } from "@pqp/shared";
import { VoiceOccupantBadges } from "./channel-list";

/**
 * The channel-list occupant badges — the "see who is muted from outside the
 * call" half of voice state visibility. Rendered straight from the roster's
 * `VoiceParticipant`, so these tests are also a pin on what that type carries.
 */

function person(overrides: Partial<VoiceParticipant> = {}): VoiceParticipant {
  return {
    peerId: "peer-1",
    userId: "11111111-1111-4111-8111-111111111111",
    displayName: "Ana",
    avatarUrl: null,
    sharingScreen: false,
    muted: false,
    deafened: false,
    serverMuted: false,
    ...overrides,
  };
}

describe("VoiceOccupantBadges", () => {
  it("renders nothing for a plain unmuted participant", () => {
    expect(renderToStaticMarkup(<VoiceOccupantBadges person={person()} />)).toBe(
      "",
    );
  });

  it("shows the mic-off badge for a muted participant", () => {
    const html = renderToStaticMarkup(
      <VoiceOccupantBadges person={person({ muted: true })} />,
    );
    expect(html).toContain('aria-label="Muted"');
    expect(html).not.toContain('aria-label="Deafened"');
  });

  it("deafened wins over muted — one badge, not two saying the same thing", () => {
    const html = renderToStaticMarkup(
      <VoiceOccupantBadges person={person({ muted: true, deafened: true })} />,
    );
    expect(html).toContain('aria-label="Deafened"');
    expect(html).not.toContain('aria-label="Muted"');
  });

  it("shows the screen badge beside the mute badge", () => {
    const html = renderToStaticMarkup(
      <VoiceOccupantBadges
        person={person({ muted: true, sharingScreen: true })}
      />,
    );
    expect(html).toContain('aria-label="Sharing their screen"');
    expect(html).toContain('aria-label="Muted"');
  });

  it("shows the camera badge from the roster stream id", () => {
    const html = renderToStaticMarkup(
      <VoiceOccupantBadges person={person({ cameraStreamId: "cam-1" })} />,
    );
    expect(html).toContain('aria-label="Camera on"');
  });
});
