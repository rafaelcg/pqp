package gg.pqp.app.watch

import kotlinx.coroutines.CancellationException

/**
 * The effects "Ir ao vivo" and "Encerrar" perform, and the order they run in
 * -- pulled out of [WatchPartyHostController] as free functions over lambdas
 * so the ordering is a JVM-testable fact rather than something only readable
 * from the controller's body.
 *
 * Generic over the consent payload [C] purely so a test can pass a plain
 * string stand-in instead of a real `android.content.Intent`, which this
 * module (a JVM unit test, no Android framework jar) cannot construct.
 */

/**
 * What [performWatchPartyGoLive] actually happened, because a plain Boolean
 * cannot tell a host apart three different things that all "did not share a
 * picture": the party never went live at all, or it did, this phone joined
 * and simply chose not to (never happens today, but the shape allows it), or
 * -- the case this type exists for -- the party went live and THEN joining
 * the room itself failed, which leaves a party on the server with nobody in
 * it and nothing broadcasting unless something ends it again.
 */
sealed interface GoLiveResult {
    /** The party is live, the room was joined, and the capture was asked for. */
    data object Live : GoLiveResult

    /** [setLive] (or the re-check after an ambiguous failure) confirmed the party never went live. */
    data object Refused : GoLiveResult

    /**
     * The party WAS live -- [performWatchPartyGoLive]'s [C]-typed `setLive`
     * succeeded, or an ambiguous failure was confirmed live by `checkLive`
     * -- but [joinVoice] itself then failed. [ended] says whether the
     * best-effort attempt to end the party again actually landed: `false`
     * means the party may still be live on the server with nobody in the
     * room and nothing broadcasting, which is the one outcome a host must
     * be told about honestly rather than reassured out of. There is no
     * transition back to `draft`/`scheduled` (`TRANSITIONS` in
     * `watch-party-session.ts` only ever allows `live -> ended`), and the
     * server's own host-gone sweep only starts its 5-minute grace on a
     * socket DISCONNECT -- a host who never joined in the first place never
     * trips it, so an unconfirmed end here is not a transient inconvenience,
     * it is a party that can stay listed as live indefinitely.
     */
    data class JoinFailed(val ended: Boolean) : GoLiveResult
}

/**
 * Run a suspend block, letting [CancellationException] propagate (structured
 * concurrency must not be broken by treating "this coroutine was cancelled"
 * as "this action failed") while turning every other throw into a [Result].
 */
private suspend fun <T> attempt(block: suspend () -> T): Result<T> = try {
    Result.success(block())
} catch (e: CancellationException) {
    throw e
} catch (e: Throwable) {
    Result.failure(e)
}

/**
 * Ir ao vivo, in order: [muteMicrophone] FIRST, then the hosting review's
 * "state first" -- `POST /api/watch-parties/:id/state {state:"live"}` --
 * THEN `join-voice-room`, THEN the screen capture/publish.
 *
 * [muteMicrophone] RUNS BEFORE ANYTHING ELSE, whatever this phone's standing
 * mute preference is, and NOTHING BELOW IT RUNS IF IT FAILS. A watch party is
 * a broadcast: "Ir ao vivo" is the audience arriving, not a request to speak,
 * and a host who was unmuted on a call five minutes ago must not have that
 * carry into a stage five hundred people can now hear. This is the same
 * reason the web's `handleWatchPartyGoLive` forces `startMuted: true`
 * unconditionally rather than reading a mute-on-join preference -- "Ir ao
 * vivo should not blast the host's mic into the party, whatever mute-on-join
 * is set to". Going first, ahead of [setLive], is deliberate and was a Farol
 * finding on an earlier cut of this reordering that put it after [joinVoice]
 * instead: for a host who joined ahead of time to talk to a co-host and is
 * already seated with an open mic, [joinVoice] is a no-op re-entry, and a
 * mute placed after [setLive] leaves a real window -- however short -- where
 * the party is live on the server with that mic still open. Muting first
 * closes the window to zero: the party cannot become live before its host's
 * own mic is already silent, fresh join or one already in progress alike.
 * And because it runs first, a [muteMicrophone] failure means [setLive] is
 * never called at all -- there is no "already live" case to compensate for
 * here, unlike [joinVoice] failing below, which can only happen once the
 * party truly is live.
 *
 * THREE FAROL FINDINGS ON EARLIER CUTS OF THIS FUNCTION, all about what a
 * plain `if (!setLive()) return false` glossed over:
 *
 * 1. [setLive] THROWING is ambiguous, not a refusal. A lost response or a
 *    timeout can arrive after the server already committed the transition,
 *    and reporting that as "did not go live" while the party is in fact
 *    live strands it exactly the way [GoLiveResult.JoinFailed] describes,
 *    just without even a room to recover from. So a throw is not read as a
 *    refusal directly: [checkLive] re-reads the party's actual state, and
 *    only a CONFIRMED non-live answer is [GoLiveResult.Refused]. [setLive]
 *    returning `false` cleanly (no throw) is unambiguous and skips the
 *    re-check.
 * 2. [joinVoice] failing after a confirmed-live party used to still be
 *    reported as an unqualified success (nothing here caught it at all). A
 *    live party this phone never actually entered is worse than a refused
 *    go-live: see [GoLiveResult.JoinFailed]'s doc for why it does not fix
 *    itself. [endParty] is the best-effort compensation.
 * 3. [muteMicrophone] running AFTER [setLive] (an earlier cut of this
 *    function) left the window described above. See its own doc for why it
 *    now runs first instead.
 *
 * What is UNCHANGED, deliberately: [startScreenShare] failing (denied
 * consent, a refused publish -- both asynchronous on the real client, never
 * observed here) still leaves the party live with the room joined and no
 * picture. That is the one failure mode this function still lets stand,
 * because it is recoverable from the live card itself (`WatchPartyHostPanel`'s
 * "Compartilhar tela" retry) rather than from a party that was never entered.
 */
suspend fun <C> performWatchPartyGoLive(
    /**
     * Forces this phone's own mic silent in the room, called before anything
     * else in this function -- see the function's own doc for why. A throw
     * here (cancellation aside, which propagates as always) means [setLive]
     * is never even attempted: nothing else runs, and [GoLiveResult.Refused]
     * is returned. This is the fallible step this function trusts least, so
     * it is the one nothing else may follow when it does not land.
     */
    muteMicrophone: suspend () -> Unit,
    setLive: suspend () -> Boolean,
    /**
     * Consulted ONLY when [setLive] throws. Re-reads whether the party is
     * actually live right now; its own failure (throwing, or answering
     * false) is read as "not confirmed live", i.e. [GoLiveResult.Refused] --
     * the safe direction, since proceeding to join a room for a party this
     * phone cannot confirm is live risks a seat with nothing to show for it.
     */
    checkLive: suspend () -> Boolean,
    joinVoice: () -> Unit,
    /** Best-effort only; its own failure is folded into [GoLiveResult.JoinFailed]'s `ended`. */
    endParty: suspend () -> Boolean,
    startScreenShare: (C) -> Unit,
    consent: C,
): GoLiveResult {
    val muted = attempt { muteMicrophone() }
    if (muted.isFailure) return GoLiveResult.Refused

    val live = attempt { setLive() }.fold(
        onSuccess = { it },
        onFailure = { attempt { checkLive() }.getOrDefault(false) },
    )
    if (!live) return GoLiveResult.Refused

    val joined = runCatching { joinVoice() }
    if (joined.isFailure) {
        val ended = attempt { endParty() }.getOrDefault(false)
        return GoLiveResult.JoinFailed(ended = ended)
    }

    startScreenShare(consent)
    return GoLiveResult.Live
}

/**
 * Encerrar, in order: end the party's own row first, then leave voice.
 * There is no separate "stop the capture" effect -- `VoiceController.leave()`'s
 * teardown (`engine.stop()`) already tears down any local screen publish, so
 * a third step here would be stopping something [leaveVoice] already stops.
 *
 * [setEnded] failing does not stop [leaveVoice] from running: the person
 * pressed Encerrar and the phone should stop broadcasting regardless of
 * whether the server managed to record that the party ended. It is also not
 * swallowed into silence: the return value says whether the server actually
 * confirmed the end, so the caller can tell the host "you're no longer
 * broadcasting, but the party may still be listed as live" rather than
 * quietly reporting success either way (a Farol finding on the first cut of
 * this function, which did discard it).
 *
 * [setEnded] RETURNS `Boolean`, deliberately, matching [performWatchPartyGoLive]'s
 * `setLive`. The first cut had this typed `suspend () -> Unit`, which
 * silently coerced away the caller's own nullable "did the server actually
 * confirm this" answer -- a call that returned cleanly but with a null party
 * (the server's way of saying "not confirmed" without throwing) read as
 * success purely because nothing threw. A second Farol finding, on the
 * commit that fixed the first: the [Unit] type itself was the bug, not just
 * the body.
 */
suspend fun performWatchPartyEnd(setEnded: suspend () -> Boolean, leaveVoice: () -> Unit): Boolean {
    // `finally`, not a plain call after: a cancellation while [setEnded] is in
    // flight rethrows out of [attempt], and the phone must still stop
    // broadcasting because the host pressed Encerrar (a Farol finding).
    try {
        return attempt { setEnded() }.getOrDefault(false)
    } finally {
        leaveVoice()
    }
}
