import { describe, expect, it } from "vitest";
import {
  joinVoiceRoomMessageSchema,
  setSharingScreenMessageSchema,
  voiceParticipantSchema,
  welcomeMessageSchema,
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

describe("voice resume fields are optional additions", () => {
  const channel = "00000000-0000-4000-8000-0000000000aa";

  it("accepts a join from a client that has never heard of resume", () => {
    const parsed = joinVoiceRoomMessageSchema.parse({
      type: "join-voice-room",
      voiceChannelId: channel,
    });
    expect(parsed.resumePeerId).toBeUndefined();
    expect(parsed.resumeToken).toBeUndefined();
  });

  it("accepts a welcome from a server that has never heard of resume", () => {
    const parsed = welcomeMessageSchema.parse({
      type: "welcome",
      peerId: "peer-1",
      peers: [],
      voiceChannelId: channel,
      self: {
        peerId: "peer-1",
        userId: "00000000-0000-4000-8000-0000000000aa",
        displayName: "Talker",
        avatarUrl: null,
      },
    });
    expect(parsed.resumed).toBeUndefined();
    expect(parsed.resumeToken).toBeUndefined();
  });
});
