package gg.pqp.app.stories.ui

import android.net.Uri
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.minimumInteractiveComponentSize
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.friends
import gg.pqp.app.stories.CreateStoryRequest
import gg.pqp.app.stories.PrepResult
import gg.pqp.app.stories.PreparedMedia
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoriesStore
import gg.pqp.app.stories.StoryAudienceOptions
import gg.pqp.app.stories.StoryAudienceTargets
import gg.pqp.app.stories.StoryCallRoom
import gg.pqp.app.stories.StoryMediaInput
import gg.pqp.app.stories.StorySticker
import gg.pqp.app.stories.StoryMediaPrep
import gg.pqp.app.stories.VideoPrep
import gg.pqp.app.stories.camera.StoryCameraScreen
import gg.pqp.app.stories.createStory
import gg.pqp.app.stories.editor.CallLayer
import gg.pqp.app.stories.editor.CallRoomOption
import gg.pqp.app.stories.editor.CallRoomSheet
import gg.pqp.app.stories.editor.EditorEnv
import gg.pqp.app.stories.editor.EditorPost
import gg.pqp.app.stories.editor.EditorSession
import gg.pqp.app.stories.editor.InkLayer
import gg.pqp.app.stories.editor.InkRenderer
import gg.pqp.app.stories.editor.LayerFile
import gg.pqp.app.stories.editor.LayerOps
import gg.pqp.app.stories.editor.MentionLayer
import gg.pqp.app.stories.editor.MentionPerson
import gg.pqp.app.stories.editor.MentionSheet
import gg.pqp.app.stories.editor.PhotoLayer
import gg.pqp.app.stories.editor.StoryBaseImage
import gg.pqp.app.stories.editor.StoryBaseVideo
import gg.pqp.app.stories.editor.StoryEditor
import gg.pqp.app.stories.editor.TextLayer
import gg.pqp.app.stories.publishStory
import gg.pqp.app.stories.storyAudiences
import gg.pqp.app.stories.uploadStoryMedia
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitAll
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.launch
import kotlinx.coroutines.sync.Semaphore
import kotlinx.coroutines.sync.withPermit

private enum class ComposeMode { Text, Camera, Call }

/** Layer files and the base are PUT this many at once. */
private const val UPLOADS_AT_ONCE = 3

private sealed interface PostState {
    data object Idle : PostState
    data object Posting : PostState
    data object Failed : PostState
}

/**
 * Making a story: the camera first (or TEXTO and CALL for a card with no
 * picture), then the editor, then "Quem vê".
 *
 * The picture is the base and everything else is a layer on top of it (text,
 * photos, ink, a call card, a mention), placed on a 9:16 canvas and posted as
 * data next to the base, not burned into it. A photo is re-encoded on the
 * phone (long side 1440 px, EXIF gone); a video comes from the camera or is
 * trimmed to 30 s and shrunk first.
 *
 * Posting is: create (which answers a signed PUT for the base and one for
 * each photo or drawing layer), the PUTs straight to storage, then publish. A
 * card of only words, stickers and mentions is live at create.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun StoryComposer(
    session: SessionStore,
    store: StoriesStore,
    /** The server the person was in, pre-ticked; null from the Conversas strip. */
    contextServerId: String?,
    onDismiss: () -> Unit,
    onPosted: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val config by store.config.collectAsStateWithLifecycle()
    val layersEnabled = config.layersMax > 0

    var mode by remember { mutableStateOf(if (config.mediaEnabled) ComposeMode.Camera else ComposeMode.Text) }
    var media by remember { mutableStateOf<PreparedMedia?>(null) }
    var refusal by remember { mutableStateOf<String?>(null) }
    var preparing by remember { mutableStateOf(false) }
    var cardBackground by remember { mutableStateOf("night") }
    var muted by remember { mutableStateOf(false) }
    var openCallAtStart by remember { mutableStateOf(false) }
    // Who sits in which voice room, for the call card: it is live only
    // while its author is in the room.
    val phase by session.phase.collectAsStateWithLifecycle()
    val meId = (phase as? SessionPhase.Ready)?.me?.id
    val voice = (context.applicationContext as? gg.pqp.app.PqpApplication)?.voice
    val occupancy by (voice?.rooms?.rooms ?: remember { kotlinx.coroutines.flow.MutableStateFlow(emptyMap()) })
        .collectAsStateWithLifecycle()
    var choosingAudience by remember { mutableStateOf(false) }

    var options by remember { mutableStateOf<StoryAudienceOptions?>(null) }
    var targets by remember { mutableStateOf(StoryAudienceTargets()) }
    var replies by remember { mutableStateOf(true) }
    var post by remember { mutableStateOf<PostState>(PostState.Idle) }

    // The layers are rebuilt from nothing whenever the base changes: another
    // picture is another story (and the editor asked before throwing layers away).
    val editor = remember(media, mode) { EditorSession() }
    // Prepared photo layers, by layer id: the bytes that will be PUT.
    val layerFiles = remember(editor) { mutableMapOf<String, LayerFile>() }
    var layerCamera by remember { mutableStateOf(false) }
    // The clip with its sound taken out, made once if "mute" is on when posting.
    var mutedUri by remember(media) { mutableStateOf<Uri?>(null) }

    // Who may see the story. Without this list the audience cannot be chosen,
    // so a failed read says so and offers a retry instead of leaving a button
    // that never wakes up.
    var audienceAttempt by remember { mutableStateOf(0) }
    var audienceFailed by remember { mutableStateOf(false) }
    LaunchedEffect(audienceAttempt) {
        if (audienceAttempt == 0) store.refreshConfig()
        audienceFailed = false
        runCatching { session.api.storyAudiences() }
            .onSuccess {
                options = it
                targets = StoriesRules.defaultAudience(it, contextServerId, fromFriends = contextServerId == null)
            }
            .onFailure { audienceFailed = true }
    }

    val tooLong = { seconds: Long -> context.getString(R.string.stories_compose_too_long, (seconds / 1000).toInt()) }
    // A video that needs cutting (longer than 30 s) opens the trim screen; one
    // that only needs shrinking goes straight to the cutter.
    var trimming by remember { mutableStateOf<PrepResult.NeedsWork?>(null) }
    var working by remember { mutableStateOf<Float?>(null) }
    var workJob by remember { mutableStateOf<kotlinx.coroutines.Job?>(null) }

    val show: (PrepResult) -> Unit = { result ->
        when (result) {
            is PrepResult.Ready -> media = result.media
            is PrepResult.Refused -> refusal = when (result.reason) {
                StoriesRules.MediaRefusal.TooLong -> tooLong(result.durationMs ?: 0)
                StoriesRules.MediaRefusal.TooBig -> context.getString(R.string.stories_compose_too_big)
                StoriesRules.MediaRefusal.WrongType -> context.getString(R.string.stories_compose_wrong_type)
            }
            PrepResult.Unreadable -> refusal = context.getString(R.string.stories_compose_unreadable)
            // Cut and shrunk once already and still not a story: say so, do not loop.
            is PrepResult.NeedsWork -> refusal = context.getString(R.string.stories_compose_too_big)
        }
    }
    val cutVideo: (PrepResult.NeedsWork, Long, Long) -> Unit = { work, startMs, endMs ->
        trimming = null
        working = 0f
        workJob = scope.launch {
            try {
                val out = VideoPrep.export(context, work.uri, startMs, endMs, work.width, work.height) { working = it }
                show(
                    StoryMediaPrep.prepare(context, out, config.maxBytes).let {
                        if (it is PrepResult.NeedsWork) PrepResult.Refused(StoriesRules.MediaRefusal.TooBig) else it
                    },
                )
            } catch (e: kotlinx.coroutines.CancellationException) {
                throw e
            } catch (_: Exception) {
                refusal = context.getString(R.string.stories_trim_failed)
            } finally {
                working = null
                workJob = null
            }
        }
    }
    val accept: (Uri?) -> Unit = { uri ->
        if (uri != null) {
            preparing = true
            refusal = null
            scope.launch {
                val result = StoryMediaPrep.prepare(context, uri, config.maxBytes)
                preparing = false
                if (result is PrepResult.NeedsWork) {
                    if (result.tooLong) {
                        trimming = result
                    } else {
                        cutVideo(result, 0L, result.durationMs.coerceAtMost(StoriesRules.MAX_VIDEO_MS))
                    }
                } else {
                    show(result)
                }
            }
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), accept)
    val openGallery: () -> Unit = {
        pick.launch(
            PickVisualMediaRequest(
                if (config.videoEnabled) {
                    ActivityResultContracts.PickVisualMedia.ImageAndVideo
                } else {
                    ActivityResultContracts.PickVisualMedia.ImageOnly
                },
            ),
        )
    }

    // A photo placed on the story: prepared (1440 px, EXIF gone) and kept for the PUT.
    val photoFailed = stringResource(R.string.stories_editor_photo_failed)
    val addPhotoLayer: (Uri?) -> Unit = { uri ->
        if (uri != null) {
            scope.launch {
                val result = try {
                    StoryMediaPrep.prepare(context, uri, gg.pqp.app.stories.StoriesRules.MAX_BYTES)
                } catch (e: kotlinx.coroutines.CancellationException) {
                    throw e
                } catch (_: Exception) {
                    PrepResult.Unreadable
                }
                if (result is PrepResult.Ready && !result.media.isVideo) {
                    val id = editor.newId()
                    val at = gg.pqp.app.stories.editor.LayerMath.startPosition(editor.layers.size)
                    val refused = editor.add(
                        PhotoLayer(
                            id = id, x = at.x, y = at.y, source = result.media.previewUri.toString(),
                            width = result.media.width, height = result.media.height,
                        ),
                    )
                    if (refused == null) {
                        layerFiles[id] = LayerFile(id, result.media.contentType, result.media.bytes, result.media.width, result.media.height)
                    }
                } else {
                    refusal = photoFailed
                }
            }
        }
    }
    val pickPhotoLayer = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), addPhotoLayer)

    // A call card has to go to the server its room is in (the contract refuses
    // anything else). That server is ticked the moment the room is placed,
    // where the person can see it, and locked in "Quem vê" with a line saying
    // why: never added behind their back at send time.
    val callLayer = editor.layers.firstOrNull { it is CallLayer } as? CallLayer
    val stickerServerId = callLayer?.serverId
    LaunchedEffect(stickerServerId) {
        targets = StoriesRules.withSticker(targets, stickerServerId)
    }

    val editing = media != null || mode != ComposeMode.Camera || !config.mediaEnabled
    val hasWords = LayerOps.hasContent(editor.layers)
    val ready = if (media != null) true else hasWords

    // One id per story the person means to post, the same on a retry after a
    // failure (so a lost answer never posts it twice) and new as soon as
    // anything about it changes (so an edited retry is not answered with the
    // story it replaced).
    val requestId = remember(media, mode, cardBackground, muted, editor.layers, targets, replies) {
        java.util.UUID.randomUUID().toString()
    }

    val doPost: () -> Unit = {
        post = PostState.Posting
        scope.launch {
            // Already ticked and shown (see above); this only keeps what is
            // sent identical to what the sheet showed.
            val audience = StoriesRules.withSticker(targets, stickerServerId)
            val ok = runCatching {
                postStory(
                    session = session,
                    context = context,
                    media = media,
                    muted = muted,
                    mutedUri = mutedUri,
                    onMuted = { mutedUri = it },
                    cardBackground = cardBackground,
                    layers = editor.layers,
                    layerFiles = layerFiles,
                    layersEnabled = layersEnabled,
                    replies = replies,
                    audience = audience,
                    requestId = requestId,
                    maxBytes = config.maxBytes,
                )
            }.isSuccess
            if (ok) {
                contextServerId?.let { store.refresh(store.serverKey(it)) }
                audience.serverIds.forEach { store.refresh(store.serverKey(it)) }
                store.refresh(StoriesStore.FRIENDS)
                post = PostState.Idle
                onPosted()
            } else {
                post = PostState.Failed
            }
        }
    }

    // The live camera owns the whole screen until there is something to edit.
    val showingCamera = !editing
    val suspendCamera = showingCamera && (trimming != null || working != null)

    val audienceLabel = audienceLabel(options, targets)

    Dialog(
        // Not while posting: closing mid-post would cancel the upload or the
        // publish and leave a story that never goes live (the server sweeps
        // those, but the person would think it was posted). A failed post
        // unlocks it, and a retry reuses the same requestId.
        onDismissRequest = { if (post != PostState.Posting) onDismiss() },
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black)
                .testTag("stories.composer"),
        ) {
            when {
                suspendCamera -> {
                    // The trim card or the export owns the screen: nothing is drawn and the
                    // camera is released, so its privacy indicator is not lit for a video job.
                    Box(Modifier.fillMaxSize().background(Color.Black))
                }
                showingCamera -> StoryCameraScreen(
                    videoEnabled = config.videoEnabled,
                    busy = preparing,
                    message = refusal,
                    onClose = onDismiss,
                    onGallery = openGallery,
                    onCaptured = { accept(it) },
                    modeTabs = {
                        ModeTabs(
                            mode = mode,
                            mediaEnabled = config.mediaEnabled,
                            onMode = {
                                refusal = null
                                openCallAtStart = it == ComposeMode.Call
                                mode = if (it == ComposeMode.Call) ComposeMode.Text else it
                            },
                        )
                    },
                )
                else -> {
                    val current = media
                    StoryEditor(
                        session = editor,
                        env = EditorEnv(
                            layersEnabled = layersEnabled,
                            isVideo = current?.isVideo == true,
                            muted = muted,
                            cardBackground = if (current == null) cardBackground else null,
                            audienceLabel = audienceLabel,
                            canPost = ready && options != null,
                            posting = post == PostState.Posting,
                            callWarning = callLayer?.takeIf { !StoryCallRoom.authorIn(it.channelId, meId, occupancy) }
                                ?.let { stringResource(R.string.stories_call_not_in_room, it.roomName) },
                            occupancy = occupancy,
                        ),
                        base = {
                            when {
                                current == null -> Unit
                                current.isVideo -> StoryBaseVideo(current.previewUri, current.width, current.height, muted)
                                else -> StoryBaseImage(current.previewUri, current.width, current.height)
                            }
                        },
                        onClose = {
                            // Back out of the editor: to the camera when there was a picture, else out.
                            if (media != null) {
                                media = null
                            } else if (config.mediaEnabled) {
                                mode = ComposeMode.Camera
                            } else {
                                onDismiss()
                            }
                        },
                        onToggleMute = { muted = !muted },
                        onCardBackground = { cardBackground = it },
                        onPickGalleryPhoto = {
                            pickPhotoLayer.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        onTakePhoto = { layerCamera = true },
                        onAudience = { choosingAudience = true },
                        onPost = {
                            if (StoriesRules.canPost(targets)) doPost() else choosingAudience = true
                        },
                        callSheet = { onPick, onDismissSheet ->
                            val rooms = rememberCallRooms(session, options)
                            CallRoomSheet(
                                rooms = rooms,
                                occupancy = occupancy,
                                meId = meId,
                                selectedChannelId = callLayer?.channelId,
                                onPick = { room ->
                                    onPick(
                                        CallLayer(
                                            id = callLayer?.id ?: editor.newId(),
                                            x = callLayer?.x ?: 0.5f,
                                            y = callLayer?.y ?: 0.78f,
                                            scale = callLayer?.scale ?: 1f,
                                            rotation = callLayer?.rotation ?: 0f,
                                            serverId = room.serverId,
                                            channelId = room.channelId,
                                            roomName = room.channelName,
                                            serverName = room.serverName,
                                        ),
                                    )
                                },
                                onDismiss = onDismissSheet,
                            )
                        },
                        mentionSheet = { onPick, onDismissSheet ->
                            val directory = rememberMentionPeople(session, targets, meId)
                            MentionSheet(
                                people = directory.people,
                                incomplete = directory.failed,
                                onRetry = directory.retry,
                                onPick = { person ->
                                    onPick(MentionLayer(id = editor.newId(), userId = person.userId, name = person.name, avatarUrl = person.avatarUrl))
                                },
                                onDismiss = onDismissSheet,
                            )
                        },
                        openCallSheetAtStart = openCallAtStart && editor.layers.none { it is CallLayer },
                    )
                }
            }

            if (layerCamera) {
                Dialog(
                    onDismissRequest = { layerCamera = false },
                    properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
                ) {
                    StoryCameraScreen(
                        videoEnabled = false,
                        busy = false,
                        message = null,
                        onClose = { layerCamera = false },
                        onGallery = {
                            layerCamera = false
                            pickPhotoLayer.launch(PickVisualMediaRequest(ActivityResultContracts.PickVisualMedia.ImageOnly))
                        },
                        onCaptured = {
                            layerCamera = false
                            addPhotoLayer(it)
                        },
                        modeTabs = {},
                    )
                }
            }

            if (post == PostState.Failed && !choosingAudience) {
                Text(
                    stringResource(R.string.stories_upload_failed),
                    color = Color.White,
                    style = MaterialTheme.typography.bodyMedium,
                    modifier = Modifier
                        .align(Alignment.TopCenter)
                        .padding(top = 96.dp)
                        .clip(MaterialTheme.shapes.small)
                        .background(Palette.Danger.copy(alpha = 0.9f))
                        .clickable { post = PostState.Idle }
                        .padding(horizontal = Spacing.lg, vertical = Spacing.sm)
                        .testTag("stories.composer.failed"),
                )
            }
        }

        trimming?.let { work ->
            StoryTrimScreen(
                uri = work.uri,
                durationMs = work.durationMs,
                onConfirm = { startMs, endMs -> cutVideo(work, startMs, endMs) },
                onCancel = { trimming = null },
            )
        }
        working?.let { progress ->
            StoryVideoWorking(progress = progress, onCancel = { workJob?.cancel() })
        }

        if (choosingAudience) {
            AudienceSheet(
                options = options ?: StoryAudienceOptions(),
                targets = targets,
                onTargets = { targets = it },
                lockedServerId = stickerServerId,
                replies = replies,
                onReplies = { replies = it },
                post = post,
                onPost = doPost,
                onDismiss = { if (post != PostState.Posting) choosingAudience = false },
            )
        }
    }
}

/** "Quem vê: QG, Amigos": where the story is going, in a line. */
@Composable
private fun audienceLabel(options: StoryAudienceOptions?, targets: StoryAudienceTargets): String {
    val parts = StoriesRules.audienceParts(options, targets)
    if (parts.serverNames.isEmpty() && !parts.friends) return stringResource(R.string.stories_editor_audience_none)
    val names = buildList {
        when (parts.serverNames.size) {
            0 -> Unit
            1 -> add(parts.serverNames.first())
            else -> add(pluralStringResource(R.plurals.stories_editor_audience_servers, parts.serverNames.size, parts.serverNames.size))
        }
        if (parts.friends) add(stringResource(R.string.stories_audience_friends))
    }
    return stringResource(R.string.stories_editor_audience, names.joinToString(", "))
}

/** Every voice room in a server this person may post to, loaded once when the call sheet opens. */
@Composable
private fun rememberCallRooms(session: SessionStore, options: StoryAudienceOptions?): List<CallRoomOption>? {
    var rooms by remember { mutableStateOf<List<CallRoomOption>?>(null) }
    LaunchedEffect(options) {
        val servers = options?.servers?.filter { it.canPost } ?: return@LaunchedEffect
        rooms = servers.flatMap { server ->
            runCatching { session.api.channels(server.serverId) }.getOrDefault(emptyList())
                .filter { it.type == "voice" }
                .map { CallRoomOption(it.serverId ?: server.serverId, server.serverName, it.id, it.name) }
        }
    }
    return rooms
}

/**
 * Who can be mentioned: members of the servers the story goes to, and friends
 * when it goes to friends. The server refuses a mention of anybody who could
 * not see the story, so the list is only ever those people.
 */
@Composable
private fun rememberMentionPeople(
    session: SessionStore,
    targets: StoryAudienceTargets,
    meId: String?,
): MentionDirectory {
    var people by remember { mutableStateOf<List<MentionPerson>?>(null) }
    var failed by remember { mutableStateOf(false) }
    var attempt by remember { mutableStateOf(0) }
    LaunchedEffect(targets.serverIds, targets.friends, attempt) {
        failed = false
        // Every roster at once: the picker is as slow as the slowest server, not the sum of them.
        val (found, lost) = kotlinx.coroutines.coroutineScope {
            val friends = if (targets.friends) async { runCatching { session.api.friends().friends } } else null
            val servers = targets.serverIds.map { id -> async { runCatching { session.api.serverMembers(id) } } }
            val people = linkedMapOf<String, MentionPerson>()
            var lost = false
            friends?.await()?.let { result ->
                result.onFailure { lost = true }
                result.getOrNull()?.forEach { people[it.id] = MentionPerson(it.id, it.displayName, it.username, it.avatarUrl) }
            }
            servers.forEach { call ->
                val result = call.await()
                result.onFailure { lost = true }
                result.getOrNull()?.forEach {
                    people.putIfAbsent(it.id, MentionPerson(it.id, it.nickname ?: it.displayName, it.username, it.avatarUrl))
                }
            }
            people to lost
        }
        people = found.values.filter { it.userId != meId }.sortedBy { it.name.lowercase() }
        // A list that is missing somebody says so, with a way to try again: not "nobody found".
        failed = lost
    }
    return MentionDirectory(people, failed) { attempt += 1 }
}

/** The people a mention can name, and whether the list is known to be incomplete. */
private class MentionDirectory(val people: List<MentionPerson>?, val failed: Boolean, val retry: () -> Unit)

/**
 * Create, PUT every file, publish. A server that predates layers gets the old
 * shape (the words folded into the card's text, or a photo's caption); any
 * other gets the base plus the layers.
 */
private suspend fun postStory(
    session: SessionStore,
    context: android.content.Context,
    media: PreparedMedia?,
    muted: Boolean,
    mutedUri: Uri?,
    onMuted: (Uri) -> Unit,
    cardBackground: String,
    layers: List<gg.pqp.app.stories.editor.EditorLayer>,
    layerFiles: Map<String, LayerFile>,
    layersEnabled: Boolean,
    replies: Boolean,
    audience: StoryAudienceTargets,
    requestId: String,
    maxBytes: Long,
) {
    // The base: as picked, or without its sound when muted.
    var base = media
    if (base != null && base.isVideo && muted) {
        val uri = mutedUri ?: VideoPrep.removeAudio(context, base.previewUri).also(onMuted)
        val ready = StoryMediaPrep.prepare(context, uri, maxBytes)
        base = (ready as? PrepResult.Ready)?.media ?: error("The muted clip could not be read")
    }

    val words = layers.filterIsInstance<TextLayer>().map { it.text.trim() }.filter { it.isNotEmpty() }
    val files = buildMap<String, LayerFile> {
        if (layersEnabled) {
            layers.forEach { layer ->
                when (layer) {
                    is PhotoLayer -> layerFiles[layer.id]?.let { put(layer.id, it) }
                    is InkLayer -> {
                        val (w, h) = InkRenderer.exportSize()
                        put(layer.id, LayerFile(layer.id, "image/png", InkRenderer.renderPng(layer.strokes, w, h), w, h))
                    }
                    else -> Unit
                }
            }
        }
    }
    val request = CreateStoryRequest(
        kind = EditorPost.kind(base?.isVideo, base != null),
        // The old shape for a server with no layers: a card's words as its text, a photo's as its caption.
        caption = if (!layersEnabled && base != null) words.joinToString(" ").take(StoriesRules.CAPTION_MAX).ifBlank { null } else null,
        text = if (!layersEnabled && base == null) words.joinToString("\n").take(StoriesRules.TEXT_MAX) else null,
        background = if (base == null) cardBackground else null,
        // A server with no layers knows the call card only as the old sticker on a text card.
        sticker = if (!layersEnabled && base == null) {
            layers.filterIsInstance<CallLayer>().firstOrNull()?.let { StorySticker("call", it.serverId, it.channelId) }
        } else {
            null
        },
        repliesEnabled = replies,
        audiences = audience,
        requestId = requestId,
        media = base?.let {
            StoryMediaInput(it.contentType, it.bytes.size.toLong(), it.width, it.height, it.durationMs)
        },
        layers = if (layersEnabled) EditorPost.layersJson(layers, files) else emptyList(),
        altText = if (layersEnabled) LayerOps.spokenText(layers) else null,
    )
    val created = session.api.createStory(request)
    // A story with a picture and no slot to PUT it to is a broken answer, not a posted story: unless the
    // server already has it live (a retry of a post whose answer was lost).
    if (base != null && created.upload == null && created.story.own?.status != "live") {
        error("The server made a story with media and no place to upload it")
    }
    val pairs = EditorPost.pair(created.layerUploads, files)
        ?: error("The server and the phone disagree about which layer files to upload")
    // The files are independent signed PUTs: a few at a time, and publish only when every one is up.
    val gate = Semaphore(UPLOADS_AT_ONCE)
    coroutineScope {
        val uploads = buildList {
            if (base != null) created.upload?.let { slot -> add(async { gate.withPermit { session.api.uploadStoryMedia(slot, base.contentType, base.bytes) } }) }
            pairs.forEach { (slot, file) ->
                add(async { gate.withPermit { session.api.uploadStoryMedia(slot.asUpload(), file.contentType, file.bytes) } })
            }
        }
        uploads.awaitAll()
    }
    if (EditorPost.needsPublish(created.upload != null, created.layerUploads)) session.api.publishStory(created.story.id)
}

@Composable
private fun ModeTabs(mode: ComposeMode, mediaEnabled: Boolean, onMode: (ComposeMode) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(Spacing.xl, Alignment.CenterHorizontally),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Spacing.sm),
    ) {
        ComposeMode.entries.forEach { entry ->
            if (entry == ComposeMode.Camera && !mediaEnabled) return@forEach
            val label = stringResource(
                when (entry) {
                    ComposeMode.Text -> R.string.stories_compose_mode_text
                    ComposeMode.Camera -> R.string.stories_compose_mode_camera
                    ComposeMode.Call -> R.string.stories_compose_mode_call
                },
            ).uppercase()
            Text(
                text = label,
                color = if (entry == mode) Palette.Signal else Color.White.copy(alpha = 0.7f),
                style = MaterialTheme.typography.labelLarge,
                fontWeight = if (entry == mode) FontWeight.Bold else null,
                modifier = Modifier
                    .clip(MaterialTheme.shapes.small)
                    .clickable { onMode(entry) }
                    .padding(horizontal = Spacing.sm, vertical = Spacing.xs)
                    .testTag("stories.composer.mode.${entry.name.lowercase()}"),
            )
        }
    }
}

/**
 * "Quem vê": every server this person may post to plus Amigos, ticked where
 * they were. A server where they may not post is drawn greyed with the
 * reason, so nobody takes a missing box for a bug.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun AudienceSheet(
    options: StoryAudienceOptions,
    targets: StoryAudienceTargets,
    onTargets: (StoryAudienceTargets) -> Unit,
    /** The server a call sticker's room is in: shown ticked and cannot be unticked. */
    lockedServerId: String?,
    replies: Boolean,
    onReplies: (Boolean) -> Unit,
    post: PostState,
    onPost: () -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = true)
    ModalBottomSheet(onDismissRequest = onDismiss, sheetState = sheetState, modifier = Modifier.testTag("stories.audience")) {
        Column(
            Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(horizontal = Spacing.gutter)
                .verticalScroll(rememberScrollState()),
        ) {
            Text(stringResource(R.string.stories_audience_title), style = MaterialTheme.typography.titleLarge)
            Text(
                stringResource(R.string.stories_audience_body),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.height(Spacing.sm))
            options.servers.forEach { server ->
                val checked = server.serverId in targets.serverIds
                // The call sticker's own server: ticked, locked, and saying why.
                val locked = !StoriesRules.canUntick(server.serverId, lockedServerId)
                AudienceRow(
                    title = server.serverName,
                    subtitle = when {
                        locked -> stringResource(R.string.stories_audience_call_locked)
                        server.blockedReason == "no_permission" -> stringResource(R.string.stories_audience_no_permission)
                        server.blockedReason == "timed_out" -> stringResource(R.string.stories_audience_timed_out)
                        server.blockedReason == "account_too_new" -> stringResource(R.string.stories_audience_too_new)
                        else -> pluralStringResource(R.plurals.stories_audience_members, server.memberCount, server.memberCount)
                    },
                    checked = checked || locked,
                    enabled = server.canPost && !locked,
                    onToggle = {
                        val ids = if (checked) targets.serverIds - server.serverId else targets.serverIds + server.serverId
                        onTargets(targets.copy(serverIds = ids))
                    },
                )
            }
            if (options.friends.enabled) {
                AudienceRow(
                    title = stringResource(R.string.stories_audience_friends),
                    subtitle = null,
                    checked = targets.friends,
                    enabled = options.friends.canPost,
                    onToggle = { onTargets(targets.copy(friends = !targets.friends)) },
                )
            }
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = Spacing.sm)) {
                Column(Modifier.weight(1f)) {
                    Text(stringResource(R.string.stories_audience_replies), style = MaterialTheme.typography.titleSmall)
                    Text(
                        stringResource(R.string.stories_audience_replies_hint),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
                Switch(checked = replies, onCheckedChange = onReplies, modifier = Modifier.testTag("stories.audience.replies"))
            }
            Button(
                onClick = onPost,
                enabled = StoriesRules.canPost(targets) && post != PostState.Posting,
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                modifier = Modifier
                    .fillMaxWidth()
                    .testTag("stories.audience.post"),
            ) {
                if (post == PostState.Posting) {
                    CircularProgressIndicator(Modifier.size(18.dp), color = Palette.Ink, strokeWidth = 2.dp)
                    Spacer(Modifier.width(Spacing.sm))
                    Text(stringResource(R.string.stories_upload_posting))
                } else {
                    Text(stringResource(R.string.stories_audience_post))
                }
            }
            if (post == PostState.Failed) {
                Text(
                    stringResource(R.string.stories_upload_failed),
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .padding(top = Spacing.sm)
                        .testTag("stories.audience.failed"),
                )
            }
            Text(
                stringResource(R.string.stories_audience_footer),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(vertical = Spacing.md),
            )
        }
    }
}

@Composable
private fun AudienceRow(title: String, subtitle: String?, checked: Boolean, enabled: Boolean, onToggle: () -> Unit) {
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .clickable(enabled = enabled, onClick = onToggle)
            .padding(vertical = Spacing.xs)
            .testTag("stories.audience.row"),
    ) {
        Checkbox(
            checked = checked,
            onCheckedChange = if (enabled) ({ onToggle() }) else null,
            enabled = enabled,
            colors = CheckboxDefaults.colors(checkedColor = MaterialTheme.colorScheme.primary, checkmarkColor = MaterialTheme.colorScheme.onPrimary),
            // A row that cannot be toggled still keeps the box's full size, so its label lines up with the rest.
            modifier = Modifier.minimumInteractiveComponentSize(),
        )
        Column {
            Text(
                title,
                style = MaterialTheme.typography.bodyLarge,
                color = if (enabled) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onSurfaceVariant,
            )
            subtitle?.let {
                Text(it, style = MaterialTheme.typography.bodySmall, color = MaterialTheme.colorScheme.onSurfaceVariant)
            }
        }
    }
}
