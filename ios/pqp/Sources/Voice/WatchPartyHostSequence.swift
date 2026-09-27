import Foundation

/**
 The effects "Ir ao vivo" and "Encerrar" perform, and the order they run in
 -- pulled out into free functions over closures so the ordering is a
 unit-testable fact rather than something only readable from a controller's
 body, matching `performWatchPartyGoLive`/`performWatchPartyEnd` in Android's
 hosting PR (#834, `WatchPartyHostSequence.kt`), which carries the two Farol
 findings this port closes: an ambiguous `setLive` throw must be re-checked
 rather than assumed refused, and a `joinVoice` failure on a confirmed-live
 party must be reported rather than swallowed into success. A later Android
 round (merged to `main` as part of #834) added a third: `performWatchPartyEnd`
 leaves voice in a `finally` even when cancelled mid-request. All three are
 ported below.

 NO `startScreenShare`/`consent` PARAMETER, unlike the Android original.
 Nothing in this sequence starts the capture on iOS: `VoiceModel.join` already
 arms `ScreenShareController` as part of joining the room
 (`screenShare.arm()` in `VoiceModel.swift`), and the capture itself only
 starts once the host taps `RPSystemBroadcastPickerView`, the system's own
 button -- Apple requires that be a real user touch on Apple's own control,
 so there is no function this sequence could call to start it. Per the
 hosting review's decision log (Rafael, 2026-09-25): no preview on iOS, a
 status badge once frames arrive. `joinVoice` succeeding is therefore this
 function's whole job; the picker is the caller's UI, offered once this
 returns `.live` (see `WatchPartyHostView.swift`).
 */
enum GoLiveResult: Equatable {
    /// The party is live and the room was joined. The picker is the caller's
    /// next step, not this function's.
    case live
    /// `setLive` (or the re-check after an ambiguous failure) confirmed the
    /// party never went live.
    case refused
    /**
     The party WAS live -- `setLive` succeeded, or an ambiguous failure was
     confirmed live by `checkLive` -- but `joinVoice` itself then failed.
     `ended` says whether the best-effort attempt to end the party again
     actually landed: `false` means the party may still be live on the
     server with nobody in the room and nothing broadcasting, which is the
     one outcome a host must be told about honestly rather than reassured
     out of. There is no transition back to `draft`/`scheduled`
     (`live -> ended` is the only move `TRANSITIONS` allows from `live`), and
     the server's own host-gone sweep only starts its grace window on a
     socket DISCONNECT -- a host who never joined in the first place never
     trips it, so an unconfirmed end here is not a transient inconvenience,
     it is a party that can stay listed as live indefinitely.
     */
    case joinFailed(ended: Bool)
}

/**
 Runs `block`, letting `CancellationError` propagate (structured concurrency
 must not read "this task was cancelled" as "this action failed") while
 turning every other failure into `false` -- the safe direction for both
 `checkLive` (proceeding to join a room this phone cannot confirm is live is
 worse than a false refusal) and the best-effort `endParty` compensation.
 */
@MainActor private func attemptOrFalse(_ block: () async throws -> Bool) async throws -> Bool {
    do {
        return try await block()
    } catch {
        if error is CancellationError { throw error }
        return false
    }
}

/**
 Joins voice, then waits for the join to actually settle, and -- if that
 wait fails for ANY reason, including a timeout or a cancellation -- leaves
 (or cancels) the join before the failure propagates.

 THE FAROL FINDING THIS CLOSES. `performWatchPartyGoLive`'s `joinVoice`
 param used to be just `{ await voice.join(...); try await waitForVoiceJoin(...) }`.
 If the wait timed out, the sequence read that as `joinFailed` and ended the
 party -- but nothing had told `VoiceModel` to give up on the join it had
 just asked for. A `welcome` that arrives late, after this function already
 gave up, would then seat the phone in a room for a party that has already
 been told it ended: an unintended seat, and call state that disagrees with
 the party's own row. `leaveOnFailure` is the fix -- `VoiceModel.leave()`
 both sends `voice-leave` (so the server hears "never mind" even if
 `welcome` was already in flight) and drops this session's own WS handler,
 so a `welcome` that slips through anyway is not acted on locally either.

 Pulled out as its own pure function, over closures, for the same reason
 `performWatchPartyGoLive` is: the guarantee is a fact about ordering that a
 test can pin without a real `VoiceModel`.
 */
@MainActor func joinVoiceAndGuardSettle(
    join: () async -> Void,
    waitForSettle: () async throws -> Void,
    leaveOnFailure: () async -> Void
) async throws {
    await join()
    do {
        try await waitForSettle()
    } catch {
        await leaveOnFailure()
        throw error
    }
}

/**
 Ir ao vivo, in the order the hosting review calls out explicitly: state
 first. `POST /api/watch-parties/:id/state {state:"live"}`, THEN
 `join-voice-room`.
 */
@MainActor func performWatchPartyGoLive(
    setLive: () async throws -> Bool,
    /**
     Consulted ONLY when `setLive` throws. Re-reads whether the party is
     actually live right now; its own failure (throwing, or answering
     `false`) is read as "not confirmed live", the safe direction, since
     proceeding to join a room for a party this phone cannot confirm is live
     risks a seat with nothing to show for it.
     */
    checkLive: () async throws -> Bool,
    joinVoice: () async throws -> Void,
    /// Best-effort only; its own failure is folded into `.joinFailed`'s `ended`.
    endParty: () async throws -> Bool
) async throws -> GoLiveResult {
    let live: Bool
    do {
        live = try await setLive()
    } catch {
        if error is CancellationError { throw error }
        live = try await attemptOrFalse(checkLive)
    }
    guard live else { return .refused }

    do {
        try await joinVoice()
    } catch {
        if error is CancellationError { throw error }
        let ended = try await attemptOrFalse(endParty)
        return .joinFailed(ended: ended)
    }
    return .live
}

/**
 Encerrar: end the party's own row first, then leave voice, ALWAYS -- even
 when `setEnded` throws, including a cancellation, and even when it answers
 cleanly but without confirming (a `false`, the same "not confirmed" shape
 `setLive` already has to handle). The person pressed Encerrar and the phone
 must stop broadcasting regardless of whether the server managed to record
 that the party ended.

 Returns whether the server actually confirmed the end, so the caller can
 tell the host "you're no longer broadcasting, but the party may still be
 listed as live" rather than quietly reporting success either way.

 No `defer` here: `leaveVoice` is `async` (`VoiceModel.leave()`), and a
 `defer` block cannot `await`. The three exits below -- success, an ordinary
 failure, a cancellation -- each call `leaveVoice` explicitly instead, which
 is the same guarantee Android's `finally` gives `performWatchPartyEnd`.
 */
@MainActor func performWatchPartyEnd(
    setEnded: () async throws -> Bool,
    leaveVoice: () async -> Void
) async throws -> Bool {
    do {
        let ended = try await attemptOrFalse(setEnded)
        await leaveVoice()
        return ended
    } catch {
        // Only a CancellationError reaches here: `attemptOrFalse` already
        // turned every other failure into a clean `false` above.
        await leaveVoice()
        throw error
    }
}

// MARK: - The streaming-responsibility ack

/**
 Whether the once-per-host-per-server "you're responsible for what you
 stream" disclosure still needs to be shown, FAILING CLOSED: a lookup that
 throws (network, decode, anything but cancellation) shows the notice rather
 than skipping it.

 DELIBERATELY DIVERGES FROM THE WEB. `useHlsHostAck.checkNeedsAck`
 (`client/src/hooks/use-hls-host-ack.ts`) fails OPEN on the same question,
 "so a sheet that could not be checked" never blocks a host from streaming.
 Android's hosting PR (#834) found and fixed exactly that shape failing open
 on its own first cut, closed by a Farol review before merge; this port
 starts from the corrected version rather than reproducing the bug once
 more on a second platform.
 */
@MainActor func hostAckNeedsShowing(checkNeedsAck: () async throws -> Bool) async throws -> Bool {
    do {
        return try await checkNeedsAck()
    } catch {
        if error is CancellationError { throw error }
        return true
    }
}

/**
 Whether the ack was actually persisted. FAILS CLOSED: a `confirmAck` that
 throws must not be read as "consent recorded", or the capture would start
 having shown the notice but never saved that it was confirmed -- the exact
 shape Android's second Farol finding on this flow caught (a `runCatching`
 that swallowed the throw and fell through to starting the capture anyway).
 */
@MainActor func hostAckConfirmed(confirmAck: () async throws -> Void) async throws -> Bool {
    do {
        try await confirmAck()
        return true
    } catch {
        if error is CancellationError { throw error }
        return false
    }
}
