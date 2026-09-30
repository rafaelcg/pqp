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
 * The same rule as [watchSourceChanged], for the camera's own PiP player.
 *
 * The camera rides the SAME session as the film — it never mints its own
 * `startedAt` — so [watchSourceChanged] cannot be reused here: it would never
 * fire for a camera that started, stopped and started again inside one watch,
 * and it WOULD fire every thirty seconds for nothing, since a camera URL is
 * restamped by the same audience keyframe that restamps the film's.
 *
 * [cameraPathKey] is the URL with its query string stripped, so a token
 * restamp (`?t=…` changing) is invisible here and only a genuinely different
 * playlist path — the camera egress actually restarting under a new run, or
 * the whole session moving to a new one — reattaches the PiP.
 */
fun watchCameraSourceChanged(current: String?, next: String?): Boolean =
    cameraPathKey(current) != cameraPathKey(next)

/** [String.substringBefore], defensively: a URL this cannot parse keys on itself. */
fun cameraPathKey(url: String?): String? {
    url ?: return null
    return runCatching { java.net.URI(url) }
        .getOrNull()
        ?.let { "${it.scheme}://${it.authority}${it.path}" }
        ?: url.substringBefore('?')
}

/**
 * The `?t=` viewer token, pulled back out of [LiveStream.hlsUrl].
 *
 * The same capability that authorises the playlist fetch is what
 * `POST /api/live-hls/presence` wants back (`WatchPane`'s presence beat,
 * mirroring `client/src/lib/hls-playback.ts`'s `sendHlsPresence`), so this is
 * the query string read the other direction. Works on either shape `hlsUrl`
 * comes in as (API-relative or an absolute bucket URL): both are a query
 * string, and [java.net.URI] does not care which. `null` on anything that
 * does not parse or carries no `t`, rather than throwing — a beat this
 * cannot address is simply skipped.
 */
fun hlsSessionToken(hlsUrl: String): String? {
    val query = runCatching { java.net.URI(hlsUrl).query }.getOrNull() ?: return null
    for (pair in query.split("&")) {
        val eq = pair.indexOf('=')
        if (eq < 0) continue
        if (pair.substring(0, eq) == "t") return pair.substring(eq + 1)
    }
    return null
}

/**
 * What the watchdog's reconnect path should attach to, given a refetch that
 * just finished.
 *
 * `refreshNow()` (`GET /api/channels/:id/live`) can come back three ways, and
 * only one of them means "nothing new": a stream whose `startedAt` differs
 * (the presenter's share died and came back, a genuinely new session); a
 * stream with the SAME `startedAt` (the ordinary case, a token expiring
 * mid-film); or null, because the request threw or the channel has nothing
 * live right now. The first two both hand back fresher information than
 * whatever is already attached — a fresh same-session result still carries a
 * token that has not just failed, which is exactly what a reconnect needs.
 * Discarding it because only the first case *looked* like a change is the bug
 * this function exists to prevent: it reproduces the "hammering with the same
 * expired token" symptom, because the caller falls back to whatever the
 * socket last delivered, which can be the very token that just 401'd.
 *
 * Only the null case has nothing to offer, so the caller keeps what it
 * already had and leans on the attempt counter to retry with that.
 */
fun reconnectAttachment(fresh: LiveStream?, attached: LiveStream?): LiveStream? =
    fresh ?: attached

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

/**
 * The viewer token's life, and when to get a new one.
 *
 * `HLS_VIEWER_TOKEN_TTL_MS` is an hour and a film is longer, which is the
 * whole problem: the token stamped into the URL this player attached is a
 * capability with a clock on it, and the player refetches that same URL for
 * the entire watch. Left alone it expires mid-film, the proxy answers 401, and
 * the recovery is a fatal error plus a reconnect. That recovery does work, and
 * it is not good enough: it is an uncontrolled failure in the middle of a
 * party, and everything before it looked fine.
 *
 * So the swap is scheduled instead. Ten minutes of margin, and it costs
 * nothing: the URL the audience keyframe has been restamping every thirty
 * seconds is already in the store, so the renewal is one re-attach and no
 * round trip. iOS renews at the same moment for the same reason
 * (`WatchStreamSwap`, see docs/WATCH_PARTY.md), and the two were written
 * without either side reading the other, which is a reason to write the rule
 * down rather than leave it as a bare constant.
 *
 * The margin has to stay wide enough to survive a socket that was down for a
 * while, because the store only holds a fresh token if a `channel-live`
 * actually arrived: a client offline for the last few minutes renews with
 * whatever it last heard, and that has to still be valid.
 */
const val HLS_VIEWER_TOKEN_TTL_MS: Long = 60 * 60 * 1000

const val WATCH_TOKEN_RENEWAL_MS: Long = 50 * 60 * 1000
