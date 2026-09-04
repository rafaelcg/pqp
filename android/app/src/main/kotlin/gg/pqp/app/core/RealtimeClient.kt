package gg.pqp.app.core

import android.util.Log
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.put
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener

enum class RealtimeState { Idle, Connecting, Ready, Reconnecting, Refused }

/** The last time the socket closed, for the connection check's report. */
data class RealtimeClose(val code: Int, val reason: String, val atMillis: Long)

/**
 * The one connection the app can say anything through.
 *
 * Sending a message is a WebSocket frame, not an HTTP call: there is no
 * `POST /api/channels/:id/messages` in this API, only `message-create` over
 * `/ws`. That makes this socket load-bearing rather than an enhancement, and it
 * is why the two rules below are rules.
 *
 * **A send that cannot leave reconnects rather than returning quietly.** A
 * client that looks online and silently drops everything it is asked to say is
 * the worst failure this class has; iOS shipped it once (see `docs/IOS.md`).
 *
 * **A reconnect resolves a fresh token.** Clerk session tokens live about a
 * minute, so a socket that reconnects with the token it opened with fails every
 * attempt after the first.
 */
class RealtimeClient(
    private val tokens: TokenProvider,
    private val scope: CoroutineScope,
    private val http: OkHttpClient,
    private val url: String = Backend.wsUrl,
) {
    private val _state = MutableStateFlow(RealtimeState.Idle)
    val state: StateFlow<RealtimeState> = _state.asStateFlow()

    /**
     * Every inbound frame, undecoded.
     *
     * Frames are handed on as `JsonObject` and dispatched on `type` by the
     * reader rather than parsed into a sealed union here. The union on the wire
     * is much wider than what this client models, and an unknown member has to
     * be *ignored*, not thrown on: a strict decode would turn every server-side
     * feature this app has not caught up with into a dead socket.
     */
    private val _frames = MutableSharedFlow<JsonObject>(extraBufferCapacity = 256)
    val frames: SharedFlow<JsonObject> = _frames.asSharedFlow()

    private var socket: WebSocket? = null
    private var connectJob: Job? = null
    private var attempt = 0
    private var wanted = false

    /** Completed by [retryNow] to cut the current backoff short. */
    @Volatile private var skipBackoff: CompletableDeferred<Unit>? = null

    @Volatile private var _lastClose: RealtimeClose? = null

    /** The last socket close, for the connection check's report. */
    val lastClose: RealtimeClose? get() = _lastClose

    private val _unauthorizedStreak = MutableStateFlow(0)

    /**
     * How many connects in a row ended in a refused (4401) or missing token.
     *
     * One refusal is a stale token, and the next attempt, with a fresh one, is
     * the fix. Two in a row means the server will not have this session at
     * all, and no amount of reconnecting changes that: the banner has to stop
     * saying "connecting" and say "sign in again". `Refused` alone cannot
     * carry that distinction, so the count is published beside it.
     */
    val unauthorizedStreak: StateFlow<Int> = _unauthorizedStreak.asStateFlow()

    /** Re-sent after every `ready`, because the server forgets on reconnect. */
    @Volatile private var subscribedChannelId: String? = null

    fun connect() {
        wanted = true
        if (connectJob?.isActive == true) return
        connectJob = scope.launch { runLoop() }
    }

    fun disconnect() {
        wanted = false
        connectJob?.cancel()
        connectJob = null
        socket?.close(1000, null)
        socket = null
        _unauthorizedStreak.value = 0
        _state.value = RealtimeState.Idle
    }

    /**
     * Skip the backoff and try to connect right now: the banner's "Try now".
     *
     * Only the *wait* is cut short. An attempt already in flight is left alone,
     * because cancelling one that is about to succeed is the bug `fallbackFor`
     * exists to prevent. The attempt counter is reset so the next failure, if
     * there is one, waits the short first-retry delay rather than whatever a
     * long outage had grown it to.
     */
    fun retryNow() {
        if (!wanted) {
            connect()
            return
        }
        attempt = 0
        skipBackoff?.complete(Unit)
        if (connectJob?.isActive != true) connect()
    }

    private suspend fun runLoop() {
        while (wanted) {
            val token = tokens.currentToken()
            if (token == null) {
                // A provider with nothing to give is a refusal too: Clerk's
                // session may be PENDING, or gone. Counted like a 4401 and
                // retried like one, since PENDING resolves on its own and gone
                // is what the streak tells the banner to say. This used to end
                // the loop, which left "Something went wrong" on screen with
                // nothing ever trying again.
                settle(AttemptOutcome.NoToken)
                attempt += 1
                waitBackoff(backoffMillis(attempt, throttled = true))
                continue
            }

            // `Refused` is never downgraded to `Reconnecting` by the attempt
            // that follows it: why the client is retrying is more useful on
            // the banner than the fact that it is. Cleared by `ready`, which
            // is the only proof the session is accepted. Same rule as the
            // web's `setPendingStatus`.
            _state.value = when {
                _state.value == RealtimeState.Refused -> RealtimeState.Refused
                attempt == 0 -> RealtimeState.Connecting
                else -> RealtimeState.Reconnecting
            }

            val closed = CompletableDeferred<CloseReason>()
            val request = Request.Builder().url(url).build()
            val ws = http.newBuilder()
                // Protocol-level keepalive. The server runs its own ping/pong
                // heartbeat and drops a socket that stops answering, so this
                // has to be comfortably shorter than that timeout. It also
                // doubles as the read deadline, which is why the client has no
                // `callTimeout`: that would bound the socket's whole lifetime.
                .pingInterval(20, TimeUnit.SECONDS)
                .build()
                .newWebSocket(request, listener(token, closed))

            socket = ws
            val reason = closed.await()
            socket = null
            _lastClose = RealtimeClose(reason.code, reason.reason, System.currentTimeMillis())

            if (!wanted) return

            attempt += 1
            if (reason.code == CLOSE_UNAUTHORIZED) {
                // 4401 used to end the loop here for good, on the theory that
                // a refusal "almost certainly needs a human". It does not,
                // most of the time, and this is the decision behind changing
                // it, written down because it is a real change of behaviour.
                //
                // The server closes 4401 for three things
                // (`server/src/ws/index.ts`): "Auth timeout", when the `auth`
                // frame did not arrive within the window; "Auth required",
                // when the first frame was not `auth`; and "Unauthorized",
                // when Clerk would not verify the token. The first is a slow
                // network, not a credential. The third is, more often than
                // not, a token that expired between `currentToken()` and the
                // handshake: Clerk tokens live about a minute, and a phone
                // that was asleep hands over one that is already dead. Every
                // one of those is fixed by the next attempt with a fresh
                // token, which is exactly what the web client does
                // (`client/src/lib/realtime.ts`, `handleConnectionLoss`: a
                // 4401 bumps `unauthorizedStreak` and still schedules a
                // reconnect). Stopping here was the "fica conectando"
                // support case: one stale token and the app sat on
                // "Something went wrong" until it was force-closed.
                //
                // What the old code was right about is that a session the
                // server keeps refusing must not be hammered, so the retry is
                // on the throttled schedule (five seconds and up, the same
                // one a 4429 gets) rather than the half-second one, and the
                // streak is what tells the banner to stop saying
                // "reconnecting" and offer "sign in again" once two attempts
                // in a row have been refused. That is the web's rule too
                // (`connection-doctor.ts`, `adviseFrom`: a socket failure
                // with a streak of two is `signInAgain`). The age gate the
                // old comment mentioned cannot reach here: `SessionStore`
                // only calls `connect()` once `GET /api/me` says the gate is
                // passed, and parks the session on the gate screen otherwise.
                settle(AttemptOutcome.Refused)
            } else {
                settle(AttemptOutcome.Dropped)
            }
            waitBackoff(backoffMillis(attempt, throttled = throttles(reason.code)))
        }
    }

    /** Applies one finished attempt to the streak and the published state. */
    private fun settle(outcome: AttemptOutcome) {
        _unauthorizedStreak.value = streakAfter(_unauthorizedStreak.value, outcome)
        when (outcome) {
            AttemptOutcome.NoToken, AttemptOutcome.Refused -> _state.value = RealtimeState.Refused
            AttemptOutcome.Ready, AttemptOutcome.Dropped -> Unit
        }
    }

    /** A delay that [retryNow] can cut short. */
    private suspend fun waitBackoff(millis: Long) {
        val skip = CompletableDeferred<Unit>()
        skipBackoff = skip
        try {
            withTimeoutOrNull(millis) { skip.await() }
        } finally {
            if (skipBackoff === skip) skipBackoff = null
        }
    }

    private fun listener(token: String, closed: CompletableDeferred<CloseReason>) =
        object : WebSocketListener() {
            override fun onOpen(webSocket: WebSocket, response: Response) {
                // The first frame must be the handshake. There is no
                // `Authorization` header on this socket; a socket that says
                // anything else first is closed 4401.
                webSocket.send(
                    PqpJson.encodeToString(
                        JsonObject.serializer(),
                        buildJsonObject {
                            put("type", "auth")
                            put("token", token)
                        },
                    ),
                )
            }

            override fun onMessage(webSocket: WebSocket, text: String) {
                val frame = runCatching {
                    PqpJson.decodeFromString(JsonObject.serializer(), text)
                }.getOrNull() ?: return

                when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                    "ready" -> {
                        attempt = 0
                        settle(AttemptOutcome.Ready)
                        _state.value = RealtimeState.Ready
                        // The server has no memory of what this connection was
                        // watching, so re-subscribing is the client's job.
                        subscribedChannelId?.let { joinChannel(it) }
                    }
                    "pong" -> return
                }

                _frames.tryEmit(frame)
            }

            override fun onClosed(webSocket: WebSocket, code: Int, reason: String) {
                complete(CloseReason(code, reason))
            }

            override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
                webSocket.close(1000, null)
                complete(CloseReason(code, reason))
            }

            override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
                Log.w(TAG, "socket failed: ${t.message}")
                complete(CloseReason(response?.code ?: 0, t.message ?: "failure"))
            }

            private fun complete(reason: CloseReason) {
                if (!closed.isCompleted) closed.complete(reason)
            }
        }

    // --- sending ---

    /**
     * Hands a frame to the socket, or reconnects trying.
     *
     * The boolean is "this left the phone", and the only honest answer while
     * the socket is down is `false` plus a reconnect. Returning `true` and
     * dropping it is what makes a client look online and do nothing.
     */
    fun send(frame: JsonObject): Boolean {
        val live = socket
        val ready = _state.value == RealtimeState.Ready
        val sent = live != null &&
            ready &&
            live.send(PqpJson.encodeToString(JsonObject.serializer(), frame))
        if (sent || !wanted) return sent

        if (fallbackFor(ready, connectJob?.isActive == true) == SendFallback.Wait) {
            // The socket is not ready *yet*, and an attempt is already in
            // flight. `socket` is non-null from the moment `newWebSocket`
            // returns, right through the auth handshake, so the old test
            // ("no socket") was never true here and every frame sent during a
            // reconnect cancelled the attempt that was about to succeed. With
            // a `typing` frame per keystroke that is one aborted attempt per
            // character, each one bumping the backoff, which walked it to the
            // 30 second cap while somebody typed a sentence.
            return false
        }

        Log.w(TAG, "send could not leave; reconnecting")
        socket?.cancel()
        socket = null
        if (connectJob?.isActive != true) connect()
        return false
    }

    fun joinChannel(channelId: String): Boolean {
        subscribedChannelId = channelId
        return send(
            buildJsonObject {
                put("type", "join-channel")
                put("channelId", channelId)
            },
        )
    }

    /**
     * Give up the subscription, but only if it is still ours.
     *
     * The channel id is required, and that is the whole fix. There is one
     * subscription per connection, and there is now more than one screen that
     * takes it: a server channel and a conversation are both `ChatScreen`, and
     * a notification tap can stack a second one on top of the first. Whichever
     * closes second used to unsubscribe unconditionally, which meant closing a
     * conversation could silently stop a channel underneath it from receiving
     * anything, with no visible symptom until somebody noticed the messages had
     * stopped.
     */
    fun leaveChannel(channelId: String) {
        if (subscribedChannelId != channelId) return
        subscribedChannelId = null
        send(buildJsonObject { put("type", "leave-channel") })
    }

    /**
     * [attachmentIds] are rows already minted by
     * `POST /api/channels/:channelId/attachments` and not yet claimed. Ids and
     * nothing else travel: filename, type and size are re-read server-side from
     * the row and from the stored object, so a sender cannot describe its own
     * upload into something it is not.
     *
     * The key is omitted rather than sent empty for an ordinary message, which
     * keeps this frame byte-identical to the one this client sent before
     * attachments existed.
     */
    fun sendMessage(
        channelId: String,
        body: String,
        nonce: String,
        replyToId: String? = null,
        attachmentIds: List<String> = emptyList(),
    ): Boolean =
        send(
            buildJsonObject {
                put("type", "message-create")
                put("channelId", channelId)
                put("body", body)
                put("nonce", nonce)
                if (replyToId != null) put("replyToId", replyToId)
                if (attachmentIds.isNotEmpty()) {
                    put(
                        "attachmentIds",
                        kotlinx.serialization.json.buildJsonArray {
                            attachmentIds.forEach { add(kotlinx.serialization.json.JsonPrimitive(it)) }
                        },
                    )
                }
            },
        )

    /**
     * Add or remove one of our own reactions. The server works out which: it
     * holds the row and flips it, and answers with a `reaction-broadcast`
     * carrying `added`.
     */
    fun toggleReaction(channelId: String, messageId: String, emoji: String): Boolean =
        send(
            buildJsonObject {
                put("type", "reaction-toggle")
                put("channelId", channelId)
                put("messageId", messageId)
                put("emoji", emoji)
            },
        )

    fun sendTyping(channelId: String) {
        send(
            buildJsonObject {
                put("type", "typing")
                put("channelId", channelId)
            },
        )
    }

    private data class CloseReason(val code: Int, val reason: String)

    /** What a frame that could not leave should make this client do. */
    internal enum class SendFallback { Wait, Reconnect }

    /**
     * How one connect attempt ended, as far as the refusal count cares.
     * `NoToken` never opened a socket; `Refused` is a 4401 close; `Dropped`
     * is every other close; `Ready` is the server's handshake reply.
     */
    internal enum class AttemptOutcome { NoToken, Refused, Ready, Dropped }

    companion object {
        private const val TAG = "pqp.realtime"

        /**
         * Whether a failed send should tear the socket down, or wait.
         *
         * Pure so that the one rule that matters can be pinned by a test:
         * a connect attempt that has not finished yet is not a broken socket,
         * and cancelling it restarts the handshake and grows the backoff.
         */
        internal fun fallbackFor(ready: Boolean, attemptInFlight: Boolean): SendFallback =
            if (!ready && attemptInFlight) SendFallback.Wait else SendFallback.Reconnect

        /**
         * The number of refusals in a row after which the session is treated
         * as gone rather than stale. Shared with the banner, the doctor and
         * the voice controller, and the same number the web client uses.
         */
        const val REFUSED_FOR_GOOD = 2

        /**
         * What one finished connect attempt does to [unauthorizedStreak].
         *
         * Pure, and the whole 4401 rule in one place: a refusal or a missing
         * token counts, `ready` clears, and an ordinary drop (a server
         * restart, a tunnel change) leaves the count alone rather than
         * clearing it, because one lucky TCP failure between two refusals
         * must not reset the banner back to "reconnecting".
         */
        internal fun streakAfter(streak: Int, outcome: AttemptOutcome): Int = when (outcome) {
            AttemptOutcome.NoToken, AttemptOutcome.Refused -> streak + 1
            AttemptOutcome.Ready -> 0
            AttemptOutcome.Dropped -> streak
        }

        /** Whether a streak this long means "sign in again" rather than "wait". */
        fun refusedForGood(streak: Int): Boolean = streak >= REFUSED_FOR_GOOD

        /**
         * Whether a close code puts the next retry on the slow schedule. A
         * refused session is not hammered any more than a rate-limited one.
         */
        internal fun throttles(closeCode: Int): Boolean =
            closeCode == CLOSE_UNAUTHORIZED || closeCode == CLOSE_RATE_LIMITED

        /** The server's own close codes. Neither is an ordinary disconnect. */
        const val CLOSE_UNAUTHORIZED = 4401
        const val CLOSE_RATE_LIMITED = 4429

        /**
         * Capped exponential backoff with jitter. The jitter matters more than
         * it looks: without it every client dropped by one server restart comes
         * back at the same instant and knocks it over again.
         */
        fun backoffMillis(attempt: Int, throttled: Boolean = false): Long {
            val base = if (throttled) 5_000L else 500L
            val capped = min(base * (1L shl min(attempt - 1, 5)), 30_000L)
            return capped + Random.nextLong(0, capped / 2 + 1)
        }
    }
}
