package gg.pqp.app.core

import android.util.Log
import java.util.concurrent.TimeUnit
import kotlin.math.min
import kotlin.random.Random
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.MutableSharedFlow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.SharedFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asSharedFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
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
        _state.value = RealtimeState.Idle
    }

    private suspend fun runLoop() {
        while (wanted) {
            val token = tokens.currentToken()
            if (token == null) {
                _state.value = RealtimeState.Refused
                return
            }

            _state.value = if (attempt == 0) RealtimeState.Connecting else RealtimeState.Reconnecting

            val closed = kotlinx.coroutines.CompletableDeferred<CloseReason>()
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

            if (!wanted) return

            if (reason.code == CLOSE_UNAUTHORIZED) {
                // 4401 is a refusal, not a blip. Retrying with the same
                // credentials in a tight loop is how a client gets an address
                // rate-limited, and the account almost certainly needs a human
                // (a stale token, or an age gate that has not been answered).
                _state.value = RealtimeState.Refused
                return
            }

            attempt += 1
            delay(backoffMillis(attempt, throttled = reason.code == CLOSE_RATE_LIMITED))
        }
    }

    private fun listener(token: String, closed: kotlinx.coroutines.CompletableDeferred<CloseReason>) =
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

    fun sendMessage(channelId: String, body: String, nonce: String, replyToId: String? = null): Boolean =
        send(
            buildJsonObject {
                put("type", "message-create")
                put("channelId", channelId)
                put("body", body)
                put("nonce", nonce)
                if (replyToId != null) put("replyToId", replyToId)
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

        /** The server's own close codes. Neither is an ordinary disconnect. */
        private const val CLOSE_UNAUTHORIZED = 4401
        private const val CLOSE_RATE_LIMITED = 4429

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
