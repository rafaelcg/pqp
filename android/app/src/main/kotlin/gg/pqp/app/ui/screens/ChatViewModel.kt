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
import kotlinx.coroutines.Job
import kotlinx.coroutines.delay
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
import kotlinx.serialization.json.longOrNull

/**
 * Why a `message-create` never became a broadcast, as `messageRejectReasonSchema`
 * spells it. Hand-copied like every other wire literal in this module and
 * pinned by `WireProtocolTest`, because a token this client does not know is a
 * refusal it can only describe as "failed to send".
 */
enum class MessageRejectReason(val wire: String) {
    RateLimited("rate-limited"),
    NoAccess("no-access"),
    CannotSend("cannot-send"),
    /**
     * Deliberately vague on the wire. A blocked DM answers with this token and
     * nothing more specific, so a client must not paint it as anything but
     * "not delivered" either: naming the block would make it an oracle.
     */
    Undeliverable("undeliverable"),
    SlowMode("slow-mode"),
    ;

    companion object {
        fun fromWire(token: String?): MessageRejectReason? = entries.firstOrNull { it.wire == token }
    }
}

/**
 * The server's answer to a send that did not land, for the composer to say.
 *
 * Two shapes because the server has two frames for it. `message-rejected`
 * carries a machine token this client translates; `sanction-notice` carries
 * the whole sentence, already written and already in the person's language,
 * and is shown verbatim for the same reason `voice-moderation` is.
 */
sealed class SendRefusal {
    /** `reason` is null for a token this build has never heard of. The row still comes down. */
    data class Rejected(val reason: MessageRejectReason?) : SendRefusal()

    data class Sanctioned(val message: String) : SendRefusal()
}

data class ChatState(
    val messages: List<Message> = emptyList(),
    val loading: Boolean = true,
    val hasMore: Boolean = false,
    val loadingOlder: Boolean = false,
    val typing: Set<String> = emptySet(),
    val error: String? = null,
    /**
     * The channel's slow mode in seconds, 0 when off. Carried in from the
     * channel list so the composer can count down from the moment a message
     * leaves, rather than from the moment the server says no.
     */
    val slowmodeSeconds: Int = 0,
    /**
     * Why the last send did not land, or null. Cleared by the next send that
     * leaves the phone and, for a wait, by the wait ending.
     */
    val sendRefusal: SendRefusal? = null,
    /**
     * `SystemClock.elapsedRealtime()` before which the composer must not send,
     * or 0. This is slow mode as the composer sees it: a countdown that starts
     * on a successful send and is corrected by `retryAfterMs` when the server
     * disagrees about how long is left.
     */
    val sendHoldUntilMs: Long = 0L,
    /**
     * Text the server refused, handed back to the composer once.
     *
     * The optimistic row is the only place the words lived after the box was
     * cleared, and that row is coming down. The screen copies this into the
     * draft and calls [ChatViewModel.draftRestored], which is what makes it a
     * one-shot hand-off rather than a second source of truth for the box.
     */
    val restoredDraft: String? = null,
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
 * optimistic row. There is no ack. There is a refusal: since PR #204 the server
 * answers a create it will not land with `message-rejected`, addressed to the
 * sender only and echoing the same nonce, and a timed-out sender gets a
 * `sanction-notice` instead. A malformed frame is still dropped in silence,
 * so a row can still sit pending forever, but only for a bug in this client.
 * For a long time this class had no branch for either refusal, and a message
 * the server refused looked sent, on this phone, until the app was restarted.
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
    /** The channel's slow mode, 0 when off or unknown. See [ChatState.slowmodeSeconds]. */
    slowmodeSeconds: Int = 0,
) : ViewModel() {

    private val attachmentApi = AttachmentApi(session.api)

    private val _state = MutableStateFlow(ChatState(slowmodeSeconds = slowmodeSeconds.coerceAtLeast(0)))
    val state: StateFlow<ChatState> = _state.asStateFlow()

    /** What a message looked like when it left, kept until the server answers. */
    private data class PendingSend(val body: String, val attachments: List<PendingAttachment>)

    /**
     * Nonces this client is still waiting to hear about, with what they carried.
     *
     * A map and not a set because a refusal hands the words back: by the time
     * `message-rejected` arrives the composer has been cleared and the
     * optimistic row is the only copy, and that row is about to be removed.
     * Insertion-ordered, so the newest pending send is the last entry.
     */
    private val pending = linkedMapOf<String, PendingSend>()

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
                "reaction-broadcast" -> onReaction(frame)
                "typing-broadcast" -> onTyping(frame)
                "message-rejected" -> onRejected(frame)
                "sanction-notice" -> onSanctioned(frame)
            }
        }
    }

    private fun onBroadcast(frame: JsonObject) {
        val message = frame.message() ?: return
        if (message.channelId != channelId) return
        val nonce = frame.string("nonce")

        val current = _state.value.messages
        val withoutOptimistic = if (nonce != null && pending.remove(nonce) != null) {
            current.filterNot { it.id == nonce }
        } else {
            current
        }
        if (withoutOptimistic.any { it.id == message.id }) return
        _state.value = _state.value.copy(messages = withoutOptimistic + message)
    }

    /**
     * The server refused a `message-create` of ours.
     *
     * Three things happen, and the order is the point. The optimistic row comes
     * down, because a bubble that stays is a message the person believes was
     * sent. The words go back to the composer, because that row was the only
     * copy of them. And the reason goes on the composer in plain language,
     * because "that did not work" is the sentence this frame exists to replace.
     *
     * A wait (`rate-limited`, `slow-mode`) is taken from `retryAfterMs` when
     * the server says how long, and from the channel's slow mode when it does
     * not. A permanent refusal cancels a countdown that this same send started,
     * since there is no point waiting to be refused again for the same reason.
     *
     * Guarded to this channel like every broadcast: the subscription is per
     * connection and a refusal for the chat that was on screen a second ago
     * still arrives here.
     */
    private fun onRejected(frame: JsonObject) {
        if (frame.string("channelId") != channelId) return
        val nonce = frame.string("nonce")
        val reason = MessageRejectReason.fromWire(frame.string("reason"))
        val retryAfterMs = (frame["retryAfterMs"] as? JsonPrimitive)?.longOrNull ?: 0L

        val sent = nonce?.let { pending.remove(it) }
        retireAndRestore(listOfNotNull(nonce), sent, SendRefusal.Rejected(reason))

        val waitMs = when (reason) {
            MessageRejectReason.RateLimited -> retryAfterMs
            MessageRejectReason.SlowMode ->
                if (retryAfterMs > 0) retryAfterMs else _state.value.slowmodeSeconds * 1_000L
            else -> 0L
        }
        if (waitMs > 0) {
            hold(nonce, waitMs)
        } else if (nonce != null && nonce == holdNonce) {
            clearHold()
        }
    }

    /**
     * A moderator's timeout, told to the sender on the send it stopped.
     *
     * The server drops every `message-create` from a timed-out person and
     * answers with this frame instead of `message-rejected`, so without a
     * branch here their bubbles sat pending forever, which the plan called out
     * (`B11`) as the one silent frame that was a moderation problem rather
     * than a missing feature. The frame names no nonce, so every row still
     * pending in this channel comes down and the newest text goes back.
     */
    private fun onSanctioned(frame: JsonObject) {
        if (frame.string("channelId") != channelId) return
        val message = frame.string("message") ?: return
        val nonces = pending.keys.toList()
        val newest = pending.values.lastOrNull()
        pending.clear()
        retireAndRestore(nonces, newest, SendRefusal.Sanctioned(message))
        clearHold()
    }

    private fun retireAndRestore(nonces: List<String>, sent: PendingSend?, refusal: SendRefusal) {
        val current = _state.value
        // Attachments are handed back too. The refusal came before the claim,
        // so the uploaded objects are still claimable and a retry costs
        // nothing; what the composer has picked since is kept alongside them.
        val attachments = if (sent == null) {
            current.attachments
        } else {
            (current.attachments + sent.attachments).distinctBy { it.localId }
        }
        _state.value = current.copy(
            messages = current.messages.filterNot { it.id in nonces },
            attachments = attachments,
            restoredDraft = sent?.body?.takeIf { it.isNotEmpty() } ?: current.restoredDraft,
            sendRefusal = refusal,
        )
    }

    /** The screen has copied [ChatState.restoredDraft] into the box. */
    fun draftRestored() {
        _state.value = _state.value.copy(restoredDraft = null)
    }

    // --- the send hold ---

    /** Which send started the running countdown, so its own refusal can end it. */
    private var holdNonce: String? = null
    private var holdJob: Job? = null

    private fun now(): Long = android.os.SystemClock.elapsedRealtime()

    /**
     * Stop the composer sending for [durationMs].
     *
     * Wall-clock free: `elapsedRealtime` cannot jump when the phone corrects
     * its clock, which would otherwise strand the composer closed for however
     * far the clock moved. The hold releases itself, and takes a wait-shaped
     * refusal with it, because "you can send again in 0s" is not a sentence.
     */
    private fun hold(nonce: String?, durationMs: Long) {
        val until = now() + durationMs
        holdNonce = nonce
        holdJob?.cancel()
        _state.value = _state.value.copy(sendHoldUntilMs = until)
        holdJob = viewModelScope.launch {
            delay(durationMs)
            if (_state.value.sendHoldUntilMs != until) return@launch
            val refusal = _state.value.sendRefusal
            val waitShaped = refusal is SendRefusal.Rejected &&
                (refusal.reason == MessageRejectReason.SlowMode || refusal.reason == MessageRejectReason.RateLimited)
            _state.value = _state.value.copy(
                sendHoldUntilMs = 0L,
                sendRefusal = if (waitShaped) null else refusal,
            )
            holdNonce = null
        }
    }

    private fun clearHold() {
        holdJob?.cancel()
        holdJob = null
        holdNonce = null
        _state.value = _state.value.copy(sendHoldUntilMs = 0L)
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
        val attachments = _state.value.attachments
        val attachmentIds = attachmentIdsFor(attachments)

        // A message may be text, attachments, or both, never neither: the same
        // rule `requireBodyOrAttachment` puts on the frame server-side. And
        // never while an upload is still running or has failed, because the
        // claim would drop that row and the picture would simply not be there.
        if (attachments.any { it.uploading || it.failed }) return false
        if (trimmed.isEmpty() && attachmentIds.isEmpty()) return false
        // Nor while slow mode is counting down. The server would answer with a
        // `message-rejected` anyway; refusing here keeps the words in the box
        // instead of taking them on a round trip to come back.
        if (_state.value.sendHoldUntilMs > now()) return false

        val nonce = UUID.randomUUID().toString()
        pending[nonce] = PendingSend(trimmed, attachments)

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
        _state.value = _state.value.copy(
            attachments = emptyList(),
            attachmentRefusal = null,
            sendRefusal = null,
            restoredDraft = null,
        )
        // Slow mode starts counting when the message leaves, the way the web
        // composer does it, so the person sees the wait before the server has
        // to refuse anything. `retryAfterMs` on a refusal corrects it if the
        // two clocks disagree. The one cost: this client knows nothing about
        // permissions, so a member with Manage Messages, whom the server lets
        // through, waits here too. That is the honest price of a countdown
        // that is right for everybody else, until permissions reach Android.
        val slowmode = _state.value.slowmodeSeconds
        if (slowmode > 0) hold(nonce, slowmode * 1_000L)
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

        /**
         * Whole seconds left on a hold, rounded up, and 0 once it has passed.
         *
         * Up rather than down because the number is a promise: "1s" that turns
         * into a refusal because 400ms were truncated is the countdown lying.
         * Pure, like [shouldSendTyping], so the one rule here has a test.
         */
        internal fun remainingWaitSeconds(untilMs: Long, nowMs: Long): Int {
            val left = untilMs - nowMs
            if (left <= 0L) return 0
            return ((left + 999L) / 1_000L).toInt()
        }

        fun factory(
            session: SessionStore,
            channelId: String,
            files: AttachmentFiles? = null,
            slowmodeSeconds: Int = 0,
        ) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ChatViewModel(session, channelId, files, slowmodeSeconds) as T
        }
    }
}
