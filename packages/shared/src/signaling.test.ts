import { describe, expect, it } from "vitest";
import {
  clientRelayMessageSchema,
  isClientRelayMessage,
  setSharingScreenMessageSchema,
  voiceClientMessageSchema,
  voiceParticipantSchema,
  type VoiceSignalingMessage,
} from "./signaling.js";

/**
 * The screen-share fields are additions to a protocol that is already deployed,
 * so the only thing that matters about them is that leaving them out is legal.
 * A build without them talking to a build with them is the normal state of a
 * rollout, and a schema that rejected the older frame would drop the whole
 * roster rather than one optional id.
 */
describe("screen-share audio is an optional addition to the wire", () => {
  const participant = {
    peerId: "peer-1",
    userId: "00000000-0000-4000-8000-0000000000aa",
    displayName: "Talker",
    avatarUrl: null,
  };

  it("accepts a roster entry from a server that knows nothing about it", () => {
    const parsed = voiceParticipantSchema.parse(participant);
    expect(parsed.screenAudioStreamId).toBeUndefined();
  });

  it("accepts an explicit null, which is what a silent share sends", () => {
    const parsed = voiceParticipantSchema.parse({
      ...participant,
      screenAudioStreamId: null,
    });
    expect(parsed.screenAudioStreamId).toBeNull();
  });

  it("carries the capture id when the share has sound", () => {
    const parsed = voiceParticipantSchema.parse({
      ...participant,
      screenAudioStreamId: "cap-1",
    });
    expect(parsed.screenAudioStreamId).toBe("cap-1");
  });

  it("accepts a set-sharing-screen from an older client, with no id", () => {
    const parsed = setSharingScreenMessageSchema.parse({
      type: "set-sharing-screen",
      sharing: true,
    });
    expect(parsed.audioStreamId).toBeUndefined();
  });

  it("rejects an id that is not a string, rather than passing it through", () => {
    expect(() =>
      setSharingScreenMessageSchema.parse({
        type: "set-sharing-screen",
        sharing: true,
        audioStreamId: 7,
      }),
    ).toThrow();
  });
});

/**
 * The watcher-to-presenter quality request.
 *
 * THE FRAME EXISTS BECAUSE THE ALTERNATIVE DOES NOT. A viewer cannot raise the
 * quality they receive: `scaleResolutionDownBy` and `maxBitrate` are
 * `RTCRtpSender` parameters and `RTCRtpReceiver` has no counterpart to either,
 * so in a full mesh the presenter encodes one stream per peer and that is what
 * arrives. The only route from "this looks soft" to a bigger picture runs
 * through the other machine.
 *
 * THE SERVER READS NOTHING IN IT. `handleClientRelay` checks that the sender is
 * the peer they claim to be, that the target is a peer, and that both are in
 * the same room, then forwards the frame verbatim. So the tests that matter
 * here are about the relay envelope, not about the payload: an addressed frame
 * that the relay refuses is a feature that silently does nothing, and a frame
 * the relay accepts from an unaddressed sender is a way to reach into another
 * room.
 */
describe("screen-quality-request rides the existing relay", () => {
  const frame = {
    type: "screen-quality-request" as const,
    from: "peer-a",
    to: "peer-b",
    quality: "1080p",
  };

  it("is a client relay message, so the server forwards it unread", () => {
    expect(clientRelayMessageSchema.parse(frame)).toEqual(frame);
    expect(isClientRelayMessage(frame as VoiceSignalingMessage)).toBe(true);
  });

  it("is accepted inbound, which is what needs the API redeployed", () => {
    // `voiceClientMessageSchema` is the door every frame from a client goes
    // through, and a discriminated union rejects a type it has never heard of
    // before the relay is ever reached. That is the whole reason this feature
    // cannot ship without restarting the API: a client that sends this to an
    // older server is talking to something that drops it silently.
    expect(voiceClientMessageSchema.parse(frame)).toEqual(frame);
  });

  it("insists on an addressee, because it is answered per-peer", () => {
    // Not cosmetic. A presenter holds one sender per peer and grants this on
    // that sender alone, which is what stops one watcher's click from spending
    // the presenter's uplink on everybody else's behalf. A frame with no `to`
    // has no such peer and would have to mean "the room", which is precisely
    // the semantics this design refuses.
    const { to: _to, ...unaddressed } = frame;
    expect(clientRelayMessageSchema.safeParse(unaddressed).success).toBe(false);
  });

  it("carries the rung as a plain string, so an unknown one is ignorable", () => {
    // Deliberately not an enum. The ladder is a client-side product decision
    // that has already changed once; a rung the far end does not recognise
    // must degrade to "ignored" at the far end rather than to a frame the
    // relay drops, which would be indistinguishable from a broken connection.
    expect(
      clientRelayMessageSchema.safeParse({ ...frame, quality: "4k" }).success,
    ).toBe(true);
    // Bounded, though: this is relayed to another client and there is no
    // reason for it ever to be long.
    expect(
      clientRelayMessageSchema.safeParse({ ...frame, quality: "x".repeat(64) })
        .success,
    ).toBe(false);
  });
});
