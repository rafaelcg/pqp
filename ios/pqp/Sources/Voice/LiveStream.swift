import Foundation

/**
 A LiveKit egress HLS playlist for a channel's current broadcast.

 Mirrors `liveHlsStreamSchema` in `packages/shared/src/live-hls.ts`. Arrives on
 two frames, `voice-stream` (the room) and `channel-live` (everyone who may see
 the channel, seat or no seat), and from `GET /api/channels/:id/live`.

 `startedAt` is unix milliseconds AND the session identity. Two streams with
 different `startedAt` are two different broadcasts, which is the difference
 between a picture that reconnected and a picture that restarted; the swap rule
 below is built on it rather than on the URL string, which changes constantly
 for a reason that has nothing to do with the picture (see `hlsUrl`).

 `hlsUrl` is either an absolute URL or, by default, a path on this API that
 must be resolved against the API base (`liveStreamURL`). Either way it is
 STAMPED PER RECIPIENT: the server appends a signed `?t=` token bound to this
 user, this channel and this session, minted fresh every time a frame is
 encoded. So the string differs between two people watching the same thing,
 differs between two frames sent to the same person, and playing a URL copied
 from somebody else fails. Nothing may key off it.
 */
struct LiveHlsStream: Decodable, Equatable, Sendable {
    let hlsUrl: String
    /// Unix milliseconds. The session identity, not a display value.
    let startedAt: Int
    let presenterPeerId: String
    /// What the badge should claim, from the server that started the egress.
    let delaySeconds: Int?
    /// Tallest rendition this session actually started, in lines. Presenter
    /// side only; a viewer has no use for it and decodes it so the shape does
    /// not drift.
    let topHeight: Int?
}

/**
 WHERE THE PLAYER SHOULD POINT, GIVEN WHAT THE SERVER SENT.

 `hlsUrl` is API-relative by default (`LIVE_HLS_SIGNED_URLS` on, which is the
 hosted configuration): `/api/voice/hls-playlist/<channelId>/<startedAt>` plus
 the viewer's `?t=`. It is absolute only when the operator serves playlists
 straight from a public bucket. Both shapes have to work, and the query string
 has to survive, because the query string is the entire authorisation: the
 proxy accepts a request with NO `Authorization` header at all when `?t=`
 verifies (`server/src/api/index.ts`, ahead of the Bearer resolution).

 That branch exists for this player. `AVURLAsset` will not attach a header to
 the playlist fetch, let alone to the variant and segment fetches it makes
 afterwards, so a header-authenticated URL would give a black screen with no
 error worth reading.
 */
func liveStreamURL(hlsUrl: String, apiBaseURL: URL) -> URL? {
    let trimmed = hlsUrl.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !trimmed.isEmpty else { return nil }
    // An absolute URL is used as it stands. `URL(string:relativeTo:)` would
    // also return it unchanged, but only because it re-parses the scheme, and
    // relying on that leaves the intent unreadable.
    if let absolute = URL(string: trimmed), absolute.scheme != nil {
        return absolute
    }
    return URL(string: trimmed, relativeTo: apiBaseURL)?.absoluteURL
}

/// What the player currently holds, so the swap rule can compare it against
/// the freshest frame.
struct AttachedStream: Equatable, Sendable {
    /// The session this URL belongs to (`LiveHlsStream.startedAt`).
    let startedAt: Int
    /// When this URL was handed to the player. The viewer token's clock.
    let attachedAt: Date
}

/// What the player should do next.
enum WatchPlayerMove: Equatable, Sendable {
    /// Keep playing what is already attached. The common answer.
    case keep
    /// Attach this stream, replacing anything playing.
    case attach(LiveHlsStream)
    /// Nothing is being broadcast. Tear the player down.
    case detach
}

/**
 WHEN TO HAND `AVPlayer` A DIFFERENT URL, AND, MOSTLY, WHEN NOT TO.

 The naive version of this restarts the player every thirty seconds, and it
 looks like a network problem rather than like a bug. A seatless viewer gets a
 `channel-live` on the audience keyframe clock (`ROSTER_AUDIENCE_KEYFRAME_MS`,
 30 s) for as long as the broadcast runs, and every one of those frames carries
 a NEWLY MINTED `?t=`, so `hlsUrl` is a different string each time while the
 picture behind it never changed. Swapping on a changed URL therefore means
 swapping twice a minute, all party long, and each swap is a fresh
 `AVPlayerItem`: a black frame, a re-buffer, and the live edge lost.

 So the rule is the opposite of "the URL changed". Once something is playing it
 is left alone unless one of four things is true:

 1. **The broadcast stopped** (`stream` is nil). Detach and say so.
 2. **A different broadcast is running.** `startedAt` is the session, so a new
    one means the host stopped and started again, and the playlist we hold is
    a finished VOD ending in `#EXT-X-ENDLIST`. Playing that is a still frame.
 3. **Playback failed.** The freshest URL carries the freshest token, so a
    retry is worth more than a retry of the same string.
 4. **The token is close to expiring.** `HLS_VIEWER_TOKEN_TTL_MS` is one hour
    and this player, like Safari's, refetches the SAME url for the whole watch
    (no MSE, nothing to hand a new URL to mid-item). At renewal time we always
    hold a URL at most 30 s old, so the swap costs one re-buffer per hour
    rather than one per party. `renewAfter` is deliberately well inside the
    hour: a rebuffer ten minutes early is invisible, and a rebuffer one minute
    late is a dead player.

 A film is longer than an hour, so case 4 is not a corner case. It is the
 middle of the movie on Saturday.
 */
enum WatchStreamSwap {
    /// Server side the token lives `HLS_VIEWER_TOKEN_TTL_MS` (1 hour). This is
    /// the margin inside it, not the TTL.
    static let renewAfter: TimeInterval = 50 * 60

    static func next(
        attached: AttachedStream?,
        latest: LiveHlsStream?,
        failed: Bool,
        now: Date
    ) -> WatchPlayerMove {
        guard let latest else { return .detach }
        guard let attached else { return .attach(latest) }
        if attached.startedAt != latest.startedAt { return .attach(latest) }
        if failed { return .attach(latest) }
        if now.timeIntervalSince(attached.attachedAt) >= renewAfter {
            return .attach(latest)
        }
        return .keep
    }
}

/// `GET /api/channels/:channelId/live`. The seed for a client that opened the
/// channel before its socket delivered a frame, and the re-read after a
/// failure. `stream` is stamped for the caller like the frames are.
struct ChannelLiveState: Decodable, Sendable {
    let stream: LiveHlsStream?
    /// Viewers watching without a seat.
    let watching: Int
    /// Seats in the voice room, presenter included.
    let participants: Int
}
