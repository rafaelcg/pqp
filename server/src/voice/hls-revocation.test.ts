import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isHlsAccessRevoked,
  resetHlsRevocationsForTests,
  revokeHlsAccess,
  revokeHlsAccessForUser,
} from "./hls-revocation.js";

const writeHlsEdgeRevocationForScope = vi.hoisted(() => vi.fn());
const writeHlsEdgeChannelRevocation = vi.hoisted(() => vi.fn());
vi.mock("./hls-edge-revocation.js", () => ({
  writeHlsEdgeRevocationForScope,
  writeHlsEdgeChannelRevocation,
}));

/**
 * The memory lookup that replaced a per-request access query on the playlist
 * proxy. What it has to get right: only the people who actually lost access,
 * only for tokens minted before they lost it, and nothing kept forever.
 */
const CHANNEL = "chan-1";
const OTHER = "chan-2";
const ALICE = "alice";
const BOB = "bob";
const T0 = 1_800_000_000_000;

describe("hls revocation", () => {
  beforeEach(() => {
    resetHlsRevocationsForTests();
    writeHlsEdgeRevocationForScope.mockClear();
    writeHlsEdgeChannelRevocation.mockClear();
  });

  describe("the edge Worker's KV denylist hook", () => {
    it("writes one edge revocation per named user (onlyUserIds scope), and no channel-wide record", () => {
      revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE, BOB] }, T0);
      expect(writeHlsEdgeRevocationForScope).toHaveBeenCalledTimes(1);
      expect(writeHlsEdgeRevocationForScope).toHaveBeenCalledWith(
        CHANNEL,
        [ALICE, BOB],
        T0,
      );
      expect(writeHlsEdgeChannelRevocation).not.toHaveBeenCalled();
    });

    it("revokeHlsAccessForUser hits the same hook, once per channel", () => {
      revokeHlsAccessForUser(ALICE, [CHANNEL, OTHER], T0);
      expect(writeHlsEdgeRevocationForScope).toHaveBeenCalledTimes(2);
      expect(writeHlsEdgeRevocationForScope).toHaveBeenCalledWith(CHANNEL, [ALICE], T0);
      expect(writeHlsEdgeRevocationForScope).toHaveBeenCalledWith(OTHER, [ALICE], T0);
      expect(writeHlsEdgeChannelRevocation).not.toHaveBeenCalled();
    });

    it("writes a channel-wide record for an unscoped (everyone) revocation -- no fixed userId list to key per-viewer entries by", () => {
      revokeHlsAccess(CHANNEL, undefined, T0);
      expect(writeHlsEdgeRevocationForScope).not.toHaveBeenCalled();
      expect(writeHlsEdgeChannelRevocation).toHaveBeenCalledTimes(1);
      expect(writeHlsEdgeChannelRevocation).toHaveBeenCalledWith(CHANNEL, T0);
    });

    it("writes a channel-wide record for an exceptUserIds-only scope too -- the conservative direction to err in", () => {
      revokeHlsAccess(CHANNEL, { exceptUserIds: [BOB] }, T0);
      expect(writeHlsEdgeRevocationForScope).not.toHaveBeenCalled();
      expect(writeHlsEdgeChannelRevocation).toHaveBeenCalledTimes(1);
      expect(writeHlsEdgeChannelRevocation).toHaveBeenCalledWith(CHANNEL, T0);
    });
  });

  it("says no by default", () => {
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0, T0)).toBe(false);
  });

  it("revokes only the named user", () => {
    revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, T0)).toBe(true);
    // The rest of the audience keeps watching. A kick is not a shutdown.
    expect(isHlsAccessRevoked(BOB, CHANNEL, T0 - 1, T0)).toBe(false);
  });

  it("revokes everyone when no scope is given (channel deleted or gone private)", () => {
    revokeHlsAccess(CHANNEL, undefined, T0);
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, T0)).toBe(true);
    expect(isHlsAccessRevoked(BOB, CHANNEL, T0 - 1, T0)).toBe(true);
  });

  it("keeps the people named in an except list (the 'who may still see it' shape)", () => {
    revokeHlsAccess(CHANNEL, { exceptUserIds: [BOB] }, T0);
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, T0)).toBe(true);
    expect(isHlsAccessRevoked(BOB, CHANNEL, T0 - 1, T0)).toBe(false);
  });

  it("does not leak across channels", () => {
    revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
    expect(isHlsAccessRevoked(ALICE, OTHER, T0 - 1, T0)).toBe(false);
  });

  it("does not hold out a token minted after the revocation (banned, then unbanned)", () => {
    revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, T0)).toBe(true);
    // Re-admitted, fresh token: the old entry is not about this grant.
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 + 1, T0 + 2)).toBe(false);
  });

  it("revokeHlsAccessForUser covers every channel it is given", () => {
    revokeHlsAccessForUser(ALICE, [CHANNEL, OTHER], T0);
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, T0)).toBe(true);
    expect(isHlsAccessRevoked(ALICE, OTHER, T0 - 1, T0)).toBe(true);
    expect(isHlsAccessRevoked(BOB, CHANNEL, T0 - 1, T0)).toBe(false);
  });

  it("forgets entries older than a token's own lifetime, so the map stays bounded", () => {
    revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
    const wayLater = T0 + 2 * 60 * 60 * 1000;
    // Nothing that old can matter: any token it could catch expired by itself.
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, wayLater)).toBe(false);
  });

  it("keeps every revocation in a window, not just the last one", () => {
    revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
    revokeHlsAccess(CHANNEL, { onlyUserIds: [BOB] }, T0 + 10);
    expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, T0 + 20)).toBe(true);
    expect(isHlsAccessRevoked(BOB, CHANNEL, T0 - 1, T0 + 20)).toBe(true);
  });

  describe("lowering LIVE_HLS_VIEWER_TOKEN_TTL_MS while an old, longer-lived token is still outstanding", () => {
    afterEach(() => {
      delete process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS;
    });

    it("still remembers a revocation past the NEW, shorter TTL, because a token minted under the OLD TTL is still valid that long", () => {
      // A token minted under the default hour-long TTL, revoked five minutes in.
      revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
      // The operator lowers the TTL to one minute. Without the high-water
      // mark, `prune()` would forget this revocation a minute after T0 --
      // long before the OLD token (minted under the hour-long TTL, so valid
      // until T0 + one hour) actually expires.
      process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS = "60000";
      const justPastTheNewShortTtl = T0 + 60_000 + 1;
      expect(
        isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, justPastTheNewShortTtl),
      ).toBe(true);
      // Once genuinely past where even the OLD, longer TTL would have
      // expired the token, forgetting it is correct again.
      const pastEvenTheOldTtl = T0 + 60 * 60 * 1000 + 1;
      expect(isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, pastEvenTheOldTtl)).toBe(
        false,
      );
    });

    it("raising the TTL back up does not need any special handling -- it only ever widens the window", () => {
      process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS = "60000";
      revokeHlsAccess(CHANNEL, { onlyUserIds: [ALICE] }, T0);
      process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS = String(2 * 60 * 60 * 1000);
      const pastTheOldOneMinuteWindow = T0 + 60_000 + 1;
      expect(
        isHlsAccessRevoked(ALICE, CHANNEL, T0 - 1, pastTheOldOneMinuteWindow),
      ).toBe(true);
    });
  });
});
