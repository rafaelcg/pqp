package gg.pqp.app.core

import com.clerk.api.session.Session
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicInteger
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.launch
import okhttp3.Interceptor
import okhttp3.Response

/*
 * One door for a session that ended under the person.
 *
 * "Your session expired" used to be a different thing on every screen: nothing
 * above the screens ever noticed a 401, so the phase stayed `Ready`, Profile
 * still offered Sign out, and the only exit was the connection banner's manual
 * "Sign in again" after two refused sockets. Everything that can find out now
 * lands in [SessionExpiryGate.handle], called through
 * `SessionStore.handleSessionExpired`: any authenticated 401 on the shared
 * HTTP client ([SessionExpiryInterceptor]), a socket refused with 4401 or
 * given no token, and Clerk saying its own session is over.
 */

/** What asking the server "is this session alive" answered. */
enum class SessionProbe {
    Alive,

    /** Even a freshly refreshed token is refused, or there is no session at all. */
    Dead,

    /** Could not tell (offline, a 5xx). Never a reason to sign anybody out. */
    Unknown,
}

/** What a forced token refresh found, and why there is none when there is none. */
sealed interface TokenRefresh {
    data class Token(val value: String) : TokenRefresh

    /**
     * There is no session left to ask for a token (signed out, replaced by a
     * sign-in on another device under single session mode, expired, revoked).
     * Retrying changes nothing.
     */
    data object NoSession : TokenRefresh

    /** A session exists but a token could not be had right now (offline). */
    data object Unavailable : TokenRefresh
}

object SessionExpiry {
    /** Only a 401 is a dead session. Anything else the server says, or fails to say, is "unknown". */
    fun classifyProbe(status: Int?): SessionProbe = when (status) {
        401 -> SessionProbe.Dead
        in 200..299 -> SessionProbe.Alive
        else -> SessionProbe.Unknown
    }

    /**
     * What a refused token refresh means. Clerk answers 401 / 403 / 404 when
     * the session is not there to mint from; no status at all (a dropped
     * connection), a 429 or a 5xx is "try later", not "signed out".
     */
    fun classifyRefreshFailure(code: Int?): TokenRefresh = when (code) {
        401, 403, 404 -> TokenRefresh.NoSession
        else -> TokenRefresh.Unavailable
    }

    /**
     * Which of Clerk's session states are the session being over, as opposed
     * to unfinished. A session Clerk still holds but has ended (`REPLACED` is
     * what single session mode does to the phone when the same account signs
     * in on another device) keeps `Clerk.session` non-null, which is how the
     * app used to believe it was signed in. `PENDING` is a sign-in waiting on
     * a step, which is not signed in but not over either.
     */
    fun isOver(status: Session.SessionStatus?): Boolean = when (status) {
        null -> true
        Session.SessionStatus.ENDED,
        Session.SessionStatus.EXPIRED,
        Session.SessionStatus.REMOVED,
        Session.SessionStatus.REPLACED,
        Session.SessionStatus.REVOKED,
        Session.SessionStatus.ABANDONED,
        -> true
        Session.SessionStatus.ACTIVE,
        Session.SessionStatus.PENDING,
        Session.SessionStatus.UNKNOWN,
        -> false
    }
}

/**
 * Makes ONE transition out of however many callers notice at once (thirty
 * requests refused together, the socket, Clerk's own state change).
 *
 * The first caller claims it and the rest return at once. The claim is held
 * across the probe, which asks the server once whether the session is really
 * gone with a freshly refreshed token: a 401 can also be one stale token, and
 * signing somebody out over that is worse than the message it replaces.
 *
 * Pure on purpose (no Clerk, no Android), so the rules are pinned by a JVM
 * test: [hasAccount] says whether there is anything to tear down, [probe]
 * asks the server, [endSession] is the whole local teardown.
 */
class SessionExpiryGate(
    private val scope: CoroutineScope,
    private val hasAccount: () -> Boolean,
    private val probe: suspend () -> SessionProbe,
    private val endSession: suspend () -> Unit,
) {
    private val epoch = AtomicInteger(0)
    private val claimed = AtomicBoolean(false)

    /** Read by a request before it leaves, handed back with its 401. */
    fun currentEpoch(): Int = epoch.get()

    /**
     * A session ended, whichever way (including the person's own Sign out).
     * Requests that began before this belong to it: their late refusals are
     * the previous session's business and must not end the next one.
     */
    fun sessionEnded() {
        epoch.incrementAndGet()
    }

    /** Called by the HTTP layer for each 401, from OkHttp's own thread. */
    fun noteUnauthorized(startedAtEpoch: Int) {
        if (startedAtEpoch != epoch.get() || claimed.get()) return
        scope.launch { handle() }
    }

    suspend fun handle() {
        if (!hasAccount()) return
        if (!claimed.compareAndSet(false, true)) return
        try {
            // The session this question is about. If it ends while the probe is
            // in the air (a Sign out, then a sign-in as somebody else), a late
            // "dead" is about the previous one and must not take down the next.
            val asked = epoch.get()
            when (probe()) {
                SessionProbe.Alive, SessionProbe.Unknown -> return
                SessionProbe.Dead -> Unit
            }
            // Checking the epoch and claiming the teardown are ONE step: a
            // session cannot end between the two.
            if (!hasAccount() || !epoch.compareAndSet(asked, asked + 1)) return
            endSession()
        } finally {
            claimed.set(false)
        }
    }
}

/** Marks the confirmation request, which is the handler's own question and never reports to it. */
internal object SessionProbeRequest

/**
 * The central place a 401 is noticed: on the one OkHttp client that ApiClient,
 * the stories / attachments / Baú uploads and the soundboard all share, so no
 * request path can miss it. Only a refusal of a request that CARRIED a bearer
 * token counts (a presigned storage URL or an image fetch has none), and only
 * one that began under the current epoch.
 */
class SessionExpiryInterceptor(private val gate: () -> SessionExpiryGate?) : Interceptor {
    override fun intercept(chain: Interceptor.Chain): Response {
        val request = chain.request()
        val target = gate()
        val epoch = target?.currentEpoch()
        val response = chain.proceed(request)
        if (target != null && epoch != null &&
            response.code == 401 &&
            request.header("Authorization") != null &&
            request.tag(SessionProbeRequest::class.java) == null
        ) {
            target.noteUnauthorized(epoch)
        }
        return response
    }
}
