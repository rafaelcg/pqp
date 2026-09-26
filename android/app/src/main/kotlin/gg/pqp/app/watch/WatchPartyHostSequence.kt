package gg.pqp.app.watch

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
 * Ir ao vivo, in the order the hosting review calls out explicitly: state
 * first. `POST /api/watch-parties/:id/state {state:"live"}`, THEN
 * `join-voice-room`, THEN the screen capture/publish. A failed [setLive]
 * stops here and joins nothing -- the room is never entered for a party that
 * never went live. A [setLive] that succeeds but a capture that then fails
 * (denied consent, a refused publish) still leaves the party genuinely live
 * with the host seated and no picture, which is the intended failure mode:
 * "live, no picture" is recoverable from the setup the host is already
 * looking at, rather than a broadcast the server was never told about.
 */
suspend fun <C> performWatchPartyGoLive(
    setLive: suspend () -> Boolean,
    joinVoice: () -> Unit,
    startScreenShare: (C) -> Unit,
    consent: C,
): Boolean {
    if (!setLive()) return false
    joinVoice()
    startScreenShare(consent)
    return true
}

/**
 * Encerrar, in order: end the party's own row first, then leave voice.
 * There is no separate "stop the capture" effect -- `VoiceController.leave()`'s
 * teardown (`engine.stop()`) already tears down any local screen publish, so
 * a third step here would be stopping something [leaveVoice] already stops.
 *
 * [setEnded] failing does not stop [leaveVoice] from running: the person
 * pressed Encerrar and the phone should stop broadcasting regardless of
 * whether the server managed to record that the party ended.
 */
suspend fun performWatchPartyEnd(setEnded: suspend () -> Unit, leaveVoice: () -> Unit) {
    runCatching { setEnded() }
    leaveVoice()
}
