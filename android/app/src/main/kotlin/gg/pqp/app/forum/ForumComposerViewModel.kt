package gg.pqp.app.forum

import android.os.SystemClock
import androidx.lifecycle.ViewModel
import androidx.lifecycle.ViewModelProvider
import androidx.lifecycle.viewModelScope
import gg.pqp.app.attachments.AttachmentApi
import gg.pqp.app.attachments.AttachmentConfig
import gg.pqp.app.attachments.AttachmentFiles
import gg.pqp.app.attachments.AttachmentRefusal
import gg.pqp.app.attachments.ComposerReadiness
import gg.pqp.app.attachments.CreateAttachmentRequest
import gg.pqp.app.attachments.PendingAttachment
import gg.pqp.app.attachments.attachmentIdsFor
import gg.pqp.app.attachments.composerReadiness
import gg.pqp.app.attachments.refuseAttachment
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.Permission
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import java.util.UUID
import gg.pqp.app.core.SessionPhase
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.Job
import kotlinx.coroutines.async
import kotlinx.coroutines.channels.Channel
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.receiveAsFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive
import kotlinx.serialization.json.longOrNull

/** Why "Publicar" did not publish, in the composer's own words. */
sealed interface ForumComposerError {
    data object TitleRequired : ForumComposerError
    data object BodyRequired : ForumComposerError
    data object TagRequired : ForumComposerError
    data object Uploading : ForumComposerError

    /** Slow mode on the forum: "Espera {seconds}s", counted down on the button. */
    data class SlowMode(val untilMs: Long) : ForumComposerError

    /** The post bucket (5 per 10 minutes). */
    data class RateLimited(val minutes: Int) : ForumComposerError

    /** AutoMod refused the title or the body; [message] is the rule's own words. */
    data class Automod(val message: String?, val field: String? = null) : ForumComposerError

    /** No SEND_MESSAGES here, or a timeout: the server's own sentence when it has one. */
    data class CannotPost(val message: String?) : ForumComposerError

    /** The flag went off while composing. */
    data object Paused : ForumComposerError

    /** The network, or anything else: the draft stays, try again. */
    data object Failed : ForumComposerError
}

data class ForumComposerState(
    val title: String = "",
    val body: String = "",
    val tagIds: List<String> = emptyList(),
    val tags: List<ForumTag> = emptyList(),
    val requireTag: Boolean = false,
    val isStaff: Boolean = false,
    val attachmentsEnabled: Boolean = false,
    val maxAttachmentBytes: Long = gg.pqp.app.attachments.DEFAULT_MAX_ATTACHMENT_BYTES,
    val attachments: List<PendingAttachment> = emptyList(),
    val attachmentRefusal: AttachmentRefusal? = null,
    /** "Posts parecidos": the last answer, kept (dimmed) while the next one loads. */
    val similar: List<ForumPostSummary> = emptyList(),
    val similarLoading: Boolean = false,
    val publishing: Boolean = false,
    val error: ForumComposerError? = null,
    /** A draft from an earlier visit was put back ("Rascunho recuperado"). */
    val draftRestored: Boolean = false,
) {
    /** Members never see a staff-only tag in the composer. */
    val offeredTags: List<ForumTag> get() = if (isStaff) tags else tags.filterNot { it.moderated }

    val titleMissing: Boolean get() = title.isBlank()
    /**
     * Only while there is a tag this person could pick: a rule nobody can meet
     * (no tags yet, only staff-only ones for a member, a tags read that failed)
     * must not hold Publicar. The server applies the same rule and refuses
     * with `TagRequired` when it does bind.
     */
    val tagMissing: Boolean get() = requireTag && offeredTags.isNotEmpty() && tagIds.isEmpty()

    /** "Exigir tag" is on and there is nothing to pick: the composer says it can go without. */
    val tagsNoneToPick: Boolean get() = requireTag && offeredTags.isEmpty()
    val readiness: ComposerReadiness get() = composerReadiness(body, attachments)

    /** Publicar is enabled; the reason it is not is written under the field (UX §2.5 #37). */
    val canPublish: Boolean
        get() = !publishing && !titleMissing && !tagMissing && readiness == ComposerReadiness.Ready
}

/**
 * "Novo post" (UX §2.5): title, the posts that look like it, the details, the
 * tags, files. Publishing is not optimistic: the server is the authority
 * (AutoMod, slow mode, the post bucket), so the button says "Publicando…" and
 * the post opens once it exists.
 *
 * Files are minted against the FORUM id, because there is no post yet; the
 * create re-homes them to the post (`createForumPostSchema`).
 */
class ForumComposerViewModel(
    private val session: SessionStore,
    private val prefs: ForumPrefs?,
    private val serverId: String,
    private val forumId: String,
    private val files: AttachmentFiles?,
    /** A title to start from: "Postar \"steam deck\"" from an empty search. */
    initialTitle: String?,
) : ViewModel() {

    private val attachmentApi = AttachmentApi(session.api)

    private val _state = MutableStateFlow(ForumComposerState())
    val state: StateFlow<ForumComposerState> = _state.asStateFlow()

    /**
     * The new post, once: the screen opens it. A channel, not a shared flow,
     * so an answer that lands while the screen is stopped waits for it
     * instead of being dropped (and the composer staying open on a post that
     * already exists).
     */
    private val _published = Channel<ForumPostSummary>(Channel.BUFFERED)
    val published: Flow<ForumPostSummary> = _published.receiveAsFlow()

    /**
     * Drafts and the pending nonce are this account's, in this forum: see
     * [ForumPrefs]. Read once; the composer never outlives its account.
     */
    private val draftKey: String =
        "${(session.phase.value as? SessionPhase.Ready)?.me?.id ?: "anon"}.$forumId"

    /**
     * One nonce per post, kept across retries (and across a composer closed
     * mid-request, through [ForumPrefs]) so a lost answer cannot make two.
     */
    private var nonce = prefs?.pendingNonce(draftKey) ?: UUID.randomUUID().toString()

    /** At most this many picked files are read into memory at once. */
    private val reads = Semaphore(ATTACH_READS)

    /** Picks reserved but not yet on the strip, so a batch cannot pass the cap. */
    private var reserved = 0
    private var similarJob: Job? = null
    private var draftJob: Job? = null

    /** The post went out; nothing is saved as a draft after this. */
    private var posted = false

    init {
        val draft = prefs?.draft(draftKey)
        val title = initialTitle?.trim()?.takeIf { it.isNotEmpty() }
        _state.value = when {
            title != null -> ForumComposerState(
                title = title.take(ForumLimits.TITLE_MAX),
                body = draft?.body.orEmpty(),
                tagIds = draft?.tagIds.orEmpty(),
            )
            draft != null -> ForumComposerState(
                title = draft.title,
                body = draft.body,
                tagIds = draft.tagIds,
                draftRestored = true,
            )
            else -> ForumComposerState()
        }
        viewModelScope.launch { loadContext() }
        viewModelScope.launch { followConfig() }
        if (_state.value.title.length >= SIMILAR_MIN_CHARS) searchSimilar(_state.value.title)
    }

    private suspend fun loadContext() = coroutineScope {
        // Four independent reads side by side: the composer is ready at the
        // slowest one's latency, not at their sum.
        val tagsAsync = async { runCatching { session.api.forumTags(forumId) }.getOrNull() }
        val settingsAsync = async { runCatching { session.api.forumSettings(forumId) }.getOrNull() }
        val configAsync = async {
            if (files != null) {
                runCatching { attachmentApi.config(serverId) }.getOrDefault(AttachmentConfig())
            } else {
                AttachmentConfig()
            }
        }
        val snapshotAsync = async { runCatching { session.api.serverPermissions(serverId) }.getOrNull() }
        // The flag is operator data, flipped with no deploy and with no frame:
        // ask as a post starts, so a pause shows before the whole post is
        // written. A failed read says nothing (the server refuses anyway).
        val flagAsync = async { runCatching { session.api.forumConfig(serverId) }.getOrNull() }
        val tags = tagsAsync.await()
        val settings = settingsAsync.await()
        val config = configAsync.await()
        val snapshot = snapshotAsync.await()
        val bits = snapshot?.channelBits(forumId) ?: 0L
        val known = tags.orEmpty().map { it.id }.toSet()
        _state.value = _state.value.copy(
            tags = tags.orEmpty().sortedBy { it.position },
            // A tag a saved draft named that the forum has since dropped goes.
            tagIds = if (tags == null) _state.value.tagIds else _state.value.tagIds.filter { it in known },
            requireTag = settings?.requireTag ?: false,
            isStaff = hasPermission(bits, Permission.MANAGE_MESSAGES) || hasPermission(bits, Permission.MANAGE_CHANNELS),
            attachmentsEnabled = config.enabled,
            maxAttachmentBytes = config.maxBytes,
            error = if (flagAsync.await()?.enabled == false) ForumComposerError.Paused else _state.value.error,
        )
    }

    /**
     * Staff saved the forum's tags or settings while this composer is open:
     * the tag list and "Exigir pelo menos uma tag" follow now. A tag that
     * was picked and is gone leaves the pick, or Publicar would send a tag
     * that no longer exists.
     */
    private suspend fun followConfig() {
        session.realtime.frames.collect { frame ->
            val update = ForumConfigUpdate.decode(frame)?.takeIf { it.forumId == forumId } ?: return@collect
            _state.value = applyConfig(_state.value, update)
        }
    }

    fun setTitle(value: String) {
        // One line, capped; the counter stops at 100 and so does the field.
        val title = value.replace('\n', ' ').take(ForumLimits.TITLE_MAX)
        if (title == _state.value.title) return
        _state.value = _state.value.copy(
            title = title,
            error = _state.value.error.takeUnless { it is ForumComposerError.TitleRequired || it is ForumComposerError.Automod },
        )
        saveDraftSoon()
        searchSimilar(title)
    }

    fun setBody(value: String) {
        val body = value.take(ForumLimits.BODY_MAX)
        if (body == _state.value.body) return
        _state.value = _state.value.copy(
            body = body,
            error = _state.value.error.takeUnless { it is ForumComposerError.BodyRequired },
        )
        saveDraftSoon()
    }

    /** At most five; a sixth tap does nothing and the counter reads 5/5. */
    fun toggleTag(tagId: String) {
        val current = _state.value.tagIds
        val next = when {
            tagId in current -> current - tagId
            current.size >= ForumLimits.MAX_TAGS_PER_POST -> return
            else -> current + tagId
        }
        _state.value = _state.value.copy(
            tagIds = next,
            error = _state.value.error.takeUnless { it is ForumComposerError.TagRequired },
        )
        saveDraftSoon()
    }

    /**
     * "Posts parecidos": after four characters, 300 ms after typing stops.
     * Loading keeps the last answer (dimmed by the screen); a failure clears
     * the box silently. It never blocks publishing.
     */
    private fun searchSimilar(title: String) {
        similarJob?.cancel()
        val query = title.trim()
        if (query.length < SIMILAR_MIN_CHARS) {
            _state.value = _state.value.copy(similar = emptyList(), similarLoading = false)
            return
        }
        similarJob = viewModelScope.launch {
            delay(SIMILAR_DEBOUNCE_MS)
            _state.value = _state.value.copy(similarLoading = true)
            val found = runCatching { session.api.similarForumPosts(forumId, query) }.getOrNull()
            _state.value = _state.value.copy(
                similar = found.orEmpty().take(ForumLimits.SIMILAR_MAX),
                similarLoading = false,
            )
        }
    }

    private fun saveDraftSoon() {
        val store = prefs ?: return
        draftJob?.cancel()
        draftJob = viewModelScope.launch {
            delay(DRAFT_DEBOUNCE_MS)
            val s = _state.value
            store.saveDraft(draftKey, ForumDraft(s.title, s.body, s.tagIds))
        }
    }

    /** Closing keeps the draft (never asks); this is the button that throws it away. */
    fun discard() {
        draftJob?.cancel()
        prefs?.clearDraft(draftKey)
        prefs?.clearPendingNonce(draftKey)
        nonce = UUID.randomUUID().toString()
        _state.value = _state.value.copy(title = "", body = "", tagIds = emptyList(), attachments = emptyList(), similar = emptyList(), error = null, draftRestored = false)
    }

    /** Write the draft now (the screen is closing). */
    fun saveDraftNow() {
        val store = prefs ?: return
        draftJob?.cancel()
        val s = _state.value
        store.saveDraft(draftKey, ForumDraft(s.title, s.body, s.tagIds))
    }

    fun dismissError() {
        _state.value = _state.value.copy(error = null)
    }

    fun draftRestoredSeen() {
        _state.value = _state.value.copy(draftRestored = false)
    }

    // --- files ---

    fun attach(uri: String) {
        val reader = files ?: return
        val current = _state.value
        if (!current.attachmentsEnabled) return
        // The slot is taken before the file is read, so a batch of picks past
        // the cap is refused up front instead of read into memory first.
        if (current.attachments.size + reserved >= gg.pqp.app.attachments.MAX_ATTACHMENTS_PER_MESSAGE) {
            _state.value = current.copy(attachmentRefusal = AttachmentRefusal.TooMany)
            return
        }
        reserved += 1
        val localId = UUID.randomUUID().toString()
        _state.value = current.copy(attachmentRefusal = null)
        viewModelScope.launch {
            // Two files in hand at a time, read through upload: the bytes are
            // only let go once the PUT is done with them.
            reads.withPermit { ingest(reader, uri, localId, current.maxAttachmentBytes) }
        }
    }

    private suspend fun ingest(reader: AttachmentFiles, uri: String, localId: String, maxBytes: Long) {
        run {
            val local = try {
                reader.read(uri, maxBytes)
            } finally {
                reserved -= 1
            }
            if (local == null) {
                _state.value = _state.value.copy(attachmentRefusal = AttachmentRefusal.Unreadable)
                return
            }
            val size = local.bytes.size.toLong()
            refuseAttachment(local.contentType, size, _state.value.maxAttachmentBytes, _state.value.attachments.size)
                ?.let { refusal ->
                    _state.value = _state.value.copy(attachmentRefusal = refusal)
                    return
                }
            val contentType = local.contentType!!
            _state.value = _state.value.copy(
                attachments = _state.value.attachments + PendingAttachment(
                    localId = localId,
                    uri = uri,
                    filename = local.filename,
                    contentType = contentType,
                    byteSize = size,
                ),
            )
            val minted = runCatching {
                val response = attachmentApi.mint(
                    forumId,
                    CreateAttachmentRequest(
                        filename = local.filename,
                        contentType = contentType,
                        byteSize = size,
                        width = local.width,
                        height = local.height,
                    ),
                )
                attachmentApi.upload(response.uploadUrl, contentType, local.bytes)
                response.attachmentId
            }.getOrNull()
            _state.value = _state.value.copy(
                attachments = _state.value.attachments.map {
                    if (it.localId == localId) it.copy(attachmentId = minted, failed = minted == null) else it
                },
            )
        }
    }

    fun removeAttachment(localId: String) {
        _state.value = _state.value.copy(
            attachments = _state.value.attachments.filterNot { it.localId == localId },
            attachmentRefusal = null,
        )
    }

    fun dismissAttachmentRefusal() {
        _state.value = _state.value.copy(attachmentRefusal = null)
    }

    // --- publish ---

    fun publish() {
        val s = _state.value
        if (s.publishing) return
        val missing = when {
            s.titleMissing -> ForumComposerError.TitleRequired
            s.tagMissing -> ForumComposerError.TagRequired
            s.readiness == ComposerReadiness.Uploading -> ForumComposerError.Uploading
            s.readiness != ComposerReadiness.Ready -> ForumComposerError.BodyRequired
            else -> null
        }
        if (missing != null) {
            _state.value = s.copy(error = missing)
            return
        }
        val hold = s.error as? ForumComposerError.SlowMode
        if (hold != null && hold.untilMs > SystemClock.elapsedRealtime()) return
        _state.value = s.copy(publishing = true, error = null)
        viewModelScope.launch {
            val request = CreateForumPostRequest(
                title = s.title.replace(Regex("\\s+"), " ").trim(),
                body = s.body,
                tagIds = s.tagIds.takeIf { it.isNotEmpty() },
                attachmentIds = attachmentIdsFor(s.attachments).takeIf { it.isNotEmpty() },
                nonce = nonce,
            )
            // Written down before the request leaves: if the composer is closed
            // mid-flight the server may still make the post, and the next try
            // from the restored draft must be the same post, not a second one.
            prefs?.savePendingNonce(draftKey, nonce)
            runCatching { session.api.createForumPost(forumId, request) }
                .onSuccess { created ->
                    draftJob?.cancel()
                    prefs?.clearDraft(draftKey)
                    prefs?.clearPendingNonce(draftKey)
                    posted = true
                    nonce = UUID.randomUUID().toString()
                    _state.value = _state.value.copy(publishing = false)
                    _published.trySend(created.post)
                }
                .onFailure { failure ->
                    if (failure is CancellationException) throw failure
                    val error = errorFor(failure)
                    // A decision about the post (AutoMod, a missing tag) is
                    // final for this nonce; a wait or a dropped connection is
                    // the same post tried again.
                    if (error !is ForumComposerError.Failed && error !is ForumComposerError.SlowMode &&
                        error !is ForumComposerError.RateLimited
                    ) {
                        nonce = UUID.randomUUID().toString()
                        prefs?.clearPendingNonce(draftKey)
                    }
                    _state.value = _state.value.copy(publishing = false, error = error)
                    rereadRules(error)
                }
        }
    }

    /** The server refused for a rule this screen held stale: read it again. */
    private fun rereadRules(error: ForumComposerError) {
        if (error != ForumComposerError.TagRequired) return
        viewModelScope.launch {
            runCatching { session.api.forumSettings(forumId) }.getOrNull()?.let { fresh ->
                _state.value = _state.value.copy(requireTag = fresh.requireTag)
            }
        }
    }

    private fun errorFor(failure: Throwable): ForumComposerError {
        val api = failure as? ApiException ?: return ForumComposerError.Failed
        val body = api.body
        fun field(key: String) = runCatching { body?.get(key)?.jsonPrimitive?.contentOrNull }.getOrNull()
        val retryAfterMs = runCatching { body?.get("retryAfterMs")?.jsonPrimitive?.longOrNull }.getOrNull() ?: 0L
        return when {
            api.serverMessage == ForumErrors.OFF -> ForumComposerError.Paused
            api.serverMessage == ForumErrors.TAG_REQUIRED -> ForumComposerError.TagRequired
            api.serverMessage == ForumErrors.POST_REJECTED -> when (field("reason")) {
                "slow-mode" -> ForumComposerError.SlowMode(
                    SystemClock.elapsedRealtime() + retryAfterMs.coerceAtLeast(1_000L),
                )
                "rate-limited" -> ForumComposerError.RateLimited(
                    ((retryAfterMs + 59_999L) / 60_000L).toInt().coerceAtLeast(1),
                )
                "automod" -> automodError(body)
                "no-access", "cannot-send" -> ForumComposerError.CannotPost(null)
                else -> ForumComposerError.Failed
            }
            api.status == 403 -> ForumComposerError.CannotPost(api.serverMessage)
            api.status == 429 -> ForumComposerError.RateLimited(
                ((retryAfterMs + 59_999L) / 60_000L).toInt().coerceAtLeast(1),
            )
            else -> ForumComposerError.Failed
        }
    }

    override fun onCleared() {
        // Closing never asks; the draft is simply still here next time. A
        // post that went out leaves nothing behind.
        if (!posted) saveDraftNow()
    }

    companion object {
        /** The 422 body of an AutoMod refusal: the rule's words, and which half it refused. */
        internal fun automodError(body: kotlinx.serialization.json.JsonObject?): ForumComposerError.Automod {
            fun text(key: String) = runCatching { body?.get(key)?.jsonPrimitive?.contentOrNull }.getOrNull()
            return ForumComposerError.Automod(
                message = text("automodMessage")?.takeIf { it.isNotBlank() },
                field = text("field")?.takeIf { it == "title" || it == "body" },
            )
        }

        /** A saved tags/settings frame applied to the composer's state. */
        internal fun applyConfig(state: ForumComposerState, update: ForumConfigUpdate): ForumComposerState {
            val tags = update.tags?.sortedBy { it.position } ?: state.tags
            val known = tags.map { it.id }.toSet()
            return state.copy(
                tags = tags,
                tagIds = if (update.tags == null) state.tagIds else state.tagIds.filter { it in known },
                requireTag = update.settings?.requireTag ?: state.requireTag,
            )
        }

        private const val SIMILAR_MIN_CHARS = 4
        private const val ATTACH_READS = 2
        private const val SIMILAR_DEBOUNCE_MS = 300L
        private const val DRAFT_DEBOUNCE_MS = 400L

        fun factory(
            session: SessionStore,
            prefs: ForumPrefs,
            serverId: String,
            forumId: String,
            files: AttachmentFiles?,
            initialTitle: String?,
        ) = object : ViewModelProvider.Factory {
            @Suppress("UNCHECKED_CAST")
            override fun <T : ViewModel> create(modelClass: Class<T>): T =
                ForumComposerViewModel(session, prefs, serverId, forumId, files, initialTitle) as T
        }
    }
}
