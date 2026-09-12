package gg.pqp.app.watch

/** What [HlsWatchdog.tick] decided. */
enum class WatchdogDecision { None, Reconnect, Dead }

/** Why it decided it, for the log line and for the tests. */
enum class WatchdogReason { Fatal, Ended, Stall, SequenceStuck }

/**
 * The stall policy for the watch player, as a pure object.
 *
 * A port of the web client's `client/src/lib/hls-stall.ts`, sharing its
 * shape and most of its numbers because a phone and a laptop watching the
 * same egress should give up at close to the same moment. `stallMs` is the
 * one deliberate exception, held higher here than on web (12_000 vs. 8_000)
 * because this player runs a deeper `DefaultLoadControl` with a real 8 s
 * legitimate post-stall refill window that web's hls.js buffering model does
 * not have an equivalent fixed number for; see `stallMs`'s own doc below.
 * Everything here is events and a clock in, a decision out, so the whole
 * policy is exercised in `HlsWatchdogTest` without an ExoPlayer, a network
 * or a device.
 *
 * What it watches, and why each one is here rather than left to the player:
 *
 * - **A fatal `PlaybackException`.** Media3 retries a load a few times on its
 *   own and then stops for good. Its retry cannot help with the failure that
 *   actually happens at an event, which is that the *session* changed: the
 *   presenter's share died and came back, so there is a new `startedAt`, a new
 *   object prefix and a new URL. Only refetching the URL fixes that, and only
 *   this side knows to.
 * - **`STATE_ENDED`.** LiveKit writes `#EXT-X-ENDLIST` when the egress stops,
 *   and a reused `live.m3u8` stays that finished VOD until the next share
 *   overwrites it. A player handed one plays to the end and sits on a black
 *   frame, which is the exact symptom the web hit on 2026-09-07: frozen
 *   picture, no copy, no recovery.
 * - **Buffering for longer than [stallMs]** with nothing playing.
 * - **The media sequence not advancing** for [sequenceStuckMs], which is what a
 *   dead egress looks like while the playlist itself still answers 200.
 *
 * After [maxReconnects] inside [windowMs] the stream is called dead and the
 * person gets a button instead of a spinner, because a phone retrying a stream
 * that is not coming back is somebody's data plan.
 *
 * [stallMs]'s default has a hard downstream coupling: `ui/WatchPane.kt`
 * builds its `ExoPlayer` with a `DefaultLoadControl` whose
 * `bufferForPlaybackAfterRebufferMs` is 8_000 — after any stall, Media3
 * itself will legitimately sit in `STATE_BUFFERING` for up to that long,
 * still downloading, before resuming on purpose. [onBuffering] cannot tell
 * that deliberate refill apart from a dead source by state alone (both are
 * "buffering, position frozen"); the only signal this watchdog has that
 * distinguishes them is time. So [stallMs] must clear
 * `bufferForPlaybackAfterRebufferMs` with real margin, or the two race: a
 * `stallMs` at or near 8_000 can call a healthy refill dead in the same
 * instant it was about to resume, tearing down a player that was never
 * actually stuck. 12_000 leaves 4 s of headroom over that refill and still
 * sits under [sequenceStuckMs]'s 15_000. If either number changes, the other
 * has to be re-read against it.
 */
class HlsWatchdog(
    private val stallMs: Long = 12_000,
    private val sequenceStuckMs: Long = 15_000,
    private val maxReconnects: Int = 3,
    private val windowMs: Long = 5 * 60_000,
) {
    private var bufferingSince: Long? = null
    private var lastSequence: Long? = null
    private var sequenceSeenAt: Long? = null
    private val reconnects = ArrayDeque<Long>()
    private var pendingFatal = false
    private var pendingEnded = false

    /** Why the last [tick] asked for something. Null until it does. */
    var lastReason: WatchdogReason? = null
        private set

    /** The player is rendering again: every stall clock resets. */
    fun onPlaying() {
        bufferingSince = null
    }

    fun onBuffering(now: Long) {
        if (bufferingSince == null) bufferingSince = now
    }

    /** `Player.STATE_ENDED`: the playlist carried `#EXT-X-ENDLIST`. */
    fun onEnded() {
        pendingEnded = true
    }

    /** A `PlaybackException`. Media3 has already given up by the time this fires. */
    fun onError() {
        pendingFatal = true
    }

    /** The `HlsManifest`'s media sequence, read off the player on each tick. */
    fun onMediaSequence(sequence: Long, now: Long) {
        if (sequence != lastSequence) {
            lastSequence = sequence
            sequenceSeenAt = now
        }
    }

    /** A new source was attached: forget the old playlist's timeline. */
    fun onSourceChanged(now: Long) {
        bufferingSince = null
        lastSequence = null
        sequenceSeenAt = now
        pendingFatal = false
        pendingEnded = false
    }

    /** The person pressed "Tentar de novo": a clean slate. */
    fun reset(now: Long) {
        reconnects.clear()
        onSourceChanged(now)
    }

    fun tick(now: Long): WatchdogDecision {
        val reason = when {
            pendingFatal -> WatchdogReason.Fatal
            pendingEnded -> WatchdogReason.Ended
            bufferingSince?.let { now - it >= stallMs } == true -> WatchdogReason.Stall
            sequenceSeenAt != null &&
                lastSequence != null &&
                now - sequenceSeenAt!! >= sequenceStuckMs -> WatchdogReason.SequenceStuck
            else -> null
        } ?: return WatchdogDecision.None

        lastReason = reason
        while (reconnects.isNotEmpty() && now - reconnects.first() >= windowMs) {
            reconnects.removeFirst()
        }
        if (reconnects.size >= maxReconnects) return WatchdogDecision.Dead
        reconnects.addLast(now)
        // The new attempt starts its own clocks. A reconnect that itself
        // stalls is judged from its attach, not from the original stall.
        onSourceChanged(now)
        return WatchdogDecision.Reconnect
    }
}
