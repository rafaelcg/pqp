package gg.pqp.app.stories

import android.content.Context
import android.net.Uri
import android.util.Log
import android.widget.Toast
import gg.pqp.app.R
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
    private val jobs = ConcurrentHashMap<String, Job>()

    /** The story the server minted for a draft, so discarding a half-sent one takes it down now instead of at the sweep. */
    private val minted = ConcurrentHashMap<String, String>()

    /** In-memory inputs while a post is still being made ready, so a retry before the draft exists can redo it. */
    private val pendingInputs = ConcurrentHashMap<String, StoryPostInput>()

    private val _entries = MutableStateFlow<List<StoryOutboxRules.Entry>>(emptyList())
    val entries: StateFlow<List<StoryOutboxRules.Entry>> = _entries.asStateFlow()

    init {
        scope.launch { followSession() }
    }

    /** The post is the outbox's from this call on. Returns at once; the composer can close. */
    fun enqueue(input: StoryPostInput): String {
        val id = UUID.randomUUID().toString()
        pendingInputs[id] = input
        setEntry(id, StoryOutboxRules.Status.Preparing, null)
        launch(id) {
            val draft = withContext(Dispatchers.IO) { prepare(id, input) }
            pendingInputs.remove(id)
            upload(draft)
        }
        return id
    }

    /** Send a failed draft again, the same request. */
    fun retry(id: String) {
        if (jobs[id]?.isActive == true) return
        setEntry(id, StoryOutboxRules.Status.Uploading, null)
        launch(id) {
            val input = pendingInputs[id]
            val draft = if (input != null) {
                withContext(Dispatchers.IO) { prepare(id, input) }.also { pendingInputs.remove(id) }
            } else {
                drafts.list().firstOrNull { it.id == id } ?: return@launch removeEntry(id)
            }
            upload(draft)
        }
    }

    /** The person gave up on it: stop sending, forget the draft and its files. */
    fun discard(id: String) {
        jobs.remove(id)?.cancel()
        pendingInputs.remove(id)
        scope.launch(Dispatchers.IO) { drafts.delete(id) }
        minted.remove(id)?.let { storyId -> scope.launch { runCatching { session.api.deleteStory(storyId) } } }
        removeEntry(id)
    }

    /** Drafts a previous run of the app left on disk come back as failed ones, once the account is known. */
    private fun restore(userId: String) {
        val found = drafts.list()
        found.filter { it.userId != userId }.forEach { drafts.delete(it.id) }
        found.filter { it.userId == userId && _entries.value.none { e -> e.id == it.id } }.forEach {
            setEntry(it.id, StoryOutboxRules.Status.Failed, null)
        }
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
                setEntry(id, StoryOutboxRules.Status.Failed, null)
            }
        }
    }

    /** Make the files and the request, and keep them: from here the post survives anything. */
    private suspend fun prepare(id: String, input: StoryPostInput): StoryDraft {
        val built = StoryDraftBuilder.build(appContext, id, input)
        drafts.write(built.draft, built.files)
        return built.draft
    }

    private suspend fun upload(draft: StoryDraft) {
        val id = draft.id
        val total = draft.files.sumOf { it.size }
        val pace = StoryPerf.uploadPaceMs(appContext.filesDir)
        val tally = StoryOutboxRules.Tally(total)
        setEntry(id, StoryOutboxRules.Status.Uploading, tally.fraction)
        val tick = { setEntry(id, StoryOutboxRules.Status.Uploading, tally.fraction) }

        val created = session.api.createStory(draft.request)
        minted[id] = created.story.id
        StoryPerf.since("post", "post_stage_created", clear = false)
        val live = created.story.own?.status == "live"
        if (!live) {
            val base = draft.files.firstOrNull { it.key == DraftFile.BASE }
            if (base != null && created.upload == null) error("The server made a story with media and no place to upload it")
            val layerFiles = draft.files.filter { it.key != DraftFile.BASE }
            val slots = created.layerUploads.associateBy { it.layerId }
            if (slots.keys != layerFiles.map { it.key }.toSet()) error("The server and the phone disagree about which layer files to upload")
            // A few independent signed PUTs at a time; publish only when every one is up.
            val gate = Semaphore(UPLOADS_AT_ONCE)
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
            if (EditorPost.needsPublish(created.upload != null, created.layerUploads)) session.api.publishStory(created.story.id)
        }
        StoryPerf.since("post", "post_to_live", clear = false)
        finish(draft)
    }

    /** Live: read the strips again, and only then let the ring go, so it never flickers back to "no story". */
    private suspend fun finish(draft: StoryDraft) {
        setEntry(draft.id, StoryOutboxRules.Status.Uploading, 1f)
        // The store keeps its strips on the main thread.
        withContext(Dispatchers.Main) { draft.refreshKeys.distinct().forEach { store.refreshNow(it) } }
        withContext(Dispatchers.IO) { drafts.delete(draft.id) }
        minted.remove(draft.id)
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
                            val (w, h) = InkRenderer.exportSize()
                            val png = withContext(Dispatchers.Default) { InkRenderer.renderPng(layer.strokes, w, h) }
                            put(layer.id, LayerFile(layer.id, "image/png", png, w, h))
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
