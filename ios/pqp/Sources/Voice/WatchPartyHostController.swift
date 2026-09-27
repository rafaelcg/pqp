import Foundation
import Observation

/// A sentence for a `performWatchPartyGoLive`/`performWatchPartyEnd` outcome
/// that is not a plain `APIError` -- the ordering functions themselves are
/// silent on purpose (they return a `GoLiveResult`/`Bool`, not a message);
/// this is where that result becomes something a host reads.
enum WatchPartyHostError: LocalizedError {
    case message(String)

    var errorDescription: String? {
        switch self {
        case .message(let text): text
        }
    }
}

/// What this phone is in the middle of doing to a party it is hosting, if
/// anything.
enum WatchPartyHostBusy: Equatable {
    case none
    case creating
    case goingLive
    case ending
}

/**
 The channel's party, as far as this phone currently knows it, and the three
 ways that knowledge can change. Pulled out of `WatchPartyHostController` as
 a plain value type so the race it exists to close -- a slow background
 fetch outliving a fresher realtime update, or getting overwritten instead
 of overwriting -- is provable by a plain unit test rather than only
 readable from a class wired to a real `SessionStore`.

 THREE SOURCES, ONE RULE. A `watch-party-update` frame and the direct
 response to a mutation THIS phone just made (`create`, go-live, Encerrar)
 are both ALWAYS applied and always advance `generation`: each is strictly
 newer than anything this phone knew a moment ago, by construction (a frame
 the server just sent, or the server's own answer to a request this phone
 just made). A Farol finding on the first cut of `WatchPartyHostController`
 was exactly this: a successful mutation's response was reduced to a `Bool`
 and thrown away, so a missed `watch-party-update` (the socket briefly down,
 the frame lost) could leave the controller reporting stale state
 indefinitely even though the phone itself had just been told the truth.

 A background fetch (`WatchPartyHostController.fetchParty`'s retry loop) is
 different: it can be answered well after it was asked, so it only wins if
 `generation` has not moved since it started -- `beginFetch` hands out the
 version to prove that with, and `applyFetchResult` is the check. Another
 Farol finding: without this, a fetch that happened to be slow could
 overwrite a `watch-party-update` frame that arrived while it was in
 flight, undoing a party that had just gone live or just been created.

 `known` starts `false` and stays `false` until one of the three actually
 lands. Before that, `party == nil` must NOT read as "no active party" --
 the third Farol finding this type closes: a failed initial fetch used to
 be indistinguishable from a channel with nothing running, which offered a
 watch party's audience a Join button and hid Create from an eligible host.
 */
struct WatchPartyPartyTracker: Equatable, Sendable {
    private(set) var party: WatchPartyPayload?
    private(set) var known = false
    private(set) var generation = 0

    /// A `watch-party-update` frame, or the direct response to a mutation
    /// this phone just made. Always applied.
    mutating func applyAuthoritative(_ party: WatchPartyPayload?) {
        generation &+= 1
        self.party = party
        known = true
    }

    /// Claim the version a fetch about to start must hand back unchanged to
    /// `applyFetchResult`.
    mutating func beginFetch() -> Int {
        generation &+= 1
        return generation
    }

    /// A background fetch's result. Applied only if `requestedGeneration`
    /// (from `beginFetch`) still matches the current version -- i.e.
    /// nothing fresher landed while the fetch was in flight. Returns
    /// whether it was applied.
    @discardableResult
    mutating func applyFetchResult(_ party: WatchPartyPayload?, requestedGeneration: Int) -> Bool {
        guard requestedGeneration == generation else { return false }
        self.party = party
        known = true
        return true
    }

    /**
     Forget this channel's party because the CONTROLLER is now tracking a
     DIFFERENT channel -- never because this one's answer is merely stale.

     BUMPS `generation` RATHER THAN ZEROING IT. A second Farol finding: the
     first cut replaced the whole tracker with `WatchPartyPartyTracker()` on
     every channel switch, which restarts `generation` at 0 every time. Two
     visits to the same channel then hand out the SAME numbers (1, 2, 3...)
     to two different epochs, and a fetch from the first visit, delayed
     long enough to still be in flight when the phone comes back to that
     channel, can carry a `requestedGeneration` that coincidentally matches
     the second visit's -- `applyFetchResult`'s equality check cannot tell
     the two apart, and a stale answer overwrites a fresh one. `generation`
     bumping monotonically FOREVER, never restarting, is what makes every
     number this tracker ever hands out unique for the whole life of the
     app, so a fetch from a channel that is no longer even the one tracked
     can never be mistaken for current.
     */
    mutating func reset() {
        generation &+= 1
        party = nil
        known = false
    }

    /// This tracker's `party`/`known`, as `WatchPartyHostGate.swift`'s
    /// functions want it.
    var knowledge: WatchPartyKnowledge {
        known ? .known(party) : .unknown
    }
}

/**
 Capped exponential backoff for `WatchPartyHostController.fetchParty`'s
 retry loop, and a bound on how long it may run.

 FAROL FINDING THIS CLOSES. There is no explicit `close()` on
 `WatchPartyHostController` (by design -- see its own doc), so a fetch that
 keeps failing had nothing at all stopping it from retrying forever, even
 once nobody is looking at that channel any more. Six attempts (roughly a
 minute of backoff, 1s doubling to 30s) is long enough to ride out a
 transient blip -- the case this retry exists for -- without becoming an
 unbounded background job.
 */
struct WatchPartyFetchBackoff: Sendable {
    private(set) var delayMs = 1_000
    private var attempt = 0
    static let maxAttempts = 6

    /// The next delay to sleep before retrying, or `nil` once `maxAttempts`
    /// has been reached -- the caller's cue to give up.
    mutating func next() -> Duration? {
        attempt += 1
        guard attempt <= Self.maxAttempts else { return nil }
        let duration = Duration.milliseconds(delayMs)
        delayMs = min(delayMs * 2, 30_000)
        return duration
    }
}

/**
 Hosting a watch party from this phone: create, go live, end. And, ambiently,
 tracking the channel's current party so `WatchPartyHostView` has something
 to gate its buttons on before a host ever joins the room.

 APP-SCOPED (`@Environment`, injected once in `PqpApp.swift`), for the same
 reason `VoiceModel` is: a voice session owned by its screen ended the moment
 that screen was popped, and popping it is how you get back to the
 transcript. `VoiceView` is presented as a `fullScreenCover` from the app
 root, entirely separate from `ChatView`/`WatchStageView`'s own view
 hierarchy, and it is where this build's host controls actually live (see
 that file's doc) -- so the party this class tracks, and the busy/error state
 an in-flight action carries, both have to survive whichever of those two
 screens is on top at any given moment.

 A phone hosts at most one party at a time: one screen to capture, one voice
 seat to hold, one channel whose `watch-party-update` frames are worth
 tracking. So one `partyState`/`busy`/`error` triple is enough; there is no
 per-channel state to keep separate.
 */
@MainActor
@Observable
final class WatchPartyHostController {
    private(set) var busy: WatchPartyHostBusy = .none
    /// A sentence for the host about the LAST action that did not land
    /// clean: the server's own refusal, or one of `WatchPartyHostError`'s
    /// own strings when a state transition was asked for and the server
    /// never confirmed it. Never silently discarded in favour of a plain
    /// reset -- `run(_:_:)` below always writes SOME outcome.
    private(set) var error: String?

    /// The channel this is currently tracking, and what it knows about that
    /// channel's party -- see `WatchPartyPartyTracker`'s doc for the three
    /// ways `partyState` can change and why a fetch alone is not enough.
    private(set) var channelId: String?
    private(set) var partyState = WatchPartyPartyTracker()

    private var session: SessionStore?
    private var fetchTask: Task<Void, Never>?
    private let handlerKey = "watch-party-host-" + UUID().uuidString

    func dismissError() {
        error = nil
    }

    /// This channel's party, as far as this controller currently knows it --
    /// `.unknown` if this controller is tracking a DIFFERENT channel (see
    /// `open`'s doc): a stale answer from another channel must never be read
    /// as "no party here" for THIS channel, which is exactly the gap
    /// `WatchPartyHostGate`'s callers need closed.
    func partyKnowledge(for channelId: String) -> WatchPartyKnowledge {
        guard self.channelId == channelId else { return .unknown }
        return partyState.knowledge
    }

    /**
     Start (or keep) tracking `channelId`'s party.

     Idempotent for the same channel: called from both `ChatView` (so the
     toolbar's Join button can read the party before anybody has joined
     anything) and `VoiceView` (so a host who wandered off to another
     channel's chat mid-broadcast, then opened this call's cover again,
     re-pins tracking back to the channel they are actually live in -- see
     the class doc). Neither caller has to coordinate with the other; the
     later one wins, which is always the one currently on screen.

     No explicit `close()`. The single WS handler this class registers stays
     registered for the app's whole life and simply reads `self.channelId`
     at apply time, so leaving a screen costs nothing to clean up and a
     channel switch is just calling this again with a different id.
     */
    func open(channelId: String, session: SessionStore) {
        let changed = self.channelId != channelId
        self.channelId = channelId
        self.session = session
        if session.eventHandlers[handlerKey] == nil {
            session.eventHandlers[handlerKey] = { [weak self] event in
                self?.apply(event)
            }
        }
        guard changed else { return }
        // A previous channel's knowledge must not linger under a new
        // channel's id while the fresh read below is in flight. `reset()`,
        // not a fresh `WatchPartyPartyTracker()` -- see its doc for why
        // zeroing `generation` here was itself a Farol finding.
        partyState.reset()
        fetchParty(channelId: channelId, session: session)
    }

    private func apply(_ event: RealtimeEvent) {
        switch event {
        case .watchPartyUpdate(let eventChannelId, let party):
            guard channelId == eventChannelId else { return }
            fetchTask?.cancel()
            partyState.applyAuthoritative(party)
        case .ready:
            // A NEW SOCKET KNOWS NOTHING ABOUT THIS VIEWER, same reasoning
            // `WatchModel.apply`'s own `.ready` case documents: the catch-up
            // burst at auth is per-server, sent once, and a reconnect can
            // land after it, or the party can have changed while this
            // socket was down. Re-resolve authoritatively rather than trust
            // whatever is already known.
            if let channelId, let session {
                fetchParty(channelId: channelId, session: session)
            }
        default:
            break
        }
    }

    /**
     Resolve (or re-resolve) `channelId`'s party, retrying with backoff on
     failure.

     FAROL FINDING THIS CLOSES. The first cut of `open` fetched once: a
     failed lookup left the channel reading as "no party" until something
     else (a realtime frame) happened to correct it, silently hiding Create
     from an eligible host and offering an ordinary viewer a Join button on
     a party that might well be live. This retries with capped exponential
     backoff for as long as this remains the tracked channel, and `.ready`
     above calls it again on every reconnect for the same reason.

     Cancels any fetch already in flight (a previous channel's, or an
     earlier attempt for this one) before starting. Gives up after
     `WatchPartyFetchBackoff.maxAttempts` failures -- see that type's doc.
     */
    private func fetchParty(channelId: String, session: SessionStore) {
        fetchTask?.cancel()
        let requestedGeneration = partyState.beginFetch()
        fetchTask = Task { [weak self] in
            var backoff = WatchPartyFetchBackoff()
            while !Task.isCancelled {
                do {
                    let fetched = try await session.api.fetchChannelWatchParty(channelId: channelId)
                    guard let self, self.channelId == channelId else { return }
                    self.partyState.applyFetchResult(fetched, requestedGeneration: requestedGeneration)
                    return
                } catch {
                    if error is CancellationError { return }
                    guard let self, self.channelId == channelId,
                          self.partyState.generation == requestedGeneration,
                          let delay = backoff.next()
                    else { return }
                    try? await Task.sleep(for: delay)
                }
            }
        }
    }

    /// "Criar watch party". Always a name-only, immediate `draft` -- no
    /// scheduling in this build (see `APIClient.createWatchParty`'s doc).
    /// A successful response is applied directly (see `WatchPartyPartyTracker`'s
    /// doc): a missed `watch-party-update` must not leave the controller
    /// still offering Create after the party actually exists. `nil` here
    /// is not informative the way a GET's `nil` is -- it is the shape of a
    /// server error the write path never actually returns cleanly (any
    /// refusal throws instead) -- so it is left unapplied rather than wiping
    /// out whatever this phone already knew.
    func create(channelId: String, name: String, session: SessionStore) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        run(.creating) {
            let created = try await session.api.createWatchParty(channelId: channelId, name: trimmed)
            if let created, self.channelId == channelId { self.partyState.applyAuthoritative(created) }
        }
    }

    /// "Ir ao vivo". See `performWatchPartyGoLive` for the ordering and
    /// `joinVoiceAndGuardSettle` for why a timed-out join is left rather
    /// than abandoned in place.
    ///
    /// This is the moment media starts: nothing before it took a seat, and
    /// the seat it takes carries `microphone`
    /// (`watchPartyHostSeatMicrophone`), which for a party with voice off is
    /// no microphone at all.
    func goLive(
        channel: Channel,
        serverName: String?,
        partyId: String,
        lowLatency: Bool,
        microphone: SeatMicrophone,
        session: SessionStore,
        voice: VoiceModel,
        ratings: CallRatingModel?
    ) {
        run(.goingLive) {
            // What the room itself said when the join failed, if it said
            // anything (`VoiceModel.status`'s failure, in the stream's words
            // for a watch party). The seat is left on the way out, which
            // clears that status, so it is kept here for the sentence below.
            var joinFailure: String?
            let result = try await performWatchPartyGoLive(
                setLive: {
                    // `nil` here is a refused/unconfirmed transition, not a
                    // fact about the party's existence -- applying it would
                    // wipe out a party this phone already knows is real
                    // (still `draft`, just not live yet). Only a confirmed
                    // party is authoritative; leave the tracker alone
                    // otherwise (Farol finding).
                    let updated = try await session.api.setWatchPartyState(
                        partyId: partyId, state: "live", lowLatency: lowLatency
                    )
                    if let updated, self.channelId == channel.id { self.partyState.applyAuthoritative(updated) }
                    return updated != nil
                },
                checkLive: {
                    // Unlike the write above, a GET's `nil` genuinely means
                    // "no active party" and is safe to apply either way.
                    let fetched = try await session.api.fetchChannelWatchParty(channelId: channel.id)
                    if self.channelId == channel.id { self.partyState.applyAuthoritative(fetched) }
                    guard let fetched else { return false }
                    return fetched.id == partyId && fetched.isLive
                },
                joinVoice: {
                    try await joinVoiceAndGuardSettle(
                        join: {
                            voice.isCollapsed = false
                            // A failed session for this room would read as a
                            // reopen and never try again; see `VoiceModel.join`.
                            if case .failed = voice.status, voice.channelId == channel.id {
                                await voice.leave()
                            }
                            await voice.join(
                                channel: channel, session: session, ratings: ratings,
                                serverName: serverName, microphone: microphone
                            )
                        },
                        waitForSettle: {
                            do {
                                try await Self.waitForVoiceJoin(voice, channelId: channel.id)
                            } catch {
                                if case .failed(let message) = voice.status { joinFailure = message }
                                throw error
                            }
                        },
                        leaveOnFailure: { await voice.leave() }
                    )
                },
                endParty: {
                    let ended = try await session.api.setWatchPartyState(partyId: partyId, state: "ended")
                    if let ended, self.channelId == channel.id { self.partyState.applyAuthoritative(ended) }
                    return ended != nil
                }
            )
            switch result {
            case .live:
                return
            case .refused:
                throw WatchPartyHostError.message(
                    String(localized: "Could not go live. The server never confirmed it. Try again.")
                )
            case .joinFailed(let ended):
                let outcome = ended
                    ? String(
                        localized: "The broadcast could not start. The party was ended. Try again."
                    )
                    : String(
                        localized: "The broadcast could not start, and the party could not be ended either. It may still show as live. Try again in a moment."
                    )
                throw WatchPartyHostError.message(
                    [joinFailure, outcome].compactMap { $0 }.joined(separator: "\n\n")
                )
            }
        }
    }

    /// "Encerrar". See `performWatchPartyEnd` for the two effects and their
    /// order. Voice is left even when the server never confirmed the end
    /// (that guarantee lives in `performWatchPartyEnd` itself); what this
    /// wrapper adds is telling the host when that happened, rather than
    /// reporting a clean success either way.
    func end(channelId: String, partyId: String, session: SessionStore, voice: VoiceModel) {
        run(.ending) {
            let ended = try await performWatchPartyEnd(
                setEnded: {
                    // Same reasoning as `goLive`'s `setLive`/`endParty`: a
                    // `nil` here is an unconfirmed transition, not proof
                    // the party is gone, so only a confirmed answer is
                    // applied (Farol finding).
                    let updated = try await session.api.setWatchPartyState(partyId: partyId, state: "ended")
                    if let updated, self.channelId == channelId { self.partyState.applyAuthoritative(updated) }
                    return updated != nil
                },
                // Only this party's room. Encerrar from the stage runs with no
                // seat here, and the phone may be in an unrelated call that
                // ending a party has no business hanging up.
                leaveVoice: {
                    if voice.channelId == channelId { await voice.leave() }
                }
            )
            if !ended {
                throw WatchPartyHostError.message(
                    String(
                        localized: "Your broadcast stopped, but the server did not confirm the party ended. It may still show as live."
                    )
                )
            }
        }
    }

    /**
     Bounded wait for `VoiceModel.join` to settle, so `joinVoiceAndGuardSettle`
     has something throwing to call.

     `VoiceModel.join` returns once the join is ASKED for -- the WS
     `voice-join` frame is sent -- not once the server has answered it;
     `welcome` (success) and a refusal/timeout (failure) both land later,
     observed only through `VoiceModel.status` flipping to `.connected` or
     `.failed`. Nothing else in this codebase already waits for that on the
     caller's behalf (every existing "Join" affordance just shows `status`
     reactively wherever the call bar already is), so this polls it -- coarse
     on purpose, since it is a UI-level wait rather than a connection-level
     one like `startSfuSession`'s own internal timeout.
     */
    private static func waitForVoiceJoin(
        _ voice: VoiceModel, channelId: String, timeout: Duration = .seconds(15)
    ) async throws {
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while true {
            switch voice.status {
            case .connected where voice.channelId == channelId:
                return
            case .connected:
                // Connected, but to a DIFFERENT channel: something else
                // moved this session while the wait was in flight (a leave
                // and a rejoin elsewhere). Not the join this call asked for.
                throw WatchPartyHostError.message(
                    String(localized: "Something went wrong. Try again.")
                )
            case .failed(let message):
                throw WatchPartyHostError.message(message)
            case .idle:
                throw WatchPartyHostError.message(
                    String(localized: "Something went wrong. Try again.")
                )
            case .joining:
                break
            }
            if ContinuousClock.now >= deadline {
                throw WatchPartyHostError.message(
                    String(localized: "Something went wrong. Try again.")
                )
            }
            try await Task.sleep(for: .milliseconds(200))
        }
    }

    private func run(_ busy: WatchPartyHostBusy, _ block: @escaping () async throws -> Void) {
        Task { [weak self] in
            guard let self else { return }
            self.busy = busy
            self.error = nil
            do {
                try await block()
                self.busy = .none
            } catch is CancellationError {
                // Not a failure of the action -- the app is going away, or
                // something explicitly cancelled the wait. Reporting it as
                // one would show a host a refusal for a request that was
                // simply never finished asking.
                self.busy = .none
            } catch {
                self.busy = .none
                self.error = (error as? APIError)?.errorDescription
                    ?? (error as? WatchPartyHostError)?.errorDescription
                    ?? error.localizedDescription
            }
        }
    }
}
