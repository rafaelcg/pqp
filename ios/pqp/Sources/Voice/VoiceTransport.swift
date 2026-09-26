import Foundation

/// The media transport a voice room runs on, as the server states it.
///
/// Mirrors `voiceRoomTransportSchema` in `packages/shared/src/signaling.ts`.
/// The server pins one per room and says which in `welcome.transport` and in
/// every `voice-roster.transport`; a client never infers it.
enum VoiceRoomTransport: String, Sendable, Equatable {
    case mesh
    case livekit

    /// What this build can run, in the order the server reads them. Sent on
    /// every `join-voice-room` as a capability declaration, not a preference:
    /// the server refuses a room pinned to anything not listed here *before* a
    /// peer exists, so the refusal is honest and nobody else ever sees us.
    static let supported: [String] = [VoiceRoomTransport.mesh.rawValue,
                                      VoiceRoomTransport.livekit.rawValue]
}

/// What a `welcome` (or a roster) says about how to reach the room's media.
///
/// Pulled out of the models so the rule can be pinned by a test without a
/// socket: `VoiceModel` and `CallModel` both switch on this, and the bug it
/// prevents is silent (a client that builds the wrong transport looks, to
/// everyone else, like a participant who never unmutes).
enum VoiceTransportPlan: Equatable, Sendable {
    /// Build peer connections to everyone in the roster.
    case mesh
    /// Build nothing peer to peer. Mint a token, connect a LiveKit room.
    case livekit
    /// The server named a transport this build does not know. Leave and say so.
    case unsupported(String)

    /// Absent means a server that predates the field, which is mesh by
    /// definition: there was no other transport when it was written.
    init(transport: String?) {
        switch transport {
        case nil, VoiceRoomTransport.mesh.rawValue: self = .mesh
        case VoiceRoomTransport.livekit.rawValue: self = .livekit
        case let other?: self = .unsupported(other)
        }
    }

    var transport: VoiceRoomTransport? {
        switch self {
        case .mesh: .mesh
        case .livekit: .livekit
        case .unsupported: nil
        }
    }
}

/// Body of `POST /api/voice/token`, mirroring `voiceSessionRequestSchema`.
///
/// `peerId` is the id the WS `welcome` assigned; the SFU participant identity
/// is that same string, which is what lets the roster, the speaking rings and
/// the tiles stay keyed by one id across both transports (the same rule as
/// `client/src/lib/livekit-session.ts`).
struct VoiceSessionRequest: Encodable, Equatable, Sendable {
    let voiceChannelId: String
    let peerId: String
}

/// Answer to `POST /api/voice/token`, mirroring `voiceSessionSchema`.
struct VoiceSessionInfo: Decodable, Equatable, Sendable {
    let backend: String
    /// LiveKit signalling URL (`wss://…`), passed straight to `Room.connect`.
    let url: String
    let token: String
    let room: String
    /// Equal to the peer id we asked for. Kept so a mismatch is visible.
    let identity: String
    /// The SFU region the room is pinned to (`sao`, `mia`, ...), present only
    /// when the deployment runs more than one. Informational: `url` already
    /// names the box, and that is what `Room.connect` dials, so a room this
    /// build opens follows the server's region policy like any other (it
    /// declares `sfu-region` in `wireCaps` in `RealtimeClient.swift`, and
    /// builds that do not are trusted too unless the server sets
    /// `LIVEKIT_REGION_REQUIRE_CAP`); see `docs/plans/SFU_REGIONS.md`.
    let region: String?
}

/// Answer to `GET /api/voice/backend`: what a *new* room on this deployment
/// will be pinned to. Advisory before joining, binding never; `welcome` is.
struct VoiceBackendInfo: Decodable, Sendable {
    let backend: String

    /// Whether this deployment has an SFU at all. The *deployment's* default,
    /// never a statement about the room being joined: a LiveKit deployment
    /// still pins small servers and every conversation call to mesh. Feeding
    /// this straight into `join-voice-room.resume` is the ghost seat bug; see
    /// `declaresVoiceResume`.
    var runsLiveKit: Bool { backend == VoiceRoomTransport.livekit.rawValue }
}

/// What kind of room is being joined, as far as the client can know before
/// `welcome` answers.
///
/// Load-bearing for exactly one decision, and only because the server's own
/// policy is unconditional here: `resolveVoiceTransport` returns mesh for any
/// channel whose kind is not `server`, before it looks at anything else. So a
/// conversation call's transport IS knowable at join time, and a voice
/// channel's is not.
enum VoiceRoomKind: Equatable, Sendable {
    /// A DM or group call. Always mesh, by `transport-policy.ts`.
    case conversation
    /// A server voice channel. Mesh or LiveKit depending on the server's size,
    /// its community flag and the channel override, none of which this client
    /// can compute.
    case serverChannel
}

/**
 WHETHER TO ASK THE SERVER TO HOLD THIS SEAT ACROSS A SOCKET DROP.

 `join-voice-room.resume` is not a preference and not an optimisation. It is a
 PROMISE that this client is still holding live media and will come back to
 this exact peer id, and the server acts on it: `removeVoicePeerBySocket` keeps
 a peer that declared it for `VOICE_RESUME_TTL_MS` (90 seconds) instead of
 removing it and telling the room.

 THE BUG THIS REPLACES. The declaration used to be read off
 `GET /api/voice/backend`, which answers what a NEW room on this DEPLOYMENT
 would be pinned to. Production runs LiveKit, so it answered yes for every
 room, including the mesh ones. And this client cannot honour it on a mesh
 room: `ready` tears every peer connection down and rejoins cold with a new
 peer id. So every mesh call left a seat nobody was in, in the roster, for 90
 seconds after the phone dropped, backgrounded or was killed. Every
 conversation call is mesh, so every DM call did it. That is a one person room
 that nobody is in.

 The rule is therefore: declare it only where this client can actually keep the
 promise, and say nothing where it cannot know.

 - A room we are already in and know is on **mesh**: no. We tear it down and
   cold rejoin, so a held seat is a ghost by construction.
 - A room we are already in and know is on **LiveKit**: yes. The media is a
   separate connection to a separate host and it is still up, which is exactly
   what the seat is being held for.
 - A **cold join** with no `welcome` yet:
   - a conversation call is mesh by server policy, so: no. Correct by
     construction rather than by guess.
   - a server voice channel is genuinely unknown here, so this keeps the old
     deployment guess rather than trading one silent wrong answer for another.
     A small server's mesh channel can therefore still ghost once, on the first
     drop of a session. The durable fix is server side and belongs there: the
     server knows the room's pinned transport and could simply decline to hold
     a mesh seat, which would also fix every build already on a phone.
 */
func declaresVoiceResume(
    roomKind: VoiceRoomKind,
    knownTransport: VoiceRoomTransport?,
    deploymentRunsLiveKit: Bool
) -> Bool {
    if let knownTransport {
        return knownTransport == .livekit
    }
    switch roomKind {
    case .conversation:
        return false
    case .serverChannel:
        return deploymentRunsLiveKit
    }
}

/// What a `welcome` handed back that a later rejoin can present.
///
/// Memory only, like the web client: the token proves this user owned this
/// peer in this channel, and it is only ever sent back on the same socket's
/// successor. Nothing persists it.
struct VoiceResumeClaim: Sendable, Equatable {
    let peerId: String
    let token: String
}

/// How long an SFU join may take before the client gives up and leaves.
///
/// The same 45 seconds as `SFU_JOIN_TIMEOUT_MS` in `use-voice.ts`. Long
/// enough for a cold TLS handshake to a LiveKit host on a bad mobile link,
/// short enough that a black-holing host does not leave somebody on
/// "Connecting" for the rest of the call. LiveKit's own connect timeout is
/// shorter for a host that answers and refuses; this bounds the one that
/// never answers at all.
let sfuJoinTimeout: Duration = .seconds(45)

/// Why an SFU join ended without media. Every case leaves the room; none of
/// them builds a mesh instead, because the rest of the room is on the SFU and
/// would neither hear this client nor see it drop out.
enum SfuJoinError: Error, Equatable, Sendable {
    /// `POST /api/voice/token` failed.
    case token(String)
    /// The LiveKit room refused or errored while connecting.
    case connect(String)
    /// `sfuJoinTimeout` elapsed with no connected room.
    case timedOut
    /// The room connected and the microphone would not publish. `VoiceModel`
    /// ends the session on this only when the microphone's state is unknown
    /// (`SfuMicrophoneOutcome.unknownState`); a clean failure keeps the seat
    /// there. `CallModel` ends the call on either.
    case microphone(String)
    /// The room connected and was gone again by the time the microphone step
    /// ran. Not "could not reach": it was reached.
    case lost(String)
    /// The join was abandoned by a leave (or a displacement) that landed while
    /// the token or the connect was in flight. Not a failure to show.
    case superseded
}

/// The one sentence the user sees for every `SfuJoinError` worth showing.
///
/// The unreachable sentence is identical to the web's
/// `voice.error.transportUnreachable`, on purpose: the two clients meet in the
/// same call and should describe the same failure the same way. It is ONLY for
/// what fails before the room is up. `microphone` and `lost` fail after, once
/// the server has been reached and has accepted us, and blaming the network's
/// reach for them sends somebody off to check a connection that worked.
/// `superseded` has no copy because nothing went wrong.
///
/// `promoted` is a call somebody was already in, which "you have not joined
/// this call" is false about; see `sfuPromotionFailureMessage`. The two
/// after-connect sentences already say "the call ended", which is true on
/// both paths, so they do not vary with it.
///
/// `room` is what the person thinks they are in. A watch party is a
/// broadcast, not a call, and its host was never joining a "voice server":
/// telling them so sends them looking for a call that was never the point
/// (`SfuRoomKind`).
func sfuFailureMessage(
    _ error: SfuJoinError, promoted: Bool = false, room: SfuRoomKind = .call
) -> String? {
    switch room {
    case .call: sfuCallFailureMessage(error, promoted: promoted)
    case .stream: sfuStreamFailureMessage(error)
    }
}

private func sfuCallFailureMessage(_ error: SfuJoinError, promoted: Bool) -> String? {
    switch error {
    case .superseded:
        nil
    case .microphone:
        String(localized: "Your microphone could not start on the voice server, so the call ended. Try again.")
    case .lost:
        String(localized: "The connection to the voice server dropped, so the call ended. Join again to come back.")
    case .token, .connect, .timedOut:
        promoted
            ? sfuPromotionFailureMessage()
            : String(localized: "Could not reach the voice server, so you have not joined this call. Check your network and try again.")
    }
}

/// The same four outcomes in a watch party's words. No "voice server" and no
/// "call": the thing that failed is the stream. `promoted` does not vary it,
/// because a watch party room is on the stream server from its first seat and
/// is never moved there mid-show.
private func sfuStreamFailureMessage(_ error: SfuJoinError) -> String? {
    switch error {
    case .superseded:
        nil
    case .microphone:
        String(localized: "Your microphone could not start, so the stream stopped. Try again.")
    case .lost:
        String(localized: "The connection to the stream server dropped, so the stream stopped. Try again to come back.")
    case .token, .connect, .timedOut:
        String(localized: "Could not connect to the stream server. Check your network and try again.")
    }
}

/**
 Which words a failure in this room is described in.

 `call` is every voice channel and conversation. `stream` is a `watch_party`
 channel, whose seat exists to present a broadcast (`docs/WATCH_PARTY.md`):
 its errors never mention a voice server, and a microphone that will not
 start never ends it (`sfuMicrophoneDisposition`).
 */
enum SfuRoomKind: Equatable, Sendable {
    case call
    case stream
}

/// A room's kind, from the channel it belongs to.
func sfuRoomKind(isWatchPartyChannel: Bool) -> SfuRoomKind {
    isWatchPartyChannel ? .stream : .call
}

/**
 What became of the microphone once the LiveKit room itself was up.

 Its own step with its own outcome, separate from the connect, because the two
 fail for different reasons and mean different things. A connect that fails
 means nobody can hear or see anybody. A microphone that fails to publish means
 the room is fine and only this phone's voice is missing from it.

 And the SDK has a way of failing that is exactly the second kind:
 `LocalParticipant._publish` waits for the first captured audio frame
 (`LocalAudioTrack.startWaitingForFrames`, whose `AudioFrameWatcher` gives up
 after 5 seconds) AFTER the server has already accepted the track. Folded into
 `SfuJoinError.connect`, that told a host who was connected, published and seen
 by the server that the voice server could not be reached, then walked them out
 of a room that was working.
 */
enum SfuMicrophoneOutcome: Equatable, Sendable {
    /// On the wire, muted or not as asked.
    case published
    /// Deliberately not published: a listen-only seat (`welcome.canSpeak`).
    case withheld
    /// The publish threw and no microphone track is left on the room. The room
    /// is still connected; the only thing missing is this phone's voice.
    case failed(String)
    /// The publish threw and taking the track down threw too, so whether a
    /// microphone is on the wire is unknown. Never a seat worth keeping: a
    /// button that says muted over a track that may be sending is the one
    /// outcome worse than a dropped call.
    case unknownState(String)
    /// There was no connected room to publish into. A connection that went,
    /// not a microphone that would not start.
    case roomLost(String)
}

/// The line a seated person reads when their microphone would not publish and
/// the room kept them anyway. What is true (the room is fine, their voice is
/// not in it) and what to do (unmute, which publishes again).
func sfuMicrophoneFailureNotice(room: SfuRoomKind = .call) -> String {
    switch room {
    case .call:
        String(localized: "Your microphone could not start, so nobody can hear you. You can still listen. Tap unmute to try again.")
    case .stream:
        String(localized: "Your microphone could not start, so nobody can hear you. The stream keeps going. Tap unmute to try again.")
    }
}

/// What a session does after the microphone step.
enum SfuMicrophoneDisposition: Equatable, Sendable {
    /// Stay in the room. `muted` is what the mic control must now read, and
    /// `notice` the sentence to show, if any.
    case keep(muted: Bool, notice: String?)
    /// Stay in the room, and take the microphone down again because nobody
    /// knows whether it is sending: mute it on the wire, show `notice`. Only
    /// a stream room gets this instead of `end`; see `sfuMicrophoneDisposition`.
    case silence(notice: String)
    /// End the session through the ordinary SFU failure path, with this error.
    case end(SfuJoinError)
}

/**
 What a microphone outcome means for the session. Pure, so every branch can be
 pinned without a LiveKit room.

 Only a CLEAN failure (`failed`: the publish threw and the track is gone) is a
 seat worth keeping, and only where the model can keep one (`keepsSeat`:
 `VoiceModel`, whose rooms work fine with a listener in them). It forces mute,
 so the control agrees with the wire and the roster says "muted" rather than
 leaving the room to wonder why somebody went quiet. A room that has gone
 (`roomLost`) and a microphone whose state is unknown (`unknownState`) end the
 session everywhere: the first has no call to keep, the second cannot promise
 the button tells the truth.

 A STREAM ROOM IS THE EXCEPTION FOR `unknownState`. A watch party's host is in
 the room to present; ending the session there ends the broadcast for
 everybody watching, over a microphone the party may not even have asked for.
 So a stream room keeps the seat and silences the microphone instead (mute on
 the wire, the control reads muted, the notice says so), and a microphone
 never ends a broadcast. `roomLost` still ends it: there is no room left to
 present into.
 */
func sfuMicrophoneDisposition(
    _ outcome: SfuMicrophoneOutcome, wasMuted: Bool, keepsSeat: Bool,
    room: SfuRoomKind = .call
) -> SfuMicrophoneDisposition {
    switch outcome {
    case .published, .withheld:
        .keep(muted: wasMuted, notice: nil)
    case .failed(let reason):
        keepsSeat || room == .stream
            ? .keep(muted: true, notice: sfuMicrophoneFailureNotice(room: room))
            : .end(.microphone(reason))
    case .unknownState(let reason):
        room == .stream
            ? .silence(notice: sfuMicrophoneFailureNotice(room: room))
            : .end(.microphone(reason))
    case .roomLost(let reason):
        .end(.lost(reason))
    }
}

/**
 Which mute or unmute a result belongs to.

 An unmute that has to publish the microphone again can take seconds, and the
 person can tap again meanwhile. Without this an older unmute's failure,
 landing after a newer one that worked, re-muted somebody whose microphone was
 on. Every mute-state change takes a ticket; a result is applied only while its
 ticket is still the latest. Monotonic for the model's lifetime, so a ticket
 can never be reissued.
 */
struct MuteRequestLedger: Equatable, Sendable {
    private(set) var latest = 0

    mutating func begin() -> Int {
        latest &+= 1
        return latest
    }

    func isCurrent(_ ticket: Int) -> Bool {
        ticket == latest
    }
}

/// Runs `operation` against the SFU join clock.
///
/// Whichever finishes first wins and the other is cancelled: a connect that
/// completes at 44 seconds is a join, one that completes at 46 is a leave that
/// already happened. The timeout is a parameter so a test can prove the path
/// without waiting the real 45 seconds.
func withSfuTimeout<T: Sendable>(
    _ timeout: Duration = sfuJoinTimeout,
    operation: @escaping @Sendable () async throws -> T
) async throws -> T {
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await Task.sleep(for: timeout)
            throw SfuJoinError.timedOut
        }
        // The first child to finish decides. `next()` rethrows its error, so a
        // timed-out sleep surfaces as `.timedOut` and a failed connect as its
        // own error, and in both cases the loser is cancelled on the way out.
        guard let result = try await group.next() else {
            throw SfuJoinError.timedOut
        }
        group.cancelAll()
        return result
    }
}

/// Whether a `welcome` after a socket drop lets the client keep the LiveKit
/// room it already has, rather than reconnecting media.
///
/// All three have to hold, matching `keepSession` in `use-voice.ts`: the
/// server says it reattached (`resumed`), it reattached *this* peer id (a cold
/// join mints a new one, and a LiveKit participant is keyed by the old one),
/// and the room is still up on our side (a LiveKit room that has itself given
/// up is not media to keep).
func keepsSfuSession(
    resumed: Bool,
    welcomePeerId: String,
    currentPeerId: String?,
    sfuConnected: Bool
) -> Bool {
    resumed && welcomePeerId == currentPeerId && sfuConnected
}

/// The `join-voice-room` frame, built in one place so the shape can be pinned.
///
/// `transports` is always the full list this build supports. `resume` is only
/// declared when the caller says the deployment can honour it (see
/// `VoiceBackendInfo.declaresResume`), and the claim pair is only sent on a
/// rejoin that has one to present.
func joinVoiceRoomFrame(
    channelId: String,
    declaresResume: Bool,
    resume: VoiceResumeClaim?
) -> [String: any Sendable] {
    var frame: [String: any Sendable] = [
        "type": "join-voice-room",
        "voiceChannelId": channelId,
        "transports": VoiceRoomTransport.supported,
    ]
    if declaresResume {
        frame["resume"] = true
    }
    if let resume {
        frame["resumePeerId"] = resume.peerId
        frame["resumeToken"] = resume.token
    }
    return frame
}

// MARK: - A room that moved under the people in it

/**
 WHAT A `voice-transport-changed` FRAME MEANS FOR THIS SESSION.

 The rule everywhere else is that a room keeps the transport it opened on until
 it empties. This frame is the one announced exception: somebody turned on a
 camera the mesh could not carry, or a fourth person walked in, so the server
 moved the WHOLE room to the SFU and told every seat at once. Our seat, our
 peer id, our mute and our place in everyone else's roster all survive. Only
 the media path is rebuilt.

 The server sends it **only** to a socket that declared
 `voice-transport-changed` on `auth`. A socket that did not is released
 instead and told to come back (`voice-transport-unsupported` carrying
 `reason: "promoted"`). That asymmetry is why declaring the capability is a
 promise rather than an optimisation: a build that asks for the frame and then
 fails to act on it keeps a seat in a room whose media it cannot reach, which
 is a person nobody can hear and who is not told. A build that never asks at
 least gets thrown out visibly.

 Pure, and outside the models, for the same reason `VoiceTransportPlan` is:
 `VoiceModel` and `CallModel` both act on this frame, being wrong is silent on
 both, and a rule written twice is a rule that will eventually disagree with
 itself.
 */
enum VoicePromotionAction: Equatable, Sendable {
    /// Tear the mesh down and bring this same call up on `transport`, keeping
    /// the seat and the peer id the server already holds.
    case follow(VoiceRoomTransport)
    /// Change nothing whatever, and in particular do not tear down live media.
    ///
    /// Always the safe answer. A promotion is one way, so a receiver that stays
    /// put stays on the transport the frame was asking it to leave, and the
    /// worst case is the state it was already in. Guessing is what produces the
    /// half moved room the one transport rule exists to prevent.
    case ignore
}

/**
 Whether this session should follow a promotion, given the frame and what the
 session is holding right now.

 Every guard here has a failure behind it:

 - **not live, or a different room.** This socket receives voice frames for
   rooms the phone is merely watching from outside the call. Acting on one
   would tear down the call we are actually in.
 - **no peer id.** The SFU identity IS the peer id the server minted. Without
   one there is nothing to reconnect as, and `POST /api/voice/token` has
   nothing to sign.
 - **a transport this build does not know.** `VoiceTransportPlan` refuses an
   unknown name on `welcome`, and that is right there: nobody has seen us yet,
   so a refusal costs nothing. Here the frame arrives mid call, so an unknown
   value means a newer server moved the room somewhere this build cannot
   reason about, and the honest answer is to leave the live call alone rather
   than hang somebody up over a string. Matches `use-voice.ts`.
 - **the transport we are already on.** Two publishers, or a replay across the
   cluster bus, can deliver this frame twice. Reconnecting on the second copy
   would tear down media that is up and working.

 `mesh` is not followed either. Nothing demotes a live room, so a frame naming
 it is either a duplicate or a server this build does not understand, and both
 are `ignore`.
 */
func voicePromotionAction(
    frameChannelId: String,
    frameTransport: String,
    currentChannelId: String?,
    currentTransport: VoiceRoomTransport?,
    isLive: Bool,
    selfPeerId: String?
) -> VoicePromotionAction {
    guard isLive, let currentChannelId, currentChannelId == frameChannelId else { return .ignore }
    guard selfPeerId != nil else { return .ignore }
    guard frameTransport == VoiceRoomTransport.livekit.rawValue else { return .ignore }
    guard currentTransport != .livekit else { return .ignore }
    return .follow(.livekit)
}

/**
 The one sentence a promoted room puts on screen.

 Three reasons, three sentences, and a reason this build has never heard of
 reads as the general one, which is true of every promotion. Same copy as the
 web client's `voice.notice.promoted*` keys, because the two clients meet in
 the same call and should describe the same event the same way.

 Unlike the web this app also says something for `room-size`. The web has a
 capacity card that already tells that person the camera and screen limits just
 went up; there is no such card here, and there IS a gap in the audio while the
 media is rebuilt, so a line explaining the gap is the difference between a
 call that grew and a call that glitched.
 */
/// What a person is told when the room moved and this phone could not follow.
///
/// Separate from `sfuFailureMessage` because that one ends "so you have not
/// joined this call", which is false about a call somebody was already in. The
/// outcome is the same (the call is over and the seat is gone) so the sentence
/// has to be the same shape: what happened, and what to do about it.
func sfuPromotionFailureMessage() -> String {
    String(localized: "This call became a large room and the voice server could not be reached, so the call ended. Join again to come back.")
}

func voicePromotionNotice(reason: String?) -> String {
    switch reason {
    case "cameras":
        String(localized: "This call became a large room so more cameras fit")
    case "screens":
        String(localized: "This call became a large room so more screens fit")
    default:
        String(localized: "This call became a large room so more people fit")
    }
}
