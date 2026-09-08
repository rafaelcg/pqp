import { describe, expect, it } from "vitest";
import { expectedCeilingBps } from "@/components/voice/outbound-video-readout";
import {
  meshCameraBitrate,
  meshScreenBitrate,
} from "@/lib/peer-connection-manager";
import { cameraBitrateFor } from "@/lib/video-quality";

/**
 * What the readout measures a live ceiling against.
 *
 * This is the number that decides whether the app tells somebody their
 * connection is at fault or their own quality setting is, and it has been
 * wrong in both directions on this branch. There was no test on this component
 * at all until now, which is why the second mistake had nowhere to fall.
 */
describe("what the room may legitimately spend on one sender", () => {
  it("gives the screen the whole share when no camera is on", () => {
    // THE BUG THIS PINS. The readout prefers the camera row and only falls
    // back to the screen when there is no camera row, so the screen branch
    // runs exactly when the camera is off — and it used to be handed a camera
    // term anyway, every single time. The expectation came out a third low,
    // so on a 3 to 4.5 Mbps link the menu said "your quality setting" while
    // the status line said "your connection", about the same share.
    expect(
      expectedCeilingBps({
        role: "screen",
        quality: "auto",
        viewers: 3,
        cameraOn: false,
        sharingScreen: true,
      }),
    ).toBe(meshScreenBitrate(3, "auto", undefined, 0));
  });

  it("gives the screen a smaller share when a camera really is on", () => {
    const withCamera = expectedCeilingBps({
      role: "screen",
      quality: "auto",
      viewers: 3,
      cameraOn: true,
      sharingScreen: true,
    });
    expect(withCamera).toBe(
      meshScreenBitrate(3, "auto", undefined, cameraBitrateFor("auto")),
    );
    expect(withCamera).toBeLessThan(
      expectedCeilingBps({
        role: "screen",
        quality: "auto",
        viewers: 3,
        cameraOn: false,
        sharingScreen: true,
      })!,
    );
  });

  it("gives the camera the whole share when nothing is being shared", () => {
    // The mirror of the same mistake, on the other branch.
    expect(
      expectedCeilingBps({
        role: "camera",
        quality: "auto",
        viewers: 3,
        cameraOn: true,
        sharingScreen: false,
      }),
    ).toBe(meshCameraBitrate(3, cameraBitrateFor("auto"), undefined, 0));
  });

  it("matches the manager's own arithmetic, so the two surfaces agree", () => {
    // The readout and the status line must not disagree about the same share.
    for (const viewers of [1, 2, 4, 7]) {
      for (const quality of ["auto", "1080p", "360p"] as const) {
        expect(
          expectedCeilingBps({
            role: "screen",
            quality,
            viewers,
            cameraOn: true,
            sharingScreen: true,
          }),
        ).toBe(
          meshScreenBitrate(viewers, quality, undefined, cameraBitrateFor(quality)),
        );
      }
    }
  });

  it("says nothing when it cannot know the room", () => {
    // Settings renders this outside a call. Guessing there is worse than
    // declining to name a limit.
    expect(
      expectedCeilingBps({
        role: "screen",
        quality: "auto",
        viewers: undefined,
        cameraOn: false,
        sharingScreen: true,
      }),
    ).toBeNull();
    expect(
      expectedCeilingBps({
        role: "unknown",
        quality: "auto",
        viewers: 3,
        cameraOn: false,
        sharingScreen: true,
      }),
    ).toBeNull();
  });
});
