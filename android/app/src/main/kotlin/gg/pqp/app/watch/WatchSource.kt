package gg.pqp.app.watch

/**
 * When the player must throw its media item away and attach a new one.
 *
 * THIS IS THE ONE RULE THAT KEEPS A WATCH PARTY WATCHABLE, and getting it
 * wrong is invisible in a unit test and obvious to six hundred people at once.
 *
 * The URL the server hands out carries a `?t=` token minted per recipient, and
 * the audience keyframe restamps it every thirty seconds. So `hlsUrl` is a
 * DIFFERENT STRING every half minute for a stream that has not changed at all.
 * A player that re-attached on a URL change would tear its buffer down, refetch
 * the playlist and rebuffer twice a minute for the whole party, and the cause
 * would look like a bad connection rather than like this function.
 *
 * A session, on the other hand, really is a new stream: `startedAt` names the
 * egress, it is part of the object prefix and part of the proxy path, and a
 * presenter whose share died and came back has a new one. Nothing else is a new
 * source: not a token, not a rung, not a viewer count.
 *
 * The recovery path is deliberately NOT here. A stalled player asks for the
 * newest URL on purpose (see `WatchPane`), because a fresh token is exactly
 * what a stall wants; that is a decision to re-attach that has already been
 * made, not a question about whether the source changed.
 */
fun watchSourceChanged(current: LiveStream?, next: LiveStream?): Boolean =
    current?.startedAt != next?.startedAt

/**
 * What the pane is saying at this moment.
 *
 * Ordered by how much the person needs to be told, and derived rather than set,
 * so the pane cannot end up claiming two things at once.
 */
enum class WatchPhase {
    /** Nothing is live and nothing was: the pane is not drawn at all. */
    Idle,

    /** Live, attached, no frame yet. "Esperando a imagem chegar." */
    Opening,

    /** A picture. */
    Playing,

    /** It stalled and we are refetching. */
    Reconnecting,

    /** Retried enough. A button, not a spinner. */
    Dead,

    /** There was a stream, this person saw it, and it went away. */
    Ended,
}

/**
 * The phase, from the four facts that decide it.
 *
 * `ended` beats `dead` because a stream that the server says is over is not a
 * failure this phone can retry, and offering "Tentar de novo" for it would be
 * a button that cannot work. `dead` beats `reconnecting` for the obvious
 * reason. A pane with no stream that never had one says nothing rather than
 * apologising for a watch party that was never running, which is the state
 * every ordinary voice channel is in.
 */
fun watchPhaseOf(
    live: Boolean,
    everPlayed: Boolean,
    hasFrame: Boolean,
    dead: Boolean,
    reconnecting: Boolean,
): WatchPhase = when {
    !live && everPlayed -> WatchPhase.Ended
    !live -> WatchPhase.Idle
    dead -> WatchPhase.Dead
    reconnecting -> WatchPhase.Reconnecting
    hasFrame -> WatchPhase.Playing
    else -> WatchPhase.Opening
}
