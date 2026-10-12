package gg.pqp.app.stories.ui

import android.content.Context
import android.content.Intent
import android.graphics.Bitmap
import android.media.MediaMetadataRetriever
import android.net.Uri
import android.provider.MediaStore
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.PickVisualMediaRequest
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.imePadding
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.Checkbox
import androidx.compose.material3.CheckboxDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.RadioButton
import androidx.compose.material3.Switch
import androidx.compose.material3.Text
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
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
import androidx.compose.ui.focus.focusRequester
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.SolidColor
import androidx.compose.ui.graphics.asImageBitmap
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.core.content.FileProvider
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.Channel
import gg.pqp.app.core.SessionStore
import gg.pqp.app.stories.CreateStoryRequest
import gg.pqp.app.stories.PrepResult
import gg.pqp.app.stories.PreparedMedia
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoriesStore
import gg.pqp.app.stories.StoryAudienceOptions
import gg.pqp.app.stories.StoryAudienceTargets
import gg.pqp.app.stories.StoryMediaInput
import gg.pqp.app.stories.StoryMediaPrep
import gg.pqp.app.stories.StorySticker
import gg.pqp.app.stories.createStory
import gg.pqp.app.stories.publishStory
import gg.pqp.app.stories.storyAudiences
import gg.pqp.app.stories.uploadStoryMedia
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import java.io.File
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

private enum class ComposeMode { Text, Camera, Call }

private enum class CaptureKind { Photo, Video }

private sealed interface PostState {
    data object Idle : PostState
    data object Posting : PostState
    data object Failed : PostState
}

/**
 * Making a story: TEXTO / CÂMERA / CALL, then "Quem vê".
 *
 * The camera is the system's (a photo, or a video stopped at 30 s) and the
 * gallery is the photo picker, so the app asks for no camera or storage
 * permission. A photo is re-encoded on the phone (long side 1440 px, EXIF
 * gone); a video over 30 s or 25 MB is refused with the reason before any
 * byte leaves.
 *
 * Posting is three calls: create (which answers a signed PUT for media), the
 * PUT straight to storage, then publish. A text card is live at create.
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

    var mode by remember { mutableStateOf(if (config.mediaEnabled) ComposeMode.Camera else ComposeMode.Text) }
    var media by remember { mutableStateOf<PreparedMedia?>(null) }
    var refusal by remember { mutableStateOf<String?>(null) }
    var preparing by remember { mutableStateOf(false) }
    var text by remember { mutableStateOf("") }
    var background by remember { mutableStateOf("night") }
    var caption by remember { mutableStateOf("") }
    var callChannel by remember { mutableStateOf<Channel?>(null) }
    var choosingAudience by remember { mutableStateOf(false) }

    var options by remember { mutableStateOf<StoryAudienceOptions?>(null) }
    var targets by remember { mutableStateOf(StoryAudienceTargets()) }
    var replies by remember { mutableStateOf(true) }
    var post by remember { mutableStateOf<PostState>(PostState.Idle) }

    // Who may see the story. Without this list "Seguir" cannot open "Quem vê",
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
    val accept: (Uri?) -> Unit = { uri ->
        if (uri != null) {
            preparing = true
            refusal = null
            scope.launch {
                when (val result = StoryMediaPrep.prepare(context, uri, config.maxBytes)) {
                    is PrepResult.Ready -> media = result.media
                    is PrepResult.Refused -> refusal = when (result.reason) {
                        StoriesRules.MediaRefusal.TooLong -> tooLong(result.durationMs ?: 0)
                        StoriesRules.MediaRefusal.TooBig -> context.getString(R.string.stories_compose_too_big)
                        StoriesRules.MediaRefusal.WrongType -> context.getString(R.string.stories_compose_wrong_type)
                    }
                    PrepResult.Unreadable -> refusal = context.getString(R.string.stories_compose_unreadable)
                }
                preparing = false
            }
        }
    }
    val pick = rememberLauncherForActivityResult(ActivityResultContracts.PickVisualMedia(), accept)
    var captureUri by remember { mutableStateOf<Uri?>(null) }
    val takePhoto = rememberLauncherForActivityResult(ActivityResultContracts.TakePicture()) { ok ->
        if (ok) accept(captureUri)
    }
    val recordVideo = rememberLauncherForActivityResult(CaptureShortVideo()) { ok ->
        if (ok) accept(captureUri)
    }

    // The app declares CAMERA (calls use it), and Android then refuses
    // ACTION_IMAGE_CAPTURE / VIDEO_CAPTURE with a SecurityException until the
    // permission is granted, even though the camera app is the one shooting.
    // So: ask first, and never let a refused launch take the app down.
    val unreadable = context.getString(R.string.stories_compose_unreadable)
    val launchCapture: (CaptureKind) -> Unit = { kind ->
        captureUri = captureTarget(context, if (kind == CaptureKind.Photo) "jpg" else "mp4")
        captureUri?.let { uri ->
            runCatching {
                if (kind == CaptureKind.Photo) takePhoto.launch(uri) else recordVideo.launch(uri)
            }.onFailure { refusal = unreadable }
        }
    }
    var pendingCapture by remember { mutableStateOf<CaptureKind?>(null) }
    val cameraPermission = rememberLauncherForActivityResult(ActivityResultContracts.RequestPermission()) { granted ->
        val kind = pendingCapture
        pendingCapture = null
        if (granted && kind != null) launchCapture(kind)
    }
    val withCamera: (CaptureKind) -> Unit = { kind ->
        val granted = androidx.core.content.ContextCompat.checkSelfPermission(
            context,
            android.Manifest.permission.CAMERA,
        ) == android.content.pm.PackageManager.PERMISSION_GRANTED
        if (granted) {
            launchCapture(kind)
        } else {
            pendingCapture = kind
            cameraPermission.launch(android.Manifest.permission.CAMERA)
        }
    }

    val ready = when (mode) {
        ComposeMode.Camera -> media != null
        ComposeMode.Text -> text.isNotBlank()
        ComposeMode.Call -> callChannel != null && text.isNotBlank()
    }

    // One id per story the person means to post, the same on a retry after a
    // failure (so a lost answer never posts it twice) and new as soon as
    // anything about it changes (so an edited retry is not answered with the
    // story it replaced).
    val requestId = remember(mode, media, text, background, caption, callChannel, targets, replies) {
        java.util.UUID.randomUUID().toString()
    }
    // A call sticker has to go to the server its room is in (the contract
    // refuses anything else). That server is ticked the moment the room is
    // picked, where the person can see it, and locked in "Quem vê" with a line
    // saying why: never added behind their back at send time.
    val stickerServerId = callChannel?.takeIf { mode == ComposeMode.Call }?.serverId
    LaunchedEffect(stickerServerId) {
        targets = StoriesRules.withSticker(targets, stickerServerId)
    }

    val doPost: () -> Unit = {
        post = PostState.Posting
        scope.launch {
            val sticker = callChannel?.takeIf { mode == ComposeMode.Call }?.let {
                StorySticker(type = "call", serverId = it.serverId, channelId = it.id)
            }
            // Already ticked and shown (see above); this only keeps what is
            // sent identical to what the sheet showed.
            val audience = StoriesRules.withSticker(targets, stickerServerId)
            val prepared = media.takeIf { mode == ComposeMode.Camera }
            val request = if (prepared != null) {
                CreateStoryRequest(
                    kind = if (prepared.isVideo) "video" else "image",
                    caption = caption.trim().ifBlank { null },
                    repliesEnabled = replies,
                    audiences = audience,
                    requestId = requestId,
                    media = StoryMediaInput(
                        contentType = prepared.contentType,
                        byteSize = prepared.bytes.size.toLong(),
                        width = prepared.width,
                        height = prepared.height,
                        durationMs = prepared.durationMs,
                    ),
                )
            } else {
                CreateStoryRequest(
                    kind = "text",
                    text = text.trim(),
                    background = background,
                    sticker = sticker,
                    repliesEnabled = replies,
                    audiences = audience,
                    requestId = requestId,
                )
            }
            val ok = runCatching {
                val created = session.api.createStory(request)
                if (prepared != null) {
                    created.upload?.let { session.api.uploadStoryMedia(it, prepared.contentType, prepared.bytes) }
                    session.api.publishStory(created.story.id)
                }
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
            // The canvas: what the story will look like.
            when {
                mode == ComposeMode.Camera && media != null -> MediaPreview(media!!)
                mode == ComposeMode.Camera -> Box(Modifier.fillMaxSize().background(Color(0xFF15191E)))
                else -> Box(Modifier.fillMaxSize().background(backgroundBrush(background)))
            }
            // Controls stay legible over a bright photo or clip.
            if (mode == ComposeMode.Camera && media != null) {
                Box(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .height(320.dp)
                        .background(
                            androidx.compose.ui.graphics.Brush.verticalGradient(
                                listOf(Color.Transparent, Color.Black.copy(alpha = 0.7f)),
                            ),
                        ),
                )
            }

            Column(
                Modifier
                    .fillMaxSize()
                    .statusBarsPadding()
                    .navigationBarsPadding()
                    .imePadding(),
            ) {
                Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(Spacing.sm)) {
                    IconButton(
                        onClick = onDismiss,
                        enabled = post != PostState.Posting,
                        modifier = Modifier.testTag("stories.composer.close"),
                    ) {
                        Icon(PqpIcons.Close, contentDescription = stringResource(R.string.stories_viewer_close), tint = Color.White)
                    }
                    Text(
                        stringResource(R.string.stories_compose_title),
                        color = Color.White,
                        style = MaterialTheme.typography.titleMedium,
                        modifier = Modifier.weight(1f),
                    )
                    if (mode == ComposeMode.Camera && media != null) {
                        androidx.compose.material3.TextButton(
                            onClick = {
                                media = null
                                caption = ""
                            },
                            modifier = Modifier.testTag("stories.composer.change"),
                        ) { Text(stringResource(R.string.stories_compose_change), color = Color.White) }
                    }
                }

                Box(Modifier.weight(1f).fillMaxWidth(), contentAlignment = Alignment.Center) {
                    when (mode) {
                        ComposeMode.Camera -> if (media == null) {
                            CameraChoices(
                                videoEnabled = config.videoEnabled,
                                preparing = preparing,
                                refusal = refusal,
                                onPhoto = { withCamera(CaptureKind.Photo) },
                                onVideo = { withCamera(CaptureKind.Video) },
                                onGallery = {
                                    pick.launch(
                                        PickVisualMediaRequest(
                                            if (config.videoEnabled) {
                                                ActivityResultContracts.PickVisualMedia.ImageAndVideo
                                            } else {
                                                ActivityResultContracts.PickVisualMedia.ImageOnly
                                            },
                                        ),
                                    )
                                },
                            )
                        }
                        ComposeMode.Text, ComposeMode.Call -> CardEditor(
                            text = text,
                            onText = { text = it.take(StoriesRules.TEXT_MAX) },
                            background = background,
                        )
                    }
                }

                if (mode == ComposeMode.Camera && media != null) {
                    TextField(
                        value = caption,
                        onValueChange = { caption = it.take(StoriesRules.CAPTION_MAX) },
                        placeholder = { Text(stringResource(R.string.stories_compose_caption)) },
                        singleLine = true,
                        colors = darkFieldColors(),
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Spacing.gutter)
                            .testTag("stories.composer.caption"),
                    )
                }
                if (mode != ComposeMode.Camera) {
                    BackgroundSwatches(selected = background, onPick = { background = it })
                }
                if (mode == ComposeMode.Call) {
                    CallPicker(
                        session = session,
                        options = options,
                        selected = callChannel,
                        onPick = { callChannel = it },
                    )
                }

                ModeTabs(
                    mode = mode,
                    mediaEnabled = config.mediaEnabled,
                    onMode = {
                        mode = it
                        if (it == ComposeMode.Call && text.isBlank()) {
                            text = context.getString(R.string.stories_call_default_text)
                        }
                    },
                )
                if (audienceFailed && options == null) {
                    Row(
                        verticalAlignment = Alignment.CenterVertically,
                        modifier = Modifier
                            .fillMaxWidth()
                            .padding(horizontal = Spacing.gutter)
                            .testTag("stories.composer.audienceFailed"),
                    ) {
                        Text(
                            stringResource(R.string.stories_audience_failed),
                            color = Color.White,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.weight(1f),
                        )
                        androidx.compose.material3.TextButton(
                            onClick = { audienceAttempt += 1 },
                            modifier = Modifier.testTag("stories.composer.audienceRetry"),
                        ) { Text(stringResource(R.string.connection_retry), color = Palette.Signal) }
                    }
                }
                Button(
                    onClick = { choosingAudience = true },
                    enabled = ready && options != null,
                    shape = MaterialTheme.shapes.small,
                    colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                    modifier = Modifier
                        .fillMaxWidth()
                        .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                        .testTag("stories.composer.next"),
                ) { Text(stringResource(R.string.stories_compose_next)) }
            }
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

@Composable
private fun CameraChoices(
    videoEnabled: Boolean,
    preparing: Boolean,
    refusal: String?,
    onPhoto: () -> Unit,
    onVideo: () -> Unit,
    onGallery: () -> Unit,
) {
    Column(
        horizontalAlignment = Alignment.CenterHorizontally,
        verticalArrangement = Arrangement.spacedBy(Spacing.md),
        modifier = Modifier.padding(Spacing.xl),
    ) {
        if (preparing) {
            CircularProgressIndicator(color = Color.White)
            return@Column
        }
        ChoiceButton(stringResource(R.string.stories_compose_take_photo), "stories.composer.photo", onPhoto)
        if (videoEnabled) ChoiceButton(stringResource(R.string.stories_compose_record_video), "stories.composer.video", onVideo)
        ChoiceButton(stringResource(R.string.stories_compose_gallery), "stories.composer.gallery", onGallery)
        refusal?.let {
            Text(
                it,
                color = MaterialTheme.colorScheme.error,
                textAlign = TextAlign.Center,
                modifier = Modifier.testTag("stories.composer.refusal"),
            )
        }
    }
}

@Composable
private fun ChoiceButton(label: String, tag: String, onClick: () -> Unit) {
    OutlinedButton(
        onClick = onClick,
        shape = MaterialTheme.shapes.small,
        // The scheme's outline is drawn for a page, not for a black camera
        // canvas, where it disappears; a white hairline reads on both.
        border = androidx.compose.foundation.BorderStroke(1.dp, Color.White.copy(alpha = 0.45f)),
        modifier = Modifier
            .fillMaxWidth()
            .height(52.dp)
            .testTag(tag),
    ) { Text(label, color = Color.White) }
}

@Composable
private fun CardEditor(text: String, onText: (String) -> Unit, background: String) {
    val focus = remember { androidx.compose.ui.focus.FocusRequester() }
    // The card's own face, so what is typed looks like what will be posted.
    val family = MaterialTheme.typography.headlineLarge.fontFamily
    val hint = stringResource(R.string.stories_compose_text_hint)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .fillMaxSize()
            // The whole card is the field: a one-line box in the middle of an
            // empty screen is a target nobody hits first time.
            .clickable(
                interactionSource = remember { androidx.compose.foundation.interaction.MutableInteractionSource() },
                indication = null,
            ) { focus.requestFocus() }
            .padding(Spacing.xl),
    ) {
        if (text.isEmpty()) {
            Text(
                stringResource(R.string.stories_compose_text_hint),
                color = textOn(background).copy(alpha = 0.6f),
                fontSize = 30.sp,
                fontFamily = family,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            )
        }
        BasicTextField(
            value = text,
            onValueChange = onText,
            textStyle = TextStyle(
                color = textOn(background),
                fontSize = 30.sp,
                lineHeight = 36.sp,
                fontFamily = family,
                fontWeight = FontWeight.Bold,
                textAlign = TextAlign.Center,
            ),
            cursorBrush = SolidColor(textOn(background)),
            modifier = Modifier
                .fillMaxWidth()
                .focusRequester(focus)
                .semantics { contentDescription = hint }
                .testTag("stories.composer.text"),
        )
    }
}

@Composable
private fun BackgroundSwatches(selected: String, onPick: (String) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.spacedBy(Spacing.sm, Alignment.CenterHorizontally),
        modifier = Modifier
            .fillMaxWidth()
            .padding(vertical = Spacing.sm),
    ) {
        StoriesRules.BACKGROUNDS.forEachIndexed { position, key ->
            val label = stringResource(R.string.stories_compose_background, position + 1)
            Box(
                Modifier
                    .semantics {
                        role = Role.RadioButton
                        this.selected = key == selected
                        contentDescription = label
                    }
                    .size(32.dp)
                    .clip(CircleShape)
                    .background(backgroundBrush(key))
                    .border(if (key == selected) 3.dp else 1.dp, if (key == selected) Color.White else Color.White.copy(alpha = 0.4f), CircleShape)
                    .clickable { onPick(key) }
                    .testTag("stories.composer.bg.$key"),
            )
        }
    }
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

/** "Chama pra call": a voice room in one of the servers this person may post to. */
@Composable
private fun CallPicker(
    session: SessionStore,
    options: StoryAudienceOptions?,
    selected: Channel?,
    onPick: (Channel) -> Unit,
) {
    var rooms by remember { mutableStateOf<List<Pair<String, Channel>>?>(null) }
    LaunchedEffect(options) {
        val servers = options?.servers?.filter { it.canPost } ?: return@LaunchedEffect
        rooms = servers.flatMap { server ->
            runCatching { session.api.channels(server.serverId) }.getOrDefault(emptyList())
                .filter { it.type == "voice" }
                .map { server.serverName to it.copy(serverId = it.serverId ?: server.serverId) }
        }
    }
    Column(
        Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter)
            .clip(MaterialTheme.shapes.medium)
            .background(Color.Black.copy(alpha = 0.55f))
            .padding(Spacing.md)
            .height(180.dp)
            .verticalScroll(rememberScrollState())
            .testTag("stories.composer.callPicker"),
    ) {
        Text(stringResource(R.string.stories_sticker_call), color = Color.White, style = MaterialTheme.typography.titleSmall)
        Text(
            stringResource(R.string.stories_call_picker_body),
            color = Color.White.copy(alpha = 0.7f),
            style = MaterialTheme.typography.bodySmall,
        )
        val list = rooms
        when {
            list == null -> CircularProgressIndicator(color = Color.White, modifier = Modifier.padding(Spacing.sm).size(20.dp))
            list.isEmpty() -> Text(
                stringResource(R.string.stories_call_picker_none),
                color = Color.White.copy(alpha = 0.7f),
                modifier = Modifier.padding(top = Spacing.sm),
            )
            else -> list.forEach { (serverName, channel) ->
                Row(
                    verticalAlignment = Alignment.CenterVertically,
                    modifier = Modifier
                        .fillMaxWidth()
                        .clickable { onPick(channel) }
                        .padding(vertical = Spacing.xs)
                        .testTag("stories.composer.room"),
                ) {
                    RadioButton(selected = selected?.id == channel.id, onClick = { onPick(channel) })
                    Column {
                        Text(channel.name, color = Color.White, style = MaterialTheme.typography.bodyLarge)
                        Text(serverName, color = Color.White.copy(alpha = 0.6f), style = MaterialTheme.typography.bodySmall)
                    }
                }
            }
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

@Composable
private fun MediaPreview(media: PreparedMedia) {
    if (!media.isVideo) {
        AsyncImage(model = media.previewUri, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
        return
    }
    val context = LocalContext.current
    var frame by remember(media) { mutableStateOf<Bitmap?>(null) }
    LaunchedEffect(media) {
        frame = withContext(Dispatchers.IO) {
            runCatching {
                val retriever = MediaMetadataRetriever()
                try {
                    retriever.setDataSource(context, media.previewUri)
                    retriever.getFrameAtTime(0)
                } finally {
                    retriever.release()
                }
            }.getOrNull()
        }
    }
    frame?.let {
        Image(bitmap = it.asImageBitmap(), contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
    }
}

@Composable
private fun darkFieldColors() = TextFieldDefaults.colors(
    focusedContainerColor = Color.Black.copy(alpha = 0.45f),
    unfocusedContainerColor = Color.Black.copy(alpha = 0.45f),
    focusedIndicatorColor = Color.Transparent,
    unfocusedIndicatorColor = Color.Transparent,
    focusedTextColor = Color.White,
    unfocusedTextColor = Color.White,
    focusedPlaceholderColor = Color.White.copy(alpha = 0.6f),
    unfocusedPlaceholderColor = Color.White.copy(alpha = 0.6f),
)

/** A file in the app's cache for the system camera to write into. */
private fun captureTarget(context: Context, extension: String): Uri? = runCatching {
    val dir = File(context.cacheDir, "stories").apply { mkdirs() }
    val file = File(dir, "capture-${System.currentTimeMillis()}.$extension")
    FileProvider.getUriForFile(context, "${context.packageName}.stories", file)
}.getOrNull()

/** The system camera, told to stop at 30 s, the story limit. */
private class CaptureShortVideo : ActivityResultContracts.CaptureVideo() {
    override fun createIntent(context: Context, input: Uri): Intent =
        super.createIntent(context, input)
            .putExtra(MediaStore.EXTRA_DURATION_LIMIT, (StoriesRules.MAX_VIDEO_MS / 1000).toInt())
            .putExtra(MediaStore.EXTRA_VIDEO_QUALITY, 1)
}
