package gg.pqp.app.stories

import android.content.Context
import android.net.ConnectivityManager
import android.net.Network
import android.net.NetworkCapabilities
import android.net.Uri
import android.util.Log
import android.widget.Toast
import gg.pqp.app.R
import gg.pqp.app.core.ApiException
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.editor.CallLayer
import gg.pqp.app.stories.editor.EditorLayer
import gg.pqp.app.stories.editor.EditorPost
import gg.pqp.app.stories.editor.InkLayer
import gg.pqp.app.stories.editor.InkRenderer
import gg.pqp.app.stories.editor.LayerFile
import gg.pqp.app.stories.editor.LayerOps
import gg.pqp.app.stories.editor.PhotoLayer
import gg.pqp.app.stories.editor.TextLayer
import java.io.File
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.async
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.delay
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit
import kotlinx.coroutines.withContext
import kotlinx.coroutines.withTimeoutOrNull

/** Everything the composer hands over at "Postar": the state of the editor, not a request yet. */
class StoryPostInput(
    val userId: String,
    val media: PreparedMedia?,
    val muted: Boolean,
    /** The clip with its sound already taken out, when the composer made it. */
    val mutedUri: Uri?,
    val cardBackground: String,
    val layers: List<EditorLayer>,
    val layerFiles: Map<String, LayerFile>,
    val layersEnabled: Boolean,
    val replies: Boolean,
    val audience: StoryAudienceTargets,
    val maxBytes: Long,
    val refreshKeys: List<String>,
    /** Files already on their way ahead of the story, by file key: the outbox waits for them and claims them. */
    val eager: Map<String, EagerUpload> = emptyMap(),
)

/**
 * Posting a story without making the person wait for it.
 *
 * "Postar" hands the post to this and the composer closes at once. From there
 * it is the outbox's: it makes the files and the request ready, writes them to
 * disk as a draft, creates the story, PUTs every file with a running count the
 * own ring draws, and publishes. App-scoped on purpose, like `SocialRepository`
 * and the voice controller: leaving the composer, the screen or the app does
 * not touch it.
 *
 * A failure does not throw the post away. The draft stays on disk, the ring
 * shows it failed, and "Tentar de novo" resends exactly the same request (same
 * request id, so a lost answer never posts it twice). "Descartar" is the only
 * way a draft that has not been posted goes away, besides signing out. A draft
 * found on disk when the app starts (the process died mid-post) comes back
 * failed, to be retried by hand: nothing posts on its own after a restart.
 */
class StoryOutbox(
    private val appContext: Context,
    private val session: SessionStore,
    private val store: StoriesStore,
    private val scope: CoroutineScope,
    root: File,
) {
    private val drafts = StoryDraftStore(root)
    private val gate = Semaphore(UPLOADS_AT_ONCE)
    private val jobs = ConcurrentHashMap<String, Job>()

    /** Eager uploads, shared with the composer that starts them and the outbox that claims them. */
    val eager = StoryEagerUploads(appContext, session, scope)

    /** The eager uploads each post was handed, until it is live or discarded. */
    private val eagers = ConcurrentHashMap<String, Map<String, EagerUpload>>()

    /** The story the server minted for a draft, so discarding a half-sent one takes it down now instead of at the sweep. */
    private val minted = ConcurrentHashMap<String, String>()

    /** In-memory inputs while a post is still being made ready, so a retry before the draft exists can redo it. */
    private val pendingInputs = ConcurrentHashMap<String, StoryPostInput>()

    private val _entries = MutableStateFlow<List<StoryOutboxRules.Entry>>(emptyList())
    val entries: StateFlow<List<StoryOutboxRules.Entry>> = _entries.asStateFlow()

    /** Posts that were already tried again by themselves once since they last waited: the second failure is red. */
    private val autoRetried = ConcurrentHashMap.newKeySet<String>()

    init {
        scope.launch { followSession() }
        watchConnection()
    }

    /** Whether the phone has a connection that reaches the internet right now. */
    private fun online(): Boolean {
        val manager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return true
        val caps = manager.getNetworkCapabilities(manager.activeNetwork) ?: return false
        return caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_INTERNET) &&
            caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)
    }

    /** The moment a usable connection is back, the posts that were waiting for one go on. */
    private fun watchConnection() {
        val manager = appContext.getSystemService(Context.CONNECTIVITY_SERVICE) as? ConnectivityManager ?: return
        runCatching {
            manager.registerDefaultNetworkCallback(object : ConnectivityManager.NetworkCallback() {
                override fun onAvailable(network: Network) = retryWaiting()

                override fun onCapabilitiesChanged(network: Network, capabilities: NetworkCapabilities) {
                    if (capabilities.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) retryWaiting()
                }
            })
        }
    }

    /**
     * Send every post that is waiting for a connection, if there is one now. Called when the connection comes back
     * and whenever the app comes to the front.
     */
    fun retryWaiting() {
        if (!online()) return
        _entries.value.filter { it.status == StoryOutboxRules.Status.Waiting }.forEach { retry(it.id) }
    }

    /** The post is the outbox's from this call on. Returns at once; the composer can close. */
    fun enqueue(input: StoryPostInput): String {
        val id = UUID.randomUUID().toString()
        pendingInputs[id] = input
        eagers[id] = matching(input)
        setEntry(id, StoryOutboxRules.Status.Preparing, null)
        launch(id) {
            // Read from the map, not captured: once the draft is on disk the editor's buffers can go.
            val draft = withContext(Dispatchers.IO) { prepare(id, pendingInputs.getValue(id)) }
            pendingInputs.remove(id)
            upload(draft)
        }
        return id
    }

    /**
     * Of the uploads handed over, the ones that are exactly what this post sends: the base the person picked (not a
     * clip made over since), the photo layer's own file, the drawing as it is now. The rest are thrown away here.
     */
    private fun matching(input: StoryPostInput): Map<String, EagerUpload> {
        val strokes = input.layers.filterIsInstance<InkLayer>().associate { it.id to it.strokes }
        val keep = input.eager.filter { (key, handle) ->
            when {
                key == DraftFile.BASE -> input.media != null && handle.tag === input.media && !(input.muted && input.media.isVideo)
                else -> handle.tag === input.layerFiles[key] || (strokes[key] != null && handle.tag == strokes[key])
            }
        }
        input.eager.filterKeys { it !in keep }.values.forEach(eager::discard)
        return keep
    }

    /** Send a failed draft again, the same request. */
    fun retry(id: String) {
        // A post that is working is left alone. One that has just reported it cannot go on (waiting, failed) is not
        // working, even if the job that reported it is still on its way out.
        val status = _entries.value.firstOrNull { it.id == id }?.status
        val working = status == StoryOutboxRules.Status.Preparing || status == StoryOutboxRules.Status.Uploading
        if (jobs[id]?.isActive == true && working) return
        setEntry(id, StoryOutboxRules.Status.Uploading, null)
        launch(id) {
            val input = pendingInputs[id]
            val draft = if (input != null) {
                withContext(Dispatchers.IO) { prepare(id, input) }.also { pendingInputs.remove(id) }
            } else {
                drafts.list().firstOrNull { it.id == id }
                    // Not listed but still on disk (a read that failed for now): it stays, failed, to be tried again.
                    ?: return@launch if (drafts.exists(id)) setEntry(id, StoryOutboxRules.Status.Failed, null) else removeEntry(id)
            }
            upload(draft)
        }
    }

    /** The person gave up on it: stop sending, forget the draft and its files. */
    fun discard(id: String) {
        val job = jobs.remove(id)
        pendingInputs.remove(id)
        // Eager uploads nobody will claim: stopped, and the server told (it sweeps the ones this misses).
        eagers.remove(id)?.values?.forEach(eager::discard)
        // After the job has stopped, so a draft still being written cannot come back after the delete.
        scope.launch(Dispatchers.IO) {
            job?.cancelAndJoin()
            drafts.list().firstOrNull { it.id == id }?.let { eager.deleteIds(it.uploadIds.values) }
            drafts.delete(id)
        }
        minted.remove(id)?.let { storyId -> scope.launch { runCatching { session.api.deleteStory(storyId) } } }
        removeEntry(id)
    }

    /** Drafts a previous run of the app left on disk come back as failed ones, once the account is known. */
    private fun restore(userId: String) {
        val found = drafts.list()
        found.filter { it.userId != userId }.forEach { drafts.delete(it.id) }
        found.filter { it.userId == userId && _entries.value.none { e -> e.id == it.id } }.forEach {
            // What stopped it is not known: it waits, and goes on by itself (red only if that fails).
            setEntry(it.id, StoryOutboxRules.Status.Waiting, null)
        }
        retryWaiting()
    }

    private suspend fun followSession() {
        session.phase.collect { phase ->
            when (phase) {
                is SessionPhase.Ready -> withContext(Dispatchers.IO) { restore(phase.me.id) }
                // Somebody else may sign in next on this phone: a story is never posted as them.
                is SessionPhase.SignedOut -> {
                    jobs.values.forEach { it.cancel() }
                    jobs.clear()
                    pendingInputs.clear()
                    eagers.values.forEach { it.values.forEach(eager::discard) }
                    eagers.clear()
                    withContext(Dispatchers.IO) { drafts.list().forEach { drafts.delete(it.id) } }
                    _entries.value = emptyList()
                }
                else -> Unit
            }
        }
    }

    private fun launch(id: String, block: suspend () -> Unit) {
        jobs[id]?.cancel()
        jobs[id] = scope.launch {
            try {
                block()
            } catch (e: CancellationException) {
                throw e
            } catch (e: Exception) {
                Log.w(TAG, "post $id failed: ${e.message}")
                when (StoryOutboxRules.outcome(e, online(), retriedAlready = id in autoRetried)) {
                    // No connection: grey, and it goes on by itself when one is back.
                    StoryOutboxRules.Outcome.Waiting -> {
                        autoRetried.remove(id)
                        setEntry(id, StoryOutboxRules.Status.Waiting, null)
                    }
                    // A connection but no answer: once more at once, and only a second failure is red.
                    StoryOutboxRules.Outcome.RetrySoon -> {
                        autoRetried.add(id)
                        setEntry(id, StoryOutboxRules.Status.Waiting, null)
                        delay(AUTO_RETRY_MS)
                        retry(id)
                    }
                    StoryOutboxRules.Outcome.Failed -> {
                        autoRetried.remove(id)
                        setEntry(id, StoryOutboxRules.Status.Failed, null)
                    }
                }
            }
        }
    }

    /** Make the files and the request, and keep them: from here the post survives anything. */
    private suspend fun prepare(id: String, input: StoryPostInput): StoryDraft {
        val built = StoryDraftBuilder.build(appContext, id, input)
        // Uploads that already finished go on the draft from the start: a retry, even after the process died,
        // claims them instead of sending the files again.
        val draft = built.draft.copy(uploadIds = EagerRequest.finished(eagers[id].orEmpty().values))
        drafts.write(draft, built.files)
        return draft
    }

    private suspend fun upload(draft: StoryDraft) {
        val id = draft.id
        // A draft is posted only as the person who made it: never as whoever signed in since.
        when (val phase = session.phase.value) {
            is SessionPhase.Ready -> if (phase.me.id != draft.userId) {
                // Somebody else's post: gone with everything it started (the uploads are theirs to be swept, not ours to claim).
                eagers.remove(id)?.values?.forEach(eager::discard)
                eager.deleteIds(draft.uploadIds.values)
                withContext(Dispatchers.IO) { drafts.delete(id) }
                jobs.remove(id)
                return removeEntry(id)
            }
            // The session is not there right now (starting, refreshing, failed): not a reason to throw a post away.
            // It waits, and is sent again when the session is ready.
            else -> throw StoryOutboxRules.SessionNotReady()
        }
        val total = draft.files.sumOf { it.size }
        val pace = StoryPerf.uploadPaceMs(appContext.filesDir)
        val tally = StoryOutboxRules.Tally(total)
        setEntry(id, StoryOutboxRules.Status.Uploading, tally.fraction)
        // The ring moves a percent at a time: a 16 KB chunk is not worth a state change.
        var shownPercent = -1
        val tick = {
            val percent = ((tally.fraction ?: 0f) * 100).toInt()
            if (percent != shownPercent) {
                shownPercent = percent
                setEntry(id, StoryOutboxRules.Status.Uploading, tally.fraction)
            }
        }

        // Files that were started ahead of the story: wait for them, and name them in the create.
        var ids = resolveEager(draft, tally, tick)
        if (ids != draft.uploadIds) withContext(Dispatchers.IO) { drafts.rewrite(draft.copy(uploadIds = ids)) }
        var request = EagerRequest.apply(draft.request, draft.files, ids)

        var attempt = 0
        var made: CreateStoryResponse? = null
        while (made == null) {
            try {
                made = session.api.createStory(request)
            } catch (e: ApiException) {
                when {
                    // The PUT has not landed as far as the server can see: wait, and send the same create again.
                    ids.isNotEmpty() && EagerRequest.notYet(e.status) && attempt++ < EagerRequest.NOT_YET_ATTEMPTS ->
                        delay(EagerRequest.NOT_YET_WAIT_MS)
                    // An upload the server will not take (gone, not ours, a mismatch), or one that never shows up
                    // after the waits above: every file goes the old way.
                    ids.isNotEmpty() && (EagerRequest.unusable(e.status) || EagerRequest.notYet(e.status)) -> {
                        Log.w(TAG, "post $id: eager uploads refused (${e.status}); sending the files again")
                        eager.deleteIds(ids.values)
                        draft.files.forEach { tally.report(it.key, 0L) }
                        ids = emptyMap()
                        request = draft.request
                        withContext(Dispatchers.IO) { drafts.rewrite(draft.copy(uploadIds = emptyMap())) }
                        tick()
                    }
                    else -> throw e
                }
            }
        }
        val created: CreateStoryResponse = made
        minted[id] = created.story.id
        StoryPerf.since("post", "post_stage_created", clear = false)
        // `publish: true` created and published in one call: nothing is left to send.
        val live = request.publish == true || created.story.own?.status == "live"
        if (!live) {
            val remaining = draft.files.filter { it.key !in ids }
            val base = remaining.firstOrNull { it.key == DraftFile.BASE }
            if (base != null && created.upload == null) error("The server made a story with media and no place to upload it")
            val layerFiles = remaining.filter { it.key != DraftFile.BASE }
            val slots = created.layerUploads.associateBy { it.layerId }
            if (slots.keys != layerFiles.map { it.key }.toSet()) error("The server and the phone disagree about which layer files to upload")
            // A few independent signed PUTs at a time, across every post; publish only when every one is up.
            coroutineScope {
                val sends = buildList {
                    if (base != null) {
                        add(
                            async {
                                gate.withPermit {
                                    session.api.uploadStoryFile(created.upload!!, base.contentType, drafts.file(id, base.name), pace) {
                                        tally.report(base.key, it)
                                        tick()
                                    }
                                }
                            },
                        )
                    }
                    layerFiles.forEach { file ->
                        add(
                            async {
                                gate.withPermit {
                                    session.api.uploadStoryFile(slots.getValue(file.key).asUpload(), file.contentType, drafts.file(id, file.name), pace) {
                                        tally.report(file.key, it)
                                        tick()
                                    }
                                }
                            },
                        )
                    }
                }
                sends.awaitAll()
            }
            StoryPerf.since("post", "post_stage_uploaded", clear = false)
            // Anything with a file waits for the publish, an eager file included.
            if (draft.files.isNotEmpty() || EditorPost.needsPublish(created.upload != null, created.layerUploads)) {
                session.api.publishStory(created.story.id)
            }
        }
        StoryPerf.since("post", "post_to_live", clear = false)
        finish(draft)
    }

    /**
     * The eager uploads this post can claim, by file key. Waits for the ones still going (the ring follows them), keeps
     * the ids a previous run saved on the draft, and sets aside any upload that is not the file the draft ended up with.
     */
    private suspend fun resolveEager(draft: StoryDraft, tally: StoryOutboxRules.Tally, tick: () -> Unit): Map<String, String> {
        val handles = eagers[draft.id].orEmpty()
        val ids = LinkedHashMap<String, String>()
        draft.uploadIds.forEach { (key, uploadId) -> if (key !in handles && draft.files.any { it.key == key }) ids[key] = uploadId }
        val mine = handles.values.filter { handle ->
            val file = draft.files.firstOrNull { it.key == handle.key }
            // A handle for a file the draft does not have, or made from other bytes, is no use here.
            (file != null && file.size == handle.size && file.contentType == handle.contentType).also { fits ->
                if (!fits) eager.discard(handle)
            }
        }
        coroutineScope {
            val watcher = launch {
                while (true) {
                    mine.forEach { tally.report(it.key, it.sent) }
                    tick()
                    delay(PROGRESS_POLL_MS)
                }
            }
            mine.forEach { handle -> handle.await()?.let { ids[handle.key] = it } }
            watcher.cancel()
        }
        ids.keys.forEach { key -> draft.files.firstOrNull { it.key == key }?.let { tally.report(key, it.size) } }
        // The draft has its own copy on disk: the uploads no longer need to hold theirs.
        handles.values.forEach { it.release() }
        tick()
        return ids
    }

    /** Live: read the strips again, and only then let the ring go, so it never flickers back to "no story". */
    private suspend fun finish(draft: StoryDraft) {
        setEntry(draft.id, StoryOutboxRules.Status.Uploading, 1f)
        // The store keeps its strips on the main thread.
        withContext(Dispatchers.Main) {
            // Together, and for a few seconds at most: the story is live whether or not a strip could be read.
            withTimeoutOrNull(REFRESH_BUDGET_MS) {
                coroutineScope {
                    val refreshGate = Semaphore(REFRESHES_AT_ONCE)
                    draft.refreshKeys.distinct().map { key ->
                        async {
                            var attempts = 0
                            // The permit is held for the request, not for the wait before the next try.
                            while (!refreshGate.withPermit { store.refreshNow(key) } && ++attempts < REFRESH_ATTEMPTS) delay(REFRESH_RETRY_MS)
                        }
                    }.awaitAll()
                }
            }
        }
        withContext(Dispatchers.IO) { drafts.delete(draft.id) }
        minted.remove(draft.id)
        eagers.remove(draft.id)
        jobs.remove(draft.id)
        removeEntry(draft.id)
        withContext(Dispatchers.Main) {
            Toast.makeText(appContext, appContext.getString(R.string.stories_upload_posted), Toast.LENGTH_SHORT).show()
        }
    }

    private fun setEntry(id: String, status: StoryOutboxRules.Status, fraction: Float?) {
        _entries.update { list ->
            val entry = StoryOutboxRules.Entry(id, status, fraction)
            if (list.any { it.id == id }) list.map { if (it.id == id) entry else it } else list + entry
        }
    }

    private fun removeEntry(id: String) {
        _entries.update { list -> list.filterNot { it.id == id } }
    }

    companion object {
        private const val TAG = "pqp.stories"

        /** Files are PUT this many at once. */
        private const val UPLOADS_AT_ONCE = 3

        private const val PROGRESS_POLL_MS = 150L
        private const val AUTO_RETRY_MS = 2_000L
        private const val REFRESH_ATTEMPTS = 3
        private const val REFRESHES_AT_ONCE = 3
        private const val REFRESH_BUDGET_MS = 6_000L
        private const val REFRESH_RETRY_MS = 1_500L

        @Volatile
        private var instance: StoryOutbox? = null

        fun of(context: Context, session: SessionStore, store: StoriesStore): StoryOutbox =
            instance ?: synchronized(this) {
                instance ?: StoryOutbox(
                    appContext = context.applicationContext,
                    session = session,
                    store = store,
                    scope = CoroutineScope(SupervisorJob() + Dispatchers.Default),
                    root = File(context.applicationContext.filesDir, "story-outbox"),
                ).also { instance = it }
            }
    }
}

/**
 * The request and the files of a post, from what the editor held. This is the
 * work that used to sit between "Postar" and the network: the clip without its
 * sound, the drawing rendered to a PNG, the declared sizes that must equal the
 * bytes that are PUT. Unchanged in what it sends, which `EditorTest` still pins.
 */
object StoryDraftBuilder {
    class Built(val draft: StoryDraft, val files: Map<String, ByteArray>)

    suspend fun build(context: Context, id: String, input: StoryPostInput): Built {
        // The base: as picked, or without its sound when muted.
        var base = input.media
        if (base != null && base.isVideo && input.muted) {
            val uri = input.mutedUri ?: VideoPrep.removeAudio(context, base.previewUri)
            val ready = StoryMediaPrep.prepare(context, uri, input.maxBytes)
            base = (ready as? PrepResult.Ready)?.media ?: error("The muted clip could not be read")
        }

        val layers = input.layers
        val words = layers.filterIsInstance<TextLayer>().map { it.text.trim() }.filter { it.isNotEmpty() }
        val layerFiles = buildMap<String, LayerFile> {
            if (input.layersEnabled) {
                layers.forEach { layer ->
                    when (layer) {
                        is PhotoLayer -> input.layerFiles[layer.id]?.let { put(layer.id, it) }
                        is InkLayer -> {
                            // The drawing was already rendered and sent when its tool closed: the same bytes, not a second render.
                            val sent = input.eager[layer.id]?.takeIf { it.tag == layer.strokes }?.file
                            if (sent != null) {
                                put(layer.id, sent)
                            } else {
                                val (w, h) = InkRenderer.exportSize()
                                val png = withContext(Dispatchers.Default) { InkRenderer.renderPng(layer.strokes, w, h) }
                                put(layer.id, LayerFile(layer.id, "image/png", png, w, h))
                            }
                        }
                        else -> Unit
                    }
                }
            }
        }
        val layersEnabled = input.layersEnabled
        val request = CreateStoryRequest(
            kind = EditorPost.kind(base?.isVideo, base != null),
            // The old shape for a server with no layers: a card's words as its text, a photo's as its caption.
            caption = if (!layersEnabled && base != null) words.joinToString(" ").take(StoriesRules.CAPTION_MAX).ifBlank { null } else null,
            text = if (!layersEnabled && base == null) words.joinToString("\n").take(StoriesRules.TEXT_MAX) else null,
            background = if (base == null) input.cardBackground else null,
            // A server with no layers knows the call card only as the old sticker on a text card.
            sticker = if (!layersEnabled && base == null) {
                layers.filterIsInstance<CallLayer>().firstOrNull()?.let { StorySticker("call", it.serverId, it.channelId) }
            } else {
                null
            },
            repliesEnabled = input.replies,
            audiences = input.audience,
            requestId = id,
            media = base?.let { StoryMediaInput(it.contentType, it.bytes.size.toLong(), it.width, it.height, it.durationMs) },
            layers = if (layersEnabled) EditorPost.layersJson(layers, layerFiles) else emptyList(),
            altText = if (layersEnabled) LayerOps.spokenText(layers) else null,
        )

        val files = linkedMapOf<String, ByteArray>()
        val manifest = mutableListOf<DraftFile>()
        if (base != null) {
            files["base"] = base.bytes
            manifest += DraftFile(DraftFile.BASE, base.contentType, base.bytes.size.toLong(), "base")
        }
        layerFiles.forEach { (layerId, file) ->
            val name = "layer-$layerId"
            files[name] = file.bytes
            manifest += DraftFile(layerId, file.contentType, file.bytes.size.toLong(), name)
        }
        val draft = StoryDraft(
            id = id,
            userId = input.userId,
            request = request,
            files = manifest,
            refreshKeys = input.refreshKeys,
            createdAt = System.currentTimeMillis(),
        )
        return Built(draft, files)
    }
}
