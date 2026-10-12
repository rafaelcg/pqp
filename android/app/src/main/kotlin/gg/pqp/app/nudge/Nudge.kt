package gg.pqp.app.nudge

import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Message
import gg.pqp.app.core.PqpJson
import java.time.Instant
import java.util.WeakHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.Serializable
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody

/**
 * Chamar a atenção (the nudge), on the phone. The contract is
 * `packages/shared/src/nudge.ts`; these are its rules in Kotlin so every
 * client agrees on when a nudge shakes and why one was refused.
 *
 * A nudge is an ordinary message with `systemKind: "nudge"` and a `📳` body,
 * written by the server when a `nudge` frame lands. So history, unread, push
 * and delete need nothing here; what is new is the button, the centred line,
 * the shake, and the refusal.
 */
object Nudge {

    const val SYSTEM_KIND = "nudge"

    /** `NUDGE_FRESH_MS`: older than this on receipt is history, a line only. */
    const val FRESH_MS = 15_000L

    /** `NUDGE_COOLDOWN_MS`: the button rests this long after a send. */
    const val COOLDOWN_MS = 10_000L

    fun isNudge(message: Message): Boolean = message.systemKind == SYSTEM_KIND

    /**
     * When the button may be pressed again after a send. Rests for the
     * cooldown at once when the frame left (a second tap inside it would only
     * be refused); stays free when it did not, so the person can try again.
     */
    fun holdAfterSend(left: Boolean, nowMs: Long): Long = if (left) nowMs + COOLDOWN_MS else 0L

    /**
     * When the button may be pressed again after a refusal. Only a cooldown
     * says when; any other refusal frees it, since waiting would not change
     * the answer.
     */
    fun holdAfterRefusal(retryAfterMs: Long, nowMs: Long): Long =
        if (retryAfterMs > 0) nowMs + retryAfterMs else 0L

    /**
     * `isFreshNudge`: only a nudge from somebody else, received within 15 s
     * of being sent, shakes and buzzes. One read out of history, replayed
     * after a reconnect, or sent by me is the line and nothing more. A little
     * slack below zero because the server's clock may be ahead of ours.
     */
    fun isFresh(message: Message, viewerId: String?, nowMs: Long): Boolean {
        if (!isNudge(message)) return false
        if (viewerId != null && message.authorId == viewerId) return false
        val created = runCatching { Instant.parse(message.createdAt).toEpochMilli() }.getOrNull() ?: return false
        val age = nowMs - created
        return age >= -FRESH_MS && age < FRESH_MS
    }
}

/** `NUDGE_REFUSAL_REASONS`. Anything unknown reads as [Unavailable]. */
enum class NudgeRefusalReason(val wire: String) {
    Cooldown("cooldown"),
    Unanswered("unanswered"),
    Busy("busy"),
    SelfOff("self-off"),
    Unavailable("unavailable"),
    ;

    companion object {
        fun fromWire(value: String?): NudgeRefusalReason =
            entries.firstOrNull { it.wire == value } ?: Unavailable
    }
}

/** A nudge that did not land: the reason, and until when the button rests. */
data class NudgeRefusal(val reason: NudgeRefusalReason, val retryAfterMs: Long = 0L)

/** `GET /api/fun/config`. Off unless the server says on. */
@Serializable
data class FunConfig(val nudge: Boolean = false)

suspend fun ApiClient.funConfig(): FunConfig =
    decode(execute(Request.Builder().url(url("/api/fun/config")).get()))

/**
 * The fun switches, asked once per client and remembered, like
 * `CommunityHomeConfigs`. A 404 (a server that predates the route) is an
 * answer and is kept; a transport failure is not, so the next screen asks
 * again.
 */
object FunConfigs {
    private val cache = WeakHashMap<ApiClient, FunConfig>()

    suspend fun resolve(api: ApiClient): FunConfig {
        synchronized(cache) { cache[api] }?.let { return it }
        val config = try {
            api.funConfig()
        } catch (cancelled: CancellationException) {
            throw cancelled
        } catch (failure: ApiException) {
            if (failure.status == 404) FunConfig() else return FunConfig()
        } catch (_: Exception) {
            return FunConfig()
        }
        synchronized(cache) { cache[api] = config }
        return config
    }

    /** Forget, so a resume asks again: the flag is flipped live. */
    fun forget() = synchronized(cache) { cache.clear() }
}

/**
 * Writes the opt-out in the order it was tapped. Each write waits its turn on
 * a fair mutex, so two quick taps reach the server first-then-second and the
 * last tap is the value that stays. A failure is reported only for the newest
 * call: an older write failing while a newer one is queued changes nothing
 * the person can see.
 */
class AllowNudgesWriter {
    private val mutex = kotlinx.coroutines.sync.Mutex()
    private val latest = java.util.concurrent.atomic.AtomicInteger(0)

    /**
     * The last value the server accepted. When the newest write fails, the
     * switch goes back to THIS, never to the optimistic value just before it:
     * two quick taps that both fail must leave the switch where the server is.
     */
    @Volatile
    var confirmed: Boolean? = null

    /**
     * [write] answers whether it actually wrote. One that chose not to (its
     * account is gone) is not a failure and confirms nothing.
     */
    suspend fun set(value: Boolean, write: suspend (Boolean) -> Boolean): Boolean {
        val ticket = latest.incrementAndGet()
        // kotlinx's Mutex is fair: waiters get the lock first come, first served.
        return mutex.withLock {
            val ok = try {
                if (write(value)) confirmed = value
                true
            } catch (cancelled: CancellationException) {
                throw cancelled
            } catch (_: Exception) {
                false
            }
            ok || ticket != latest.get()
        }
    }
}

/**
 * The opt-out switch's one entry point. The session moves at once (so the
 * switch, and anything else reading it, shows the choice), and the write runs
 * in a scope that outlives the screen, so leaving settings mid-write cannot
 * cancel a request the session already claims was made. A refused newest
 * write puts the session back.
 */
object NudgePreference {
    private val scope = kotlinx.coroutines.CoroutineScope(
        kotlinx.coroutines.SupervisorJob() + kotlinx.coroutines.Dispatchers.Main.immediate,
    )
    /**
     * One writer per account. A new account gets a fresh one, so writes still
     * queued for the previous account settle into the previous writer and can
     * never move this account's confirmed value.
     */
    private var writer = AllowNudgesWriter()
    private var owner: String? = null

    fun change(session: gg.pqp.app.core.SessionStore, allow: Boolean) {
        val userId = userId(session) ?: return
        if (owner != userId) {
            // First tap for this account: what the session holds came from
            // `/api/me`, so it is what the server has.
            writer = AllowNudgesWriter().also { it.confirmed = allowed(session) }
            owner = userId
        }
        val mine = writer
        session.applyAllowNudges(allow)
        scope.launch {
            val saved = mine.set(allow) { value ->
                // Bound to the account AND the session generation that tapped.
                // A write that waited its turn across a sign-out and a sign-in
                // does nothing, and says so, even when the same account came
                // back: its writer is no longer the current one, and a newer
                // write of that account may already have landed.
                if (userId(session) != userId || writer !== mine) return@set false
                session.api.setAllowNudges(value)
                true
            }
            if (!saved && userId(session) == userId) {
                mine.confirmed?.let(session::applyAllowNudges)
            }
        }
    }

    private fun userId(session: gg.pqp.app.core.SessionStore): String? =
        (session.phase.value as? gg.pqp.app.core.SessionPhase.Ready)?.me?.id

    /** `nudgesAllowed`: on unless turned off. */
    fun allowed(session: gg.pqp.app.core.SessionStore): Boolean =
        (session.phase.value as? gg.pqp.app.core.SessionPhase.Ready)?.me?.preferences?.allowNudges != false
}

@Serializable
private data class AllowNudgesPatch(val allowNudges: Boolean)

/**
 * `PATCH /api/me/preferences` with `allowNudges`. Off works both ways:
 * nobody nudges this account and it nudges nobody.
 */
suspend fun ApiClient.setAllowNudges(allow: Boolean) {
    val body = PqpJson.encodeToString(AllowNudgesPatch.serializer(), AllowNudgesPatch(allow))
    execute(
        Request.Builder()
            .url(url("/api/me/preferences"))
            .patch(body.toRequestBody(ApiClient.JSON_MEDIA_TYPE)),
    ).close()
}
