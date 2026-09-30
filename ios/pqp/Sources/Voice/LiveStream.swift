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
    /// Highest fps a started rung encodes. Presenter-side; ignored by the player.
    let topFramerate: Int?
    /**
     A SECOND playlist, carrying the presenter's camera and nothing else.
     Mirrors `LiveHlsStream.cameraHlsUrl` (`packages/shared/src/live-hls.ts`).
     Same session as `hlsUrl` for as long as the camera stays on: it never
     mints its own identity, so `WatchCameraStreamSwap` keys on the URL's own
     path rather than on `startedAt`. Absent means no camera is running right
     now (off, refused for budget, or a server that predates this field).
     */
    let cameraHlsUrl: String?
    /// Whether `cameraHlsUrl` actually carries a picture. Absent or true is
    /// every camera before `LIVE_HLS_VOICE_TRACK` existed; false is the
    /// audio-only "separada" shape, where the rung exists but has nothing to
    /// paint.
    let cameraHasVideo: Bool?
    /// Whether `cameraHlsUrl` carries the presenter's MICROPHONE separately
    /// from `hlsUrl`. Absent or false keeps a camera silent, exactly as it
    /// always was.
    let cameraHasVoiceAudio: Bool?

    /// Whether `cameraHlsUrl` should be drawn with a picture. Defaults true
    /// when the field is absent, same as the web reads it.
    var resolvedCameraHasVideo: Bool { cameraHasVideo ?? true }
    /// Whether `cameraHlsUrl` should be unmuted. Defaults false, same as the
    /// web reads it.
    var resolvedCameraHasVoiceAudio: Bool { cameraHasVoiceAudio ?? false }
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

/**
 THE `?t=` VIEWER TOKEN, PULLED BACK OUT OF `hlsUrl`.

 The same capability that authorises the playlist fetch is what
 `POST /api/live-hls/presence` wants back (`WatchModel`'s presence beat,
 mirroring `client/src/lib/hls-playback.ts`'s `sendHlsPresence`), so this is
 just the query string read the other direction. Works on either shape
 `hlsUrl` comes in (API-relative or an absolute bucket URL): both are query
 strings, and `URLComponents` does not care which.
 */
func hlsSessionToken(from hlsUrl: String) -> String? {
    URLComponents(string: hlsUrl)?
        .queryItems?
        .first(where: { $0.name == "t" })?
        .value
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

/**
 WHAT TO DO WHEN `AVPlayer` DECLARES A HARD FAILURE, BOUNDED.

 `AVPlayerItem.status == .failed` most often means the token in the attached
 URL just expired: `WatchStreamSwap` only refreshes the URL on the NEXT frame
 or the NEXT renewal window, and if the socket has been quiet (backgrounded,
 reconnecting) the freshest thing this player is holding can be the very token
 that was just rejected. Retrying it verbatim reproduces the production
 symptom this fix exists for: a client hammering an expired token forever
 because nothing ever asks for a new one.

 So the right first move on a hard failure is always to ask the server for a
 fresh stream (`WatchModel.refreshLive`) before giving up. But a stream that
 is genuinely gone — the process died, the host is not coming back — must not
 turn into an infinite refetch loop, which is its own way of hammering the
 API. This caps it the same way `android/.../watch/HlsWatchdog.kt` caps its
 reconnects: a small number of attempts inside a rolling window, and once
 that is exhausted the existing "Try again" card takes over rather than
 spinning forever. A re-buffer on a real recovery is an acceptable cost;
 getting stuck, or never stopping, is not.

 Pure and Date-driven on purpose, like `WatchStreamSwap` above: exercised in
 tests with no `AVPlayer` and no network.
 */
struct WatchFailureRecovery: Sendable {
    /// Mirrors `HlsWatchdog.maxReconnects` on Android.
    static let maxAttempts = 3
    /// Mirrors `HlsWatchdog.windowMs` on Android (5 minutes).
    static let windowSeconds: TimeInterval = 5 * 60

    /// What the caller should do about one hard failure.
    enum Decision: Equatable, Sendable {
        /// Ask the server for a fresh stream and reattach if it answers with
        /// one. Still within budget.
        case refetch
        /// Budget exhausted: show the failed card instead of trying again.
        case giveUp
    }

    private var attempts: [Date] = []

    /// Record one failure and decide what to do about it.
    mutating func onFailure(now: Date) -> Decision {
        attempts.removeAll { now.timeIntervalSince($0) >= Self.windowSeconds }
        if attempts.count >= Self.maxAttempts { return .giveUp }
        attempts.append(now)
        return .refetch
    }

    /// A clean slate: a manual retry, or a reattach that actually stuck.
    mutating func reset() {
        attempts.removeAll()
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
