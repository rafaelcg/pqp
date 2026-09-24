import { afterEach, describe, expect, it } from "vitest";
import {
  mintVoiceResumeToken,
  verifyVoiceResumeToken,
  VOICE_RESUME_TTL_MS,
  VOICE_RESUME_TOKEN_TTL_MS,
} from "./voice-resume-token.js";

const USER = "00000000-0000-4000-8000-0000000000aa";
const PEER = "00000000-0000-4000-8000-0000000000bb";
const CHANNEL = "00000000-0000-4000-8000-0000000000cc";

describe("voice resume token", () => {
  const previousClerk = process.env.CLERK_SECRET_KEY;
  const previousBypass = process.env.DEV_AUTH_BYPASS;

  afterEach(() => {
    process.env.CLERK_SECRET_KEY = previousClerk;
    process.env.DEV_AUTH_BYPASS = previousBypass;
  });

  it("round-trips a token minted under CLERK_SECRET_KEY", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_resume";
    delete process.env.DEV_AUTH_BYPASS;
    const token = mintVoiceResumeToken({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "mesh",
    });
    expect(token).toBeTruthy();
    expect(
      verifyVoiceResumeToken(token!, {
        userId: USER,
        peerId: PEER,
        voiceChannelId: CHANNEL,
      }),
    ).toEqual({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "mesh",
      region: null,
    });
  });

  it("carries an SFU region only when one is given, and a token without one reads as none", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_resume";
    const withRegion = mintVoiceResumeToken({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "livekit",
      region: "mia",
      now: 1_000,
    });
    const without = mintVoiceResumeToken({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "livekit",
      now: 1_000,
    });
    const expected = { userId: USER, peerId: PEER, voiceChannelId: CHANNEL };
    expect(verifyVoiceResumeToken(withRegion!, expected, 2_000)?.region).toBe("mia");
    expect(verifyVoiceResumeToken(without!, expected, 2_000)?.region).toBeNull();
    // Single-region mode mints exactly the claims it always did: no `r`.
    const payload = JSON.parse(
      Buffer.from(without!.split(".")[0]!, "base64url").toString("utf8"),
    ) as Record<string, unknown>;
    expect(Object.keys(payload).sort()).toEqual(["c", "e", "p", "t", "u", "v"]);
  });

  it("rejects a stolen id (token for a different peer)", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_resume";
    const token = mintVoiceResumeToken({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "mesh",
    });
    expect(
      verifyVoiceResumeToken(token!, {
        userId: USER,
        peerId: "00000000-0000-4000-8000-0000000000dd",
        voiceChannelId: CHANNEL,
      }),
    ).toBeNull();
  });

  it("is still valid well after the in-process orphan window", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_resume";
    const now = 1_000_000;
    const token = mintVoiceResumeToken({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "mesh",
      now,
    });
    expect(
      verifyVoiceResumeToken(
        token!,
        { userId: USER, peerId: PEER, voiceChannelId: CHANNEL },
        now + VOICE_RESUME_TTL_MS + 1,
      ),
    ).not.toBeNull();
  });

  it("rejects an expired token", () => {
    process.env.CLERK_SECRET_KEY = "sk_test_resume";
    const now = 1_000_000;
    const token = mintVoiceResumeToken({
      userId: USER,
      peerId: PEER,
      voiceChannelId: CHANNEL,
      transport: "mesh",
      now,
    });
    expect(
      verifyVoiceResumeToken(
        token!,
        { userId: USER, peerId: PEER, voiceChannelId: CHANNEL },
        now + VOICE_RESUME_TOKEN_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  it("returns null without a secret rather than throwing", () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
    expect(
      mintVoiceResumeToken({
        userId: USER,
        peerId: PEER,
        voiceChannelId: CHANNEL,
        transport: "mesh",
      }),
    ).toBeNull();
    expect(
      verifyVoiceResumeToken("anything.here", {
        userId: USER,
        peerId: PEER,
        voiceChannelId: CHANNEL,
      }),
    ).toBeNull();
  });
});
