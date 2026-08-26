package gg.pqp.app.ui.screens

import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.attachments.AttachmentApi
import gg.pqp.app.attachments.AttachmentConfig
import gg.pqp.app.attachments.AttachmentFiles
import gg.pqp.app.attachments.AttachmentRefusal
import gg.pqp.app.attachments.CreateAttachmentRequest
import gg.pqp.app.attachments.PendingAttachment
import gg.pqp.app.attachments.attachmentIdsFor
import gg.pqp.app.attachments.refuseAttachment
import gg.pqp.app.core.Attachment
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
    /**
     * Whether this deployment has object storage at all.
     *
     * False until `GET /api/attachments/config` answers, and false forever on a
     * self-host with no `S3_*` configured. The attach button is absent in that
     * state rather than present and failing, which is the shape the web client
     * uses for the same switch.
     */
    val attachmentsEnabled: Boolean = false,
    /** This deployment's own cap, which may be lower than the built-in one. */
    val maxAttachmentBytes: Long = gg.pqp.app.attachments.DEFAULT_MAX_ATTACHMENT_BYTES,
    /** Files picked for the message being written, in the order picked. */
    val attachments: List<PendingAttachment> = emptyList(),
    /** The last refusal, for the composer to say out loud. Cleared on the next pick. */
    val attachmentRefusal: AttachmentRefusal? = null,
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
    /**
     * How a picked file is read, or null on a surface that cannot pick one.
     *
     * Injected rather than reached for through a Context, so the upload logic
     * above it is exercised by a JVM test with no device and no provider.
     */
    private val files: AttachmentFiles? = null,
) : ViewModel() {

    private val attachmentApi = AttachmentApi(session.api)

    private val _state = MutableStateFlow(ChatState())
    val state: StateFlow<ChatState> = _state.asStateFlow()

    /** Nonces this client is still waiting to see echoed back. */
    private val pending = mutableSetOf<String>()

    init {
        viewModelScope.launch { loadInitial() }
        viewModelScope.launch { listen() }
        viewModelScope.launch { followConnection() }
        viewModelScope.launch { loadAttachmentConfig() }
    }

    // --- attachments ---

    /**
     * Ask whether this deployment can take a file at all.
     *
     * A failure is off, not an error: with no `S3_*` configured the endpoint
     * answers `enabled: false`, and an older server has no endpoint at all.
     * Both mean the same thing to the composer, and neither is worth putting a
     * banner on a chat screen for.
     */
    private suspend fun loadAttachmentConfig() {
        if (files == null) return
        val config = runCatching { attachmentApi.config() }.getOrDefault(AttachmentConfig())
        _state.value = _state.value.copy(
            attachmentsEnabled = config.enabled,
            maxAttachmentBytes = config.maxBytes,
        )
    }

    /**
     * Take a file the picker returned: describe it, show it, then upload it.
     *
     * The chip appears before the upload starts, because that is when the
     * person expects to see what they just picked. It cannot be sent until the
     * upload finishes, which is what [gg.pqp.app.attachments.composerReadiness]
     * enforces: a `message-create` naming a row whose object was never PUT is
     * dropped at claim time, and the message then arrives with the picture
     * missing and nothing anywhere explaining it.
     */
    fun attach(uri: String) {
        val reader = files ?: return
        val current = _state.value
        if (!current.attachmentsEnabled) return

        val localId = UUID.randomUUID().toString()
        _state.value = current.copy(attachmentRefusal = null)

        viewModelScope.launch {
            val local = reader.read(uri, current.maxAttachmentBytes)
            if (local == null) {
                _state.value = _state.value.copy(attachmentRefusal = AttachmentRefusal.Unreadable)
                return@launch
            }

            val size = local.bytes.size.toLong()
            val refusal = refuseAttachment(
                contentType = local.contentType,
                byteSize = size,
                maxBytes = _state.value.maxAttachmentBytes,
                alreadyAttached = _state.value.attachments.size,
            )
            if (refusal != null) {
                _state.value = _state.value.copy(attachmentRefusal = refusal)
                return@launch
            }

            val contentType = local.contentType!!
            val pending = PendingAttachment(
                localId = localId,
                uri = uri,
                filename = local.filename,
                contentType = contentType,
                byteSize = size,
            )
            _state.value = _state.value.copy(attachments = _state.value.attachments + pending)

            upload(localId, contentType, local.filename, size, local.width, local.height, local.bytes)
        }
    }

    private suspend fun upload(
        localId: String,
        contentType: String,
        filename: String,
        byteSize: Long,
        width: Int?,
        height: Int?,
        bytes: ByteArray,
    ) {
        val minted = runCatching {
            val response = attachmentApi.mint(
                channelId,
                CreateAttachmentRequest(
                    filename = filename,
                    contentType = contentType,
                    byteSize = byteSize,
                    width = width,
                    height = height,
                ),
            )
            // The type declared here is the one signed into the URL, so the PUT
            // has to send the same string back. Re-deriving it would be a
            // second chance to disagree with the signature.
            attachmentApi.upload(response.uploadUrl, contentType, bytes)
            response.attachmentId
        }.getOrNull()

        _state.value = _state.value.copy(
            attachments = _state.value.attachments.map { attachment ->
                if (attachment.localId != localId) {
                    attachment
                } else {
                    attachment.copy(attachmentId = minted, failed = minted == null)
                }
            },
        )
    }

    fun removeAttachment(localId: String) {
        _state.value = _state.value.copy(
            attachments = _state.value.attachments.filterNot { it.localId == localId },
            attachmentRefusal = null,
        )
    }

    /** Read the file again and start over. The URI grant outlives the picker. */
    fun retryAttachment(localId: String) {
        val reader = files ?: return
        val attachment = _state.value.attachments.firstOrNull { it.localId == localId } ?: return
        if (!attachment.failed) return

        _state.value = _state.value.copy(
            attachments = _state.value.attachments.map {
                if (it.localId == localId) it.copy(failed = false) else it
            },
        )

        viewModelScope.launch {
            val local = reader.read(attachment.uri, _state.value.maxAttachmentBytes)
            if (local == null) {
                _state.value = _state.value.copy(
                    attachments = _state.value.attachments.map {
                        if (it.localId == localId) it.copy(failed = true) else it
                    },
                )
                return@launch
            }
            upload(
                localId,
                attachment.contentType,
                local.filename,
                local.bytes.size.toLong(),
                local.width,
                local.height,
                local.bytes,
            )
        }
    }

    fun dismissAttachmentRefusal() {
        _state.value = _state.value.copy(attachmentRefusal = null)
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
        val attachments = _state.value.attachments
        val attachmentIds = attachmentIdsFor(attachments)

        // A message may be text, attachments, or both, never neither: the same
        // rule `requireBodyOrAttachment` puts on the frame server-side. And
        // never while an upload is still running or has failed, because the
        // claim would drop that row and the picture would simply not be there.
        if (attachments.any { it.uploading || it.failed }) return false
        if (trimmed.isEmpty() && attachmentIds.isEmpty()) return false

        val nonce = UUID.randomUUID().toString()
        pending += nonce

        // The optimistic row borrows the nonce as its id, which is what makes
        // retiring it a plain filter when the broadcast arrives.
        //
        // Its attachments are drawn from the local URIs rather than from the
        // presigned GETs the server has not sent yet: the file is already on
        // the phone, and a picture that blinks out of the bubble and back in
        // when the broadcast lands is worse than one that never moves. Coil
        // loads a `content://` URI exactly as happily as an https one.
        val optimistic = Message(
            id = nonce,
            channelId = channelId,
            authorId = author?.id.orEmpty(),
            authorName = author?.displayName.orEmpty(),
            authorAvatarUrl = author?.avatarUrl,
            body = trimmed,
            createdAt = java.time.Instant.now().toString(),
            attachments = attachments.mapNotNull { attachment ->
                attachment.attachmentId?.let { id ->
                    Attachment(
                        id = id,
                        filename = attachment.filename,
                        contentType = attachment.contentType,
                        byteSize = attachment.byteSize,
                        url = attachment.uri,
                    )
                }
            },
        )
        _state.value = _state.value.copy(messages = _state.value.messages + optimistic)

        if (!session.realtime.sendMessage(channelId, trimmed, nonce, attachmentIds = attachmentIds)) {
            // The frame did not leave the phone. `RealtimeClient` is already
            // reconnecting; the row is dropped rather than left looking sent,
            // because a message that silently never arrives is the failure this
            // whole path exists to avoid. The attachments stay in the composer:
            // they are uploaded and still claimable, so a retry costs nothing.
            pending -= nonce
            _state.value = _state.value.copy(
                messages = _state.value.messages.filterNot { it.id == nonce },
            )
            return false
        }
        _state.value = _state.value.copy(attachments = emptyList(), attachmentRefusal = null)
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

        fun factory(
            session: SessionStore,
            channelId: String,
            files: AttachmentFiles? = null,
        ) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ChatViewModel(session, channelId, files) as T
        }
    }
}
