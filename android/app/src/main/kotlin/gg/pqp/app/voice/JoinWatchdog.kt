package gg.pqp.app.voice

/**
 * How long a join may sit on "Conectando" before this app says so.
 *
 * The same number as `JOIN_TIMEOUT_MS` in `client/src/hooks/use-voice.ts`,
 * deliberately: a phone and a laptop asking the same server for the same room
 * should give up at the same moment, and a second threshold is a second thing
 * to reason about.
 *
 * It covers the socket leg only, from `join-voice-room` going out to `welcome`
 * coming back. The media leg after `welcome` has its own deadline inside
 * [LiveKitEngine], which ends in [Refusal.VoiceBackendUnreachable].
 */
const val VOICE_JOIN_TIMEOUT_MS = 12_000L

/**
 * Whether the join we are still waiting on is the join anybody still wants.
 *
 * ## The failure this exists for
 *
 * `join-voice-room` has no acknowledgement. `welcome` is the only thing that
 * comes back on success, and on most of the ways it can fail **nothing comes
 * back at all**: `refuseResume()` in `server/src/ws/voice.ts` sends
 * `voice-join-refused` only when the join carried a `resumePeerId`, and this
 * client never sends one (see `VoiceController.resumePeerId`). So a timed-out
 * account, a blocked DM, a lost CONNECT bit, a channel that went away and,
 * once watch parties stop being voice rooms by default, an ordinary viewer
 * asking for a seat, all produce the same thing on this phone: silence, and a
 * call bar that says it is connecting until somebody kills the app.
 *
 * That is the worst shape a refusal can take, and it is not specific to watch
 * parties. This makes every one of them end in a sentence.
 *
 * ## Why a generation and not a flag
 *
 * A join is not one event. The socket drops and the call is rebuilt from
 * scratch (`VoiceController.followConnection`), somebody moves rooms, somebody
 * hangs up while the first join is still in flight. Each of those leaves a
 * coroutine sleeping on the *old* attempt's deadline, and a flag cannot tell
 * that coroutine that the thing it was waiting for is over. Firing anyway
 * would hang up a call that had just connected, which is worse than the bug
 * being fixed.
 *
 * Same shape as [ScreenPublishGuard] in this package, for the same reason, and
 * one difference: [claim] is **one-shot**. Whoever takes the deadline takes it
 * once, so a refusal cannot be delivered twice.
 *
 * Not thread safe by construction, like the rest of [VoiceController]'s state:
 * every call is made from that class's single scope.
 */
class JoinWatchdog {

    private var generation = 0

    /** The generation currently waiting on a `welcome`, or null. */
    private var pending: Int? = null

    private var channel: String? = null

    /** The channel a deadline is currently running for, for logs and tests. */
    val waitingFor: String? get() = if (pending == null) null else channel

    /**
     * A join has gone out. Returns the ticket that attempt owns; every older
     * attempt is abandoned by the same act.
     */
    fun arm(channelId: String): Int {
        generation += 1
        pending = generation
        channel = channelId
        return generation
    }

    /**
     * The join is over, one way or the other: `welcome` landed, the person
     * hung up, the server refused, or the socket went and the call is being
     * held for a rebuild. Nothing sleeping on a deadline will act after this.
     */
    fun settled() {
        pending = null
        channel = null
    }

    /**
     * Take the deadline, if it is still this attempt's to take.
     *
     * Answers the channel that was armed, and disarms. Answers null for a
     * stale ticket, for a join that has already settled, and for a second
     * claim of the same ticket, and in the stale case it leaves the attempt
     * that IS current still armed.
     */
    fun claim(ticket: Int): String? {
        if (pending != ticket) {
            return null
        }
        val channelId = channel
        settled()
        return channelId
    }
}
