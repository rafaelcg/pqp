import Foundation

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
 tracking. So one `party`/`busy`/`error` triple is enough; there is no
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

    /// The active party for `channelId`, kept current by
    /// `watch-party-update` frames and an explicit re-read on `open`. `nil`
    /// while no party is running, or before the first read has landed.
    private(set) var party: WatchPartyPayload?
    private(set) var channelId: String?

    private var session: SessionStore?
    private let handlerKey = "watch-party-host-" + UUID().uuidString

    func dismissError() {
        error = nil
    }

    /**
     Start (or keep) tracking `channelId`'s party.

     Idempotent for the same channel: called from both `ChatView` (so the
     toolbar's Join button can read `party` before anybody has joined
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
        // A previous channel's party must not linger under a new channel's
        // id while the fresh read below is in flight.
        party = nil
        Task { [weak self] in
            guard let fetched = try? await session.api.fetchChannelWatchParty(channelId: channelId)
            else { return }
            guard let self, self.channelId == channelId else { return }
            self.party = fetched
        }
    }

    private func apply(_ event: RealtimeEvent) {
        guard case .watchPartyUpdate(let eventChannelId, let party) = event,
              eventChannelId == channelId
        else { return }
        self.party = party
    }

    /// "Criar watch party". Always a name-only, immediate `draft` -- no
    /// scheduling in this build (see `APIClient.createWatchParty`'s doc).
    /// The created party reaches `party` via the `watch-party-update` this
    /// call itself provokes; nothing here applies an optimistic copy.
    func create(channelId: String, name: String, session: SessionStore) {
        let trimmed = name.trimmingCharacters(in: .whitespacesAndNewlines)
        run(.creating) {
            _ = try await session.api.createWatchParty(channelId: channelId, name: trimmed)
        }
    }

    /// "Ir ao vivo". See `performWatchPartyGoLive` for the ordering. `join`
    /// itself does not throw on a refused/timed-out join (see
    /// `waitForVoiceJoin`'s doc for why iOS needs this bridge at all, unlike
    /// Android where the equivalent call is already throwing).
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
                    try await session.api.setWatchPartyState(
                        partyId: partyId, state: "live", lowLatency: lowLatency
                    ) != nil
                },
                checkLive: {
                    guard let party = try await session.api.fetchChannelWatchParty(channelId: channel.id)
                    else { return false }
                    return party.id == partyId && party.isLive
                },
                joinVoice: {
                    await voice.join(channel: channel, session: session, ratings: ratings, serverName: serverName)
                    try await Self.waitForVoiceJoin(voice, channelId: channel.id)
                },
                endParty: {
                    try await session.api.setWatchPartyState(partyId: partyId, state: "ended") != nil
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
    func end(partyId: String, session: SessionStore, voice: VoiceModel) {
        run(.ending) {
            let ended = try await performWatchPartyEnd(
                setEnded: { try await session.api.setWatchPartyState(partyId: partyId, state: "ended") != nil },
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
     Bounded wait for `VoiceModel.join` to settle, so `performWatchPartyGoLive`'s
     `joinVoice` has something throwing to call.

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
