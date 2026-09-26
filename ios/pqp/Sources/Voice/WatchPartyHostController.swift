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

    /// This tracker's `party`/`known`, as `WatchPartyHostGate.swift`'s
    /// functions want it.
    var knowledge: WatchPartyKnowledge {
        known ? .known(party) : .unknown
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
        // channel's id while the fresh read below is in flight.
        partyState = WatchPartyPartyTracker()
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
     earlier attempt for this one) before starting.
     */
    private func fetchParty(channelId: String, session: SessionStore) {
        fetchTask?.cancel()
        let requestedGeneration = partyState.beginFetch()
        fetchTask = Task { [weak self] in
            var delayMs = 1_000
            while !Task.isCancelled {
                do {
                    let fetched = try await session.api.fetchChannelWatchParty(channelId: channelId)
                    guard let self, self.channelId == channelId else { return }
                    self.partyState.applyFetchResult(fetched, requestedGeneration: requestedGeneration)
                    return
                } catch {
                    if error is CancellationError { return }
                    guard let self, self.channelId == channelId,
                          self.partyState.generation == requestedGeneration
                    else { return }
                    try? await Task.sleep(for: .milliseconds(delayMs))
                    delayMs = min(delayMs * 2, 30_000)
                }
            }
        }
    }

    /// "Criar watch party". Always a name-only, immediate `draft` -- no
    /// scheduling in this build (see `APIClient.createWatchParty`'s doc).
    /// The response is applied directly (see `WatchPartyPartyTracker`'s
    /// doc): a missed `watch-party-update` must not leave the controller
    /// still offering Create after the party actually exists.
    func create(channelId: String, name: String, session: SessionStore) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        run(.creating) {
            let created = try await session.api.createWatchParty(channelId: channelId, name: trimmed)
            if self.channelId == channelId { self.partyState.applyAuthoritative(created) }
        }
    }

    /// "Ir ao vivo". See `performWatchPartyGoLive` for the ordering and
    /// `joinVoiceAndGuardSettle` for why a timed-out join is left rather
    /// than abandoned in place.
    func goLive(
        channel: Channel,
        serverName: String?,
        partyId: String,
        lowLatency: Bool,
        session: SessionStore,
        voice: VoiceModel,
        ratings: CallRatingModel?
    ) {
        run(.goingLive) {
            let result = try await performWatchPartyGoLive(
                setLive: {
                    let updated = try await session.api.setWatchPartyState(
                        partyId: partyId, state: "live", lowLatency: lowLatency
                    )
                    if self.channelId == channel.id { self.partyState.applyAuthoritative(updated) }
                    return updated != nil
                },
                checkLive: {
                    let fetched = try await session.api.fetchChannelWatchParty(channelId: channel.id)
                    if self.channelId == channel.id { self.partyState.applyAuthoritative(fetched) }
                    guard let fetched else { return false }
                    return fetched.id == partyId && fetched.isLive
                },
                joinVoice: {
                    try await joinVoiceAndGuardSettle(
                        join: { await voice.join(channel: channel, session: session, ratings: ratings, serverName: serverName) },
                        waitForSettle: { try await Self.waitForVoiceJoin(voice, channelId: channel.id) },
                        leaveOnFailure: { await voice.leave() }
                    )
                },
                endParty: {
                    let ended = try await session.api.setWatchPartyState(partyId: partyId, state: "ended")
                    if self.channelId == channel.id { self.partyState.applyAuthoritative(ended) }
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
                throw WatchPartyHostError.message(
                    ended
                        ? String(
                            localized: "The broadcast could not start. The party was ended. Try again."
                        )
                        : String(
                            localized: "The broadcast could not start, and the party could not be ended either. It may still show as live. Try again in a moment."
                        )
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
                    let updated = try await session.api.setWatchPartyState(partyId: partyId, state: "ended")
                    if self.channelId == channelId { self.partyState.applyAuthoritative(updated) }
                    return updated != nil
                },
                leaveVoice: { await voice.leave() }
            )
            if !ended {
                throw WatchPartyHostError.message(
                    String(
                        localized: "You left the call, but the server did not confirm the party ended. It may still show as live."
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
