import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { VoiceParticipant } from "@pqp/shared";
import { raisedHandPositions } from "@/components/voice/hand-position-badge";
import { VoiceOccupantBadges } from "./voice-occupant-badges";

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
  it("shows a raised hand with its place in the queue", () => {
    const html = renderToStaticMarkup(
      <VoiceOccupantBadges
        person={person({ handRaisedAt: 2_000 })}
        handPosition={2}
      />,
    );
    expect(html).toContain('aria-label="Hand raised, number 2 in the queue"');
    expect(html).toContain('data-hand-position="2"');
  });

  it("falls back to the plain hand when no position is known", () => {
    const html = renderToStaticMarkup(
      <VoiceOccupantBadges person={person({ handRaisedAt: 2_000 })} />,
    );
    expect(html).toContain('aria-label="Hand raised"');
    expect(html).not.toContain("data-hand-position");
  });
});

describe("raisedHandPositions", () => {
  it("numbers the room in the order hands went up, one number per person", () => {
    const room = [
      person({ peerId: "a", userId: "a", handRaisedAt: 3_000 }),
      person({ peerId: "b", userId: "b", handRaisedAt: null }),
      person({ peerId: "c", userId: "c", handRaisedAt: 1_000 }),
      // The same person on a second device: still one place in the queue.
      person({ peerId: "c2", userId: "c", handRaisedAt: 1_000 }),
      person({ peerId: "d", userId: "d", handRaisedAt: 2_000 }),
    ];
    const positions = raisedHandPositions(room);
    expect([...positions]).toEqual([
      ["c", 1],
      ["d", 2],
      ["a", 3],
    ]);
  });
});
