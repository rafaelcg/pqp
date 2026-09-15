import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LIVE_HLS_MODE_LL, LIVE_HLS_MODE_PARAM } from "@pqp/shared";
import {
  HLS_PARTY_PASS_PARAM,
  HLS_VIEWER_TOKEN_TTL_MS,
  LIVE_HLS_PARTY_PASS_MAX_TTL_MS,
  decodeHlsViewerToken,
  describeHlsPartyPass,
  hlsPartyPassTtlMs,
  hlsViewerTokenTtlMs,
  mintHlsPartyPass,
  mintHlsViewerToken,
  stampViewerStream,
  verifyHlsPartyPass,
  verifyHlsViewerToken,
} from "./hls-viewer-token.js";

const CHANNEL = "00000000-0000-4000-8000-0000000000aa";
const OTHER = "00000000-0000-4000-8000-0000000000bb";
const STARTED_AT = 1_700_000_000_000;
const USER = "11111111-1111-4111-8111-111111111111";

describe("HLS viewer token", () => {
  beforeEach(() => {
    process.env.CLERK_SECRET_KEY = "sk_test_hls";
  });
  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.DEV_AUTH_BYPASS;
    delete process.env.LIVE_HLS_PLAYLIST_BASE_URL;
    delete process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS;
    delete process.env.LIVE_HLS_PARTY_PASS_TTL_MS;
  });

  it("round-trips the user for the same channel and session", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    });
    expect(token).not.toBeNull();
    expect(
      verifyHlsViewerToken(token, { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
  });

  it("is bound to the channel and the session, and expires", () => {
    const now = 1_000_000;
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      now,
    })!;
    expect(
      verifyHlsViewerToken(token, { channelId: OTHER, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken(token, { channelId: CHANNEL, startedAt: STARTED_AT + 1 }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken(
        token,
        { channelId: CHANNEL, startedAt: STARTED_AT },
        now + HLS_VIEWER_TOKEN_TTL_MS + 1,
      ),
    ).toBeNull();
  });

  it("refuses a tampered MAC and garbage", () => {
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
    })!;
    const tampered = `${token.slice(0, -2)}xx`;
    expect(
      verifyHlsViewerToken(tampered, { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken("nope", { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
    expect(
      verifyHlsViewerToken(undefined, { channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
  });

  it("stamps the proxy path per recipient and leaves a public URL alone", () => {
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    const url = new URL(stamped.hlsUrl, "https://api.example.test");
    expect(url.pathname).toBe(stream.hlsUrl);
    expect(
      verifyHlsViewerToken(url.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });

    const publicStream = { ...stream, hlsUrl: "https://live.example.test/x.m3u8" };
    expect(stampViewerStream(publicStream, USER)).toEqual(publicStream);
  });

  it("keeps an LL session's `?mode=ll` marker and appends the token beside it", () => {
    // ONE URL, TWO QUERY PARAMETERS, AND NEITHER MAY EAT THE OTHER. The
    // marker is what makes the edge Worker serve the LL master for this
    // request (`LIVE_HLS_MODE_PARAM`); the token is what authorises it. The
    // marker arrives already on the path, so `appendParam` has to join with
    // `&` -- a `?` here would produce a URL whose token is part of the mode
    // value and whose mode is unreadable, i.e. a viewer silently demoted to
    // the conventional master, which is the exact failure this marker
    // exists to end.
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?${LIVE_HLS_MODE_PARAM}=${LIVE_HLS_MODE_LL}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      mode: "ll" as const,
      partTargetMs: 500,
    };
    const stamped = stampViewerStream(stream, USER);
    const url = new URL(stamped.hlsUrl, "https://api.example.test");
    expect(url.pathname).toBe(`/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`);
    expect(url.searchParams.get(LIVE_HLS_MODE_PARAM)).toBe(LIVE_HLS_MODE_LL);
    expect(
      verifyHlsViewerToken(url.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
    // And the two fields the client configures its engine from survive the
    // stamping untouched.
    expect(stamped.mode).toBe("ll");
    expect(stamped.partTargetMs).toBe(500);
  });

  it("extracts the channel from a marker-carrying URL, so the token names the right session", () => {
    // `extractChannelId` matches on the path prefix, which the marker sits
    // AFTER -- but a token minted for the wrong channel verifies nowhere, so
    // this is worth stating rather than assuming.
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.example.test";
    const stamped = stampViewerStream(
      {
        hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}?${LIVE_HLS_MODE_PARAM}=${LIVE_HLS_MODE_LL}`,
        startedAt: STARTED_AT,
        presenterPeerId: "peer-1",
        mode: "ll" as const,
      },
      USER,
    );
    const url = new URL(stamped.hlsUrl);
    expect(url.origin).toBe("https://hls.example.test");
    expect(url.searchParams.get(LIVE_HLS_MODE_PARAM)).toBe(LIVE_HLS_MODE_LL);
    expect(
      verifyHlsViewerToken(url.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).not.toBeNull();
    expect(
      verifyHlsViewerToken(url.searchParams.get("t"), {
        channelId: OTHER,
        startedAt: STARTED_AT,
      }),
    ).toBeNull();
  });

  it("stamps the camera playlist with the SAME token, not a second one", () => {
    // A SECOND CREDENTIAL IS A SECOND THING THAT CAN FAIL (pitfall 16). The
    // camera is a rendition of the same session, so it is the same capability:
    // one token, one expiry, one thing to get wrong.
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    const film = new URL(stamped.hlsUrl, "https://api.example.test");
    const camera = new URL(stamped.cameraHlsUrl!, "https://api.example.test");
    expect(camera.pathname).toBe(stream.cameraHlsUrl);
    expect(camera.searchParams.get("t")).toBe(film.searchParams.get("t"));
    expect(
      verifyHlsViewerToken(camera.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
  });

  it("stamps the token BEFORE prepending the edge host, so the edge Worker gets a real token", () => {
    // THE BUG THIS PINS. An earlier version applied `LIVE_HLS_PLAYLIST_BASE_URL`
    // inside `viewerPlaylistUrl` (hls-egress.ts), before this function ever
    // saw the stream. That made `stream.hlsUrl` arrive here already absolute
    // (`https://hls.pqp.gg/...`), which is indistinguishable from the
    // `LIVE_HLS_SIGNED_URLS=false` raw-bucket case just below -- so
    // `stampViewerStream` took the "already public, leave it alone" branch
    // and handed out a `?t=`-less URL. Every request to the edge Worker then
    // 401'd "missing". The edge host now goes on HERE, after minting, so the
    // "is this already absolute" check only ever sees a genuinely public URL.
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    expect(stamped.hlsUrl.startsWith("https://hls.pqp.gg/api/voice/hls-playlist/")).toBe(
      true,
    );
    const film = new URL(stamped.hlsUrl);
    const camera = new URL(stamped.cameraHlsUrl!);
    expect(film.host).toBe("hls.pqp.gg");
    expect(film.pathname).toBe(stream.hlsUrl);
    expect(camera.host).toBe("hls.pqp.gg");
    expect(camera.pathname).toBe(stream.cameraHlsUrl);
    // The token verifies against the ORIGINAL channel/session, same as an
    // API-relative stamp -- the edge host is cosmetic to the capability.
    expect(
      verifyHlsViewerToken(film.searchParams.get("t"), {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      }),
    ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
    expect(camera.searchParams.get("t")).toBe(film.searchParams.get("t"));
  });

  it("strips a trailing slash from LIVE_HLS_PLAYLIST_BASE_URL, same as the public base URL", () => {
    process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg/";
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    const stamped = stampViewerStream(stream, USER);
    expect(stamped.hlsUrl.startsWith("https://hls.pqp.gg//")).toBe(false);
    expect(stamped.hlsUrl.startsWith(`https://hls.pqp.gg${stream.hlsUrl}`)).toBe(true);
  });

  it("leaves a stream with no camera exactly as it was", () => {
    const stream = {
      hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
      startedAt: STARTED_AT,
      presenterPeerId: "peer-1",
      delaySeconds: 10,
    };
    expect(stampViewerStream(stream, USER).cameraHlsUrl).toBeUndefined();
  });

  it("has no key without Clerk or the dev bypass, and a dev key with it", () => {
    delete process.env.CLERK_SECRET_KEY;
    expect(
      mintHlsViewerToken({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
    ).toBeNull();
    process.env.DEV_AUTH_BYPASS = "true";
    expect(
      mintHlsViewerToken({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
    ).not.toBeNull();
  });

  describe("decodeHlsViewerToken", () => {
    // BROADCAST_PIPELINE B0.6: the telemetry route uses this, not
    // `verifyHlsViewerToken`, because it does not yet know which
    // channel/session to expect -- the whole point is to have the token NAME
    // it, rather than trusting a client-supplied string (Farol finding,
    // 2026-09-13).
    it("names the channel and session a valid token carries, with no expected pair to check against", () => {
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      });
      expect(decodeHlsViewerToken(token)).toEqual({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        issuedAt: expect.any(Number),
        purpose: "live",
      });
    });

    it("carries the replay purpose through", () => {
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        purpose: "replay",
      });
      expect(decodeHlsViewerToken(token)?.purpose).toBe("replay");
    });

    it("is null for a missing, malformed, tampered or expired token", () => {
      const now = 1_000_000;
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        now,
      })!;
      expect(decodeHlsViewerToken(null)).toBeNull();
      expect(decodeHlsViewerToken(undefined)).toBeNull();
      expect(decodeHlsViewerToken("not-a-token")).toBeNull();
      expect(decodeHlsViewerToken(`${token.slice(0, -2)}xx`)).toBeNull();
      expect(
        decodeHlsViewerToken(token, now + HLS_VIEWER_TOKEN_TTL_MS + 1),
      ).toBeNull();
    });

    it("agrees with verifyHlsViewerToken on the same token", () => {
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      });
      const decoded = decodeHlsViewerToken(token);
      const verified = verifyHlsViewerToken(token, {
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      });
      expect(decoded?.userId).toBe(verified?.userId);
      expect(decoded?.issuedAt).toBe(verified?.issuedAt);
    });
  });

  it("LIVE_HLS_VIEWER_TOKEN_TTL_MS moves the effective TTL, and a non-positive value keeps the default", () => {
    expect(hlsViewerTokenTtlMs()).toBe(HLS_VIEWER_TOKEN_TTL_MS);
    process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS = "120000";
    expect(hlsViewerTokenTtlMs()).toBe(120_000);
    const now = 1_000_000;
    const token = mintHlsViewerToken({
      userId: USER,
      channelId: CHANNEL,
      startedAt: STARTED_AT,
      now,
    })!;
    // Still good just before the CONFIGURED ttl, unlike the hardcoded default.
    expect(
      verifyHlsViewerToken(
        token,
        { channelId: CHANNEL, startedAt: STARTED_AT },
        now + 120_000 - 1,
      ),
    ).toEqual({ userId: USER, issuedAt: now });
    expect(
      verifyHlsViewerToken(
        token,
        { channelId: CHANNEL, startedAt: STARTED_AT },
        now + 120_000 + 1,
      ),
    ).toBeNull();

    process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS = "0";
    expect(hlsViewerTokenTtlMs()).toBe(HLS_VIEWER_TOKEN_TTL_MS);
    process.env.LIVE_HLS_VIEWER_TOKEN_TTL_MS = "not-a-number";
    expect(hlsViewerTokenTtlMs()).toBe(HLS_VIEWER_TOKEN_TTL_MS);
  });

  describe("the party pass", () => {
    it("round-trips the user for the same channel and session, at a distance the viewer token could never reach", () => {
      const now = 1_000_000;
      const pass = mintHlsPartyPass({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        now,
      });
      expect(pass).not.toBeNull();
      expect(
        verifyHlsPartyPass(pass, { channelId: CHANNEL, startedAt: STARTED_AT }, now),
      ).toEqual({ userId: USER, issuedAt: now });
      // Still good most of a day past where the viewer token would have
      // expired hours ago.
      const almostSixHoursLater = now + LIVE_HLS_PARTY_PASS_MAX_TTL_MS - 1;
      expect(
        verifyHlsPartyPass(
          pass,
          { channelId: CHANNEL, startedAt: STARTED_AT },
          almostSixHoursLater,
        ),
      ).toEqual({ userId: USER, issuedAt: now });
    });

    it("is bound to the channel and the session, and expires at its own ceiling", () => {
      const now = 1_000_000;
      const pass = mintHlsPartyPass({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        now,
      })!;
      expect(
        verifyHlsPartyPass(pass, { channelId: OTHER, startedAt: STARTED_AT }, now),
      ).toBeNull();
      expect(
        verifyHlsPartyPass(pass, { channelId: CHANNEL, startedAt: STARTED_AT + 1 }, now),
      ).toBeNull();
      expect(
        verifyHlsPartyPass(
          pass,
          { channelId: CHANNEL, startedAt: STARTED_AT },
          now + LIVE_HLS_PARTY_PASS_MAX_TTL_MS + 1,
        ),
      ).toBeNull();
    });

    it("cannot be verified as a viewer token, and a viewer token cannot be verified as a party pass", () => {
      // THE PROPERTY THE DESIGN RESTS ON: two different derived secrets, so
      // neither verify function can ever accept the other's credential --
      // this is what keeps "the API keeps the short TTL for its own proxy"
      // true without any caller having to remember a purpose check.
      const pass = mintHlsPartyPass({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      })!;
      const token = mintHlsViewerToken({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
      })!;
      expect(
        verifyHlsViewerToken(pass, { channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toBeNull();
      expect(
        verifyHlsPartyPass(token, { channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toBeNull();
      expect(
        describeHlsPartyPass(token, { channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toBe("bad-signature");
    });

    it("LIVE_HLS_PARTY_PASS_TTL_MS can only shorten the ceiling, never lengthen it", () => {
      expect(hlsPartyPassTtlMs()).toBe(LIVE_HLS_PARTY_PASS_MAX_TTL_MS);
      process.env.LIVE_HLS_PARTY_PASS_TTL_MS = String(LIVE_HLS_PARTY_PASS_MAX_TTL_MS * 10);
      expect(hlsPartyPassTtlMs()).toBe(LIVE_HLS_PARTY_PASS_MAX_TTL_MS);
      process.env.LIVE_HLS_PARTY_PASS_TTL_MS = "60000";
      expect(hlsPartyPassTtlMs()).toBe(60_000);
      const now = 1_000_000;
      const pass = mintHlsPartyPass({
        userId: USER,
        channelId: CHANNEL,
        startedAt: STARTED_AT,
        now,
      })!;
      expect(
        verifyHlsPartyPass(
          pass,
          { channelId: CHANNEL, startedAt: STARTED_AT },
          now + 60_000 + 1,
        ),
      ).toBeNull();
    });

    it("LIVE_HLS_PARTY_PASS_TTL_MS=0 disables minting entirely", () => {
      process.env.LIVE_HLS_PARTY_PASS_TTL_MS = "0";
      expect(hlsPartyPassTtlMs()).toBe(0);
      expect(
        mintHlsPartyPass({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toBeNull();
    });

    it("has no pass without Clerk or the dev bypass, and a dev pass with it", () => {
      delete process.env.CLERK_SECRET_KEY;
      expect(
        mintHlsPartyPass({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toBeNull();
      process.env.DEV_AUTH_BYPASS = "true";
      expect(
        mintHlsPartyPass({ userId: USER, channelId: CHANNEL, startedAt: STARTED_AT }),
      ).not.toBeNull();
    });

    it("stampViewerStream attaches ?pp= only when the edge host is configured", () => {
      const stream = {
        hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
        cameraHlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}/cam360p30`,
        startedAt: STARTED_AT,
        presenterPeerId: "peer-1",
        delaySeconds: 10,
      };

      // No edge host: no party pass on either rendition, and the API's own
      // proxy is never handed one to ignore.
      const withoutEdge = stampViewerStream(stream, USER);
      const filmNoEdge = new URL(withoutEdge.hlsUrl, "https://api.example.test");
      expect(filmNoEdge.searchParams.has(HLS_PARTY_PASS_PARAM)).toBe(false);

      process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
      const withEdge = stampViewerStream(stream, USER);
      const film = new URL(withEdge.hlsUrl);
      const camera = new URL(withEdge.cameraHlsUrl!);
      const filmPass = film.searchParams.get(HLS_PARTY_PASS_PARAM);
      const cameraPass = camera.searchParams.get(HLS_PARTY_PASS_PARAM);
      expect(filmPass).toBeTruthy();
      expect(cameraPass).toBeTruthy();
      expect(
        verifyHlsPartyPass(filmPass, { channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
      expect(
        verifyHlsPartyPass(cameraPass, { channelId: CHANNEL, startedAt: STARTED_AT }),
      ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
      // The API's own proxy token (`?t=`) is still present and unaffected.
      expect(
        verifyHlsViewerToken(film.searchParams.get("t"), {
          channelId: CHANNEL,
          startedAt: STARTED_AT,
        }),
      ).toEqual({ userId: USER, issuedAt: expect.any(Number) });
    });

    it("stampViewerStream omits ?pp= when the pass is disabled by env, even with an edge host", () => {
      process.env.LIVE_HLS_PLAYLIST_BASE_URL = "https://hls.pqp.gg";
      process.env.LIVE_HLS_PARTY_PASS_TTL_MS = "0";
      const stream = {
        hlsUrl: `/api/voice/hls-playlist/${CHANNEL}/${STARTED_AT}`,
        startedAt: STARTED_AT,
        presenterPeerId: "peer-1",
        delaySeconds: 10,
      };
      const stamped = stampViewerStream(stream, USER);
      const film = new URL(stamped.hlsUrl);
      expect(film.searchParams.has(HLS_PARTY_PASS_PARAM)).toBe(false);
      // The viewer token is still there -- the edge Worker falls all the way
      // back to gating on it alone, same as before the party pass existed.
      expect(film.searchParams.get("t")).toBeTruthy();
    });
  });
});
