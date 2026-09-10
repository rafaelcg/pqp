package gg.pqp.app.voice

/**
 * Whether this device may put a screen on the SFU **right now**, and whether a
 * screen operation still in flight is still the one anybody wants.
 *
 * Two small rules, both pulled out of [LiveKitEngine] because both are the kind
 * of thing that is obviously right in a comment and quietly wrong in a
 * coroutine, and neither can be exercised on a device without a LiveKit room, a
 * moderator and a stopwatch.
 */

/**
 * THE MODERATION RULE. Publishing needs BOTH answers, and the second one is the
 * one that was missing.
 *
 * The SFU token is minted once, at connect, and its `canPublishSources` grant
 * lives as long as the session. A moderator taking START_WATCH_PARTY (or
 * STREAM) away mid-party does not re-mint it: the server stops relaying the
 * roster claim and stops the egress, but the LiveKit grant this device is
 * holding stays valid. So a client that remembers only the token's answer will
 * happily publish again, and the revocation it was told about is a suggestion
 * it took once.
 *
 * That is a moderation bypass, and it matters most at exactly the event this
 * feature was written for, where a host decides who broadcasts. The fix is that
 * the connect-time grant is a CEILING and never a permission: the live answer
 * from `welcome.canStream` and `voice-speak-changed` has to agree, every time,
 * and it is re-asked on every permission change rather than cached at connect.
 */
fun canPublishScreenNow(tokenGrantsScreen: Boolean, rosterAllowsScreen: Boolean): Boolean =
    tokenGrantsScreen && rosterAllowsScreen

/**
 * THE LIFECYCLE RULE. Which screen operation is the current one.
 *
 * Publishing a screen is not one call: a capture starts, a track is created,
 * and a publish is awaited on the SFU. Between the second and the third, any of
 * these ordinary things can happen, and every one of them was a real bug before
 * this existed:
 *
 *  - **The person stops sharing.** The publish coroutine was still in flight
 *    and published a track that had already been stopped, so the room got a
 *    frozen rectangle nobody could take down.
 *  - **The room promotes.** Rooms move to the SFU at four participants and this
 *    client follows that promotion, so an engine swap mid-share is an ordinary
 *    Saturday event and not an edge case. The old engine's publish would land
 *    in a room being disconnected.
 *  - **A quick stop and restart.** Two publishes in flight, and whichever the
 *    scheduler ran last decided what the room saw.
 *  - **A late `onStop` from the projection.** The capturer's own callback for
 *    the OLD track arrived after a NEW share had started, and tore down the new
 *    one. That is the worst of the four, because the share it kills is the one
 *    that is working.
 *
 * A generation counter answers all four with one question: "is the thing that
 * just finished still the thing we are doing?". Anything holding a stale
 * generation cleans itself up and stays quiet.
 *
 * Not thread safe by construction; [LiveKitEngine] only touches it from the
 * main-immediate scope its callbacks are posted to, which is the same rule the
 * rest of that class follows.
 */
class ScreenPublishGuard {
    private var generation = 0

    /** A new share is starting. Returns the generation it owns. */
    fun begin(): Int {
        generation += 1
        return generation
    }

    /**
     * Everything outstanding is now stale: a stop, an engine teardown, a
     * revoked permission. Nothing in flight will act after this.
     */
    fun invalidate() {
        generation += 1
    }

    /** Whether work holding [ticket] is still the share anybody wants. */
    fun isCurrent(ticket: Int): Boolean = ticket == generation
}

/**
 * How long to wait before asking the SFU again to drop a publication.
 *
 * A failed `unpublishTrack` used to be logged and forgotten, which is the
 * quietest bad outcome in this file: the presenter's own UI says they stopped,
 * their capture really has stopped, and the server still holds the publication,
 * so everybody else keeps a frozen screen with no way to know it is stale. A
 * signalling blip is exactly when this happens and exactly when nobody is
 * looking.
 *
 * Bounded rather than forever, and short, because the local track is already
 * stopped by then: this is chasing a stale server-side row, not keeping a
 * feature alive, and a phone retrying into a dead socket until the heat death
 * of the universe helps nobody. After the last attempt the reconnect path takes
 * over, since a room that comes back re-publishes from scratch.
 */
const val UNPUBLISH_MAX_ATTEMPTS = 4

fun unpublishRetryDelayMs(attempt: Int): Long = when {
    attempt <= 0 -> 0
    attempt >= UNPUBLISH_MAX_ATTEMPTS -> 0
    else -> 250L * (1 shl (attempt - 1))
}
