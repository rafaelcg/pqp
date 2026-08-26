package gg.pqp.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.core.Message
import gg.pqp.app.core.PqpJson
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionStore
import java.util.UUID
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive

data class ChatState(
    val messages: List<Message> = emptyList(),
    val loading: Boolean = true,
    val hasMore: Boolean = false,
    val loadingOlder: Boolean = false,
    val typing: Set<String> = emptySet(),
    val error: String? = null,
)

/**
 * One channel's transcript.
 *
 * History comes over HTTP; everything live comes over the socket, and so does
 * **sending**. This API has no `POST /api/channels/:id/messages`, only a
 * `message-create` frame. The only correlation the protocol offers is the
 * `nonce` echoed back on `message-broadcast`, so that is what retires an
 * optimistic row. There is no ack and no error frame: an invalid frame is
 * dropped server-side in silence.
 */
class ChatViewModel(
    private val session: SessionStore,
    private val channelId: String,
) : ViewModel() {

    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    /** Nonces this client is still waiting to see echoed back. */
    private val pending = mutableSetOf<String>()

    init {
        viewModelScope.launch { loadInitial() }
        viewModelScope.launch { listen() }
        viewModelScope.launch { followConnection() }
    }

    private suspend fun loadInitial() {
        runCatching { session.api.messages(channelId) }
            .onSuccess { page ->
                _state.value = _state.value.copy(
                    messages = page.messages,
                    hasMore = page.hasMore,
                    loading = false,
                )
            }
            .onFailure { failure ->
                // `it.message` alone is not safe to test for "did this fail".
                // `NetworkOnMainThreadException` carries a null message, so the
                // failure that caused this whole investigation recorded itself
                // as no failure at all and the screen said the channel was
                // empty. Fall back to the class name so a thrown thing is
                // always visibly a thrown thing.
                _state.value = _state.value.copy(
                    loading = false,
                    error = failure.message?.takeIf { it.isNotBlank() }
                        ?: failure::class.java.simpleName,
                )
            }
        session.realtime.joinChannel(channelId)
    }

    fun loadOlder() {
        val current = _state.value
        if (current.loadingOlder || !current.hasMore) return
        val oldest = current.messages.firstOrNull()?.id ?: return

        _state.value = current.copy(loadingOlder = true)
        viewModelScope.launch {
            runCatching { session.api.messages(channelId, before = oldest) }
                .onSuccess { page ->
                    val known = _state.value.messages.map { it.id }.toSet()
                    _state.value = _state.value.copy(
                        messages = page.messages.filterNot { it.id in known } + _state.value.messages,
                        hasMore = page.hasMore,
                        loadingOlder = false,
                    )
                }
                .onFailure { _state.value = _state.value.copy(loadingOlder = false) }
        }
    }

    /**
     * The channel subscription is per connection, and the server keeps no
     * memory of it across a reconnect. `RealtimeClient` re-sends the last join
     * itself, but a screen that was opened while the socket was down never got
     * one sent, so this re-asserts on every transition into `Ready` and
     * refetches what was missed while it was gone.
     */
    private suspend fun followConnection() {
        session.realtime.state.collect { state ->
            if (state == RealtimeState.Ready) {
                session.realtime.joinChannel(channelId)
                catchUp()
            }
        }
    }

    private suspend fun catchUp() {
        val newest = _state.value.messages.lastOrNull()?.id ?: return
        runCatching { session.api.messages(channelId, after = newest) }
            .onSuccess { page ->
                if (page.messages.isEmpty()) return@onSuccess
                val known = _state.value.messages.map { it.id }.toSet()
                _state.value = _state.value.copy(
                    messages = _state.value.messages + page.messages.filterNot { it.id in known },
                )
            }
    }

    private suspend fun listen() {
        session.realtime.frames.collect { frame ->
            when (frame.string("type")) {
                "message-broadcast" -> onBroadcast(frame)
                "message-update" -> onUpdate(frame)
                // Both spellings are live on the wire. The server broadcasts
                // `message-delete`; `message-deleted` is the older name and is
                // still relayed. Handling one of them leaves deleted messages
                // on screen for whoever is connected to the wrong instance.
                "message-delete", "message-deleted" -> onDelete(frame)
                "reaction-broadcast" -> onReaction(frame)
                "typing-broadcast" -> onTyping(frame)
            }
        }
    }

    private fun onBroadcast(frame: JsonObject) {
        val message = frame.message() ?: return
        if (message.channelId != channelId) return
        val nonce = frame.string("nonce")

        val current = _state.value.messages
        val withoutOptimistic = if (nonce != null && pending.remove(nonce)) {
            current.filterNot { it.id == nonce }
        } else {
            current
        }
        if (withoutOptimistic.any { it.id == message.id }) return
        _state.value = _state.value.copy(messages = withoutOptimistic + message)
    }

    private fun onUpdate(frame: JsonObject) {
        val message = frame.message() ?: return
        if (message.channelId != channelId) return
        _state.value = _state.value.copy(
            messages = _state.value.messages.map { if (it.id == message.id) message else it },
        )
    }

    private fun onDelete(frame: JsonObject) {
        if (frame.string("channelId") != channelId) return
        val id = frame.string("messageId") ?: return
        _state.value = _state.value.copy(
            messages = _state.value.messages.filterNot { it.id == id },
        )
    }

    /**
     * Somebody reacted, or took a reaction back.
     *
     * The frame is a **delta**, so this is the one path where a count can drift
     * without anything ever erroring: see [applyReactionBroadcast], which this
     * defers the whole rule to and which the web client shares.
     *
     * Guarded to this channel like every other broadcast, because the socket's
     * subscription is per connection and a frame for the chat that was on
     * screen a second ago still arrives here.
     */
    private fun onReaction(frame: JsonObject) {
        if (frame.string("channelId") != channelId) return
        val messageId = frame.string("messageId") ?: return
        val emoji = frame.string("emoji") ?: return
        val userId = frame.string("userId") ?: return
        val added = (frame["added"] as? JsonPrimitive)?.booleanOrNull ?: return

        _state.value = _state.value.copy(
            messages = _state.value.messages.map { message ->
                if (message.id != messageId) {
                    message
                } else {
                    message.copy(
                        reactions = applyReactionBroadcast(
                            reactions = message.reactions,
                            emoji = emoji,
                            userId = userId,
                            displayName = frame.string("displayName"),
                            added = added,
                            currentUserId = currentUserId,
                        ),
                    )
                }
            },
        )
    }

    /**
     * Add or remove one of our own reactions.
     *
     * Applied locally first. A reaction is a round trip over a socket that may
     * be reconnecting, and a pill that does not move until the broadcast comes
     * back reads as a dead control: people tap it again, which sends a second
     * toggle and undoes the first. The broadcast is idempotent against the
     * local change, so the two cannot disagree.
     *
     * A frame that does not leave the phone rolls the pill back rather than
     * leaving it showing a reaction the server never heard about.
     */
    fun toggleReaction(messageId: String, emoji: String, author: gg.pqp.app.core.Me?) {
        // An optimistic row borrows its nonce as its id, and that nonce names
        // no message on the server. The frame would be dropped in silence (this
        // socket has no ack and no error frame) and the pill would sit there
        // looking applied forever. The web client refuses the same case.
        if (messageId in pending) return

        val before = _state.value.messages
        val userId = author?.id ?: return

        currentUserId = userId
        _state.value = _state.value.copy(
            messages = before.map { message ->
                if (message.id != messageId) {
                    message
                } else {
                    message.copy(
                        reactions = toggleOwnReaction(
                            reactions = message.reactions,
                            emoji = emoji,
                            currentUserId = userId,
                            displayName = author.displayName,
                        ),
                    )
                }
            },
        )

        if (!session.realtime.toggleReaction(channelId, messageId, emoji)) {
            _state.value = _state.value.copy(messages = before)
        }
    }

    /**
     * Who we are, for `me` on an incoming reaction.
     *
     * Kept here rather than read from the session on every frame because the
     * broadcast arrives on the socket's collector and the phase is a separate
     * flow; recorded the first time the UI hands us an author, which is also
     * the first time it can matter.
     */
    @Volatile private var currentUserId: String? = null

    /** Told to us by the screen, which is where the session phase is read. */
    fun setCurrentUser(userId: String?) {
        if (userId != null) currentUserId = userId
    }

    private fun onTyping(frame: JsonObject) {
        if (frame.string("channelId") != channelId) return
        val name = frame.string("displayName") ?: return
        _state.value = _state.value.copy(typing = _state.value.typing + name)
        viewModelScope.launch {
            kotlinx.coroutines.delay(TYPING_TTL_MS)
            _state.value = _state.value.copy(typing = _state.value.typing - name)
        }
    }

    /**
     * Say something, and answer whether it left the phone.
     *
     * The boolean is load-bearing rather than informational: the composer
     * clears the box on `true` and keeps the typed text on `false`. It used to
     * clear unconditionally, which meant a send during a reconnect swallowed
     * the sentence somebody had just written, with the optimistic row removed a
     * frame later so there was nothing left on screen to retry from.
     */
    fun send(body: String, author: gg.pqp.app.core.Me?): Boolean {
        val trimmed = body.trim()
        if (trimmed.isEmpty()) return false

        val nonce = UUID.randomUUID().toString()
        pending += nonce

        // The optimistic row borrows the nonce as its id, which is what makes
        // retiring it a plain filter when the broadcast arrives.
        val optimistic = Message(
            id = nonce,
            channelId = channelId,
            authorId = author?.id.orEmpty(),
            authorName = author?.displayName.orEmpty(),
            authorAvatarUrl = author?.avatarUrl,
            body = trimmed,
            createdAt = java.time.Instant.now().toString(),
        )
        _state.value = _state.value.copy(messages = _state.value.messages + optimistic)

        if (!session.realtime.sendMessage(channelId, trimmed, nonce)) {
            // The frame did not leave the phone. `RealtimeClient` is already
            // reconnecting; the row is dropped rather than left looking sent,
            // because a message that silently never arrives is the failure this
            // whole path exists to avoid.
            pending -= nonce
            _state.value = _state.value.copy(
                messages = _state.value.messages.filterNot { it.id == nonce },
            )
            return false
        }
        return true
    }

    /**
     * Tell the channel somebody is typing, at most once every
     * [TYPING_THROTTLE_MS].
     *
     * The composer calls this on every keystroke, because that is the only
     * moment it knows about. Forwarding every one of them put a frame on the
     * socket per character, which is what the web client's own 2.5 second
     * throttle exists to avoid, and which made a reconnect during typing far
     * worse than a reconnect on its own.
     */
    fun typing() {
        val now = android.os.SystemClock.elapsedRealtime()
        if (!shouldSendTyping(now, lastTypingAt)) return
        lastTypingAt = now
        session.realtime.sendTyping(channelId)
    }

    /**
     * Monotonic, not wall clock: `elapsedRealtime` cannot go backwards when the
     * phone's clock is corrected, which would otherwise strand the throttle
     * closed for however far it jumped.
     */
    private var lastTypingAt = 0L

    override fun onCleared() {
        // Named, because there is more than one chat surface now and the
        // subscription is one per connection. See RealtimeClient.leaveChannel.
        session.realtime.leaveChannel(channelId)
    }

    /**
     * Re-assert this screen's subscription.
     *
     * Called when the screen comes back to the foreground. A second chat opened
     * on top of this one (a notification tap, a conversation) took the single
     * per-connection subscription with it, and popping it back off does not
     * hand it back. Without this the screen underneath sits there looking
     * connected and receives nothing.
     */
    fun resubscribe() {
        session.realtime.joinChannel(channelId)
    }

    private fun JsonObject.string(key: String): String? =
        this[key]?.jsonPrimitive?.contentOrNull

    private fun JsonObject.message(): Message? = runCatching {
        PqpJson.decodeFromJsonElement(Message.serializer(), this["message"]!!.jsonObject)
    }.getOrNull()

    companion object {
        private const val TYPING_TTL_MS = 4_000L

        /**
         * Matches `TYPING_THROTTLE_MS` in the web client. The server's own
         * `typing` fan-out has a shorter life than this on the receiving side,
         * which is why it is a floor on sends and not a ceiling on anything.
         */
        internal const val TYPING_THROTTLE_MS = 2_500L

        /** Pure, so the one rule here is pinned by a test. */
        internal fun shouldSendTyping(nowMs: Long, lastSentMs: Long): Boolean =
            lastSentMs == 0L || nowMs - lastSentMs >= TYPING_THROTTLE_MS

        fun factory(session: SessionStore, channelId: String) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ChatViewModel(session, channelId) as T
        }
    }
}
