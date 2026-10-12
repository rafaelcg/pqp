package gg.pqp.app.stories.ui

import android.provider.Settings
import androidx.annotation.OptIn
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.gestures.detectTapGestures
import androidx.compose.foundation.gestures.detectVerticalDragGestures
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
import androidx.compose.foundation.pager.HorizontalPager
import androidx.compose.foundation.pager.PagerDefaults
import androidx.compose.foundation.pager.rememberPagerState
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TextField
import androidx.compose.material3.TextFieldDefaults
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.focus.onFocusChanged
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.input.pointer.pointerInput
import androidx.compose.ui.semantics.CustomAccessibilityAction
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.customActions
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.selected
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.LocalFocusManager
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.compose.ui.window.Dialog
import androidx.compose.ui.window.DialogProperties
import androidx.compose.ui.zIndex
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.media3.common.MediaItem
import androidx.media3.common.Player
import androidx.media3.common.util.UnstableApi
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.reports.ReportTarget
import gg.pqp.app.reports.ui.ReportSheet
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoriesStore
import gg.pqp.app.stories.Story
import gg.pqp.app.stories.StoryAuthor
import gg.pqp.app.stories.deleteStory
import gg.pqp.app.stories.muteStories
import gg.pqp.app.stories.reactToStory
import gg.pqp.app.stories.removeStoryFromServer
import gg.pqp.app.stories.replyToStory
import gg.pqp.app.stories.stories
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.absoluteValue
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

/** The story clock runs in real time whatever the animator duration scale says. */
private object RealTimeClock : androidx.compose.ui.MotionDurationScale {
    override val scaleFactor: Float = 1f
}

/** One person's stories, as the strip hands them to the viewer. */
data class StoryDeck(val author: StoryAuthor, val storyIds: List<String>)

/**
 * The story viewer: full screen, over whatever opened it, so closing returns
 * exactly where the person was.
 *
 * - Tap right / left: next / previous story. Hold: pause, and the chrome
 *   fades out after a beat. Swipe across: the next or previous person, as a
 *   deck (the outgoing card recedes and dims while the next slides over it).
 *   Swipe down: close.
 * - Progress bars are linear clocks: photo 5 s, text 5 s plus 50 ms a
 *   character (10 s at most), a call sticker 8 s, a video its own length.
 * - A story counts as seen after a second on screen; the store batches it.
 * - Every motion here is Compose's, so it follows the animator duration
 *   scale. At zero the deck transform and the drag shrink are skipped
 *   outright; the gestures keep working.
 */
@OptIn(UnstableApi::class)
@androidx.compose.runtime.Composable
fun StoryViewer(
    session: SessionStore,
    store: StoriesStore,
    decks: List<StoryDeck>,
    startDeck: Int,
    /** "QG do pqp" or "Amigos": the audience this strip is seen through. */
    contextLabel: String,
    contextServerId: String?,
    onDismiss: () -> Unit,
    onJoinCall: (serverId: String, channelId: String, channelName: String) -> Unit,
) {
    val context = LocalContext.current
    val animationsOn = remember {
        Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f
    }
    val pager = rememberPagerState(initialPage = startDeck.coerceIn(0, (decks.size - 1).coerceAtLeast(0))) { decks.size }
    val scope = rememberCoroutineScope()
    val dragY = remember { Animatable(0f) }
    val density = LocalDensity.current
    val dismissPx = with(density) { 120.dp.toPx() }

    Dialog(
        onDismissRequest = onDismiss,
        properties = DialogProperties(usePlatformDefaultWidth = false, decorFitsSystemWindows = false),
    ) {
        val fraction = (dragY.value / (dismissPx * 3)).coerceIn(0f, 1f)
        Box(
            Modifier
                .fillMaxSize()
                .background(Color.Black.copy(alpha = 1f - fraction * 0.6f))
                .testTag("stories.viewer"),
        ) {
            HorizontalPager(
                state = pager,
                beyondViewportPageCount = 1,
                flingBehavior = PagerDefaults.flingBehavior(
                    state = pager,
                    snapAnimationSpec = spring(dampingRatio = 0.86f, stiffness = 600f),
                ),
                modifier = Modifier
                    .fillMaxSize()
                    .graphicsLayer {
                        translationY = dragY.value
                        if (animationsOn) {
                            val shrink = 1f - 0.15f * fraction
                            scaleX = shrink
                            scaleY = shrink
                        }
                    }
                    .pointerInput(Unit) {
                        detectVerticalDragGestures(
                            onDragEnd = {
                                scope.launch {
                                    if (dragY.value > dismissPx) onDismiss() else dragY.animateTo(0f, spring())
                                }
                            },
                            onDragCancel = { scope.launch { dragY.animateTo(0f) } },
                            onVerticalDrag = { _, dy ->
                                scope.launch { dragY.snapTo((dragY.value + dy).coerceAtLeast(0f)) }
                            },
                        )
                    },
            ) { page ->
                val offset = (pager.currentPage - page) + pager.currentPageOffsetFraction
                DeckPage(
                    session = session,
                    store = store,
                    deck = decks[page],
                    active = pager.currentPage == page && !pager.isScrollInProgress,
                    contextLabel = contextLabel,
                    contextServerId = contextServerId,
                    onNextDeck = {
                        if (page + 1 < decks.size) {
                            scope.launch { pager.animateScrollToPage(page + 1) }
                        } else {
                            onDismiss()
                        }
                    },
                    onPreviousDeck = {
                        if (page > 0) scope.launch { pager.animateScrollToPage(page - 1) }
                    },
                    onClose = onDismiss,
                    onJoinCall = onJoinCall,
                    modifier = Modifier
                        // The deck: the card on the way out recedes to -28%,
                        // shrinks to .9 and dims, while the next one slides
                        // over it one to one with the finger.
                        .zIndex(if (offset > 0f) 0f else 1f)
                        .graphicsLayer {
                            if (animationsOn && offset > 0f && offset <= 1f) {
                                translationX = size.width * offset * 0.72f
                                val scale = 1f - 0.1f * offset
                                scaleX = scale
                                scaleY = scale
                                alpha = 1f - 0.55f * offset.absoluteValue
                            }
                        },
                )
            }
        }
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun DeckPage(
    session: SessionStore,
    store: StoriesStore,
    deck: StoryDeck,
    active: Boolean,
    contextLabel: String,
    contextServerId: String?,
    onNextDeck: () -> Unit,
    onPreviousDeck: () -> Unit,
    onClose: () -> Unit,
    onJoinCall: (String, String, String) -> Unit,
    modifier: Modifier = Modifier,
) {
    val phase by session.phase.collectAsStateWithLifecycle()
    val meId = (phase as? SessionPhase.Ready)?.me?.id
    val removed by store.removed.collectAsState()
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current

    var loaded by remember(deck) { mutableStateOf<List<Story>?>(null) }
    var failed by remember(deck) { mutableStateOf(false) }
    LaunchedEffect(deck) {
        runCatching { session.api.stories(deck.storyIds) }
            .onSuccess { list ->
                val order = deck.storyIds.withIndex().associate { it.value to it.index }
                loaded = list.sortedBy { order[it.id] ?: Int.MAX_VALUE }
            }
            .onFailure { failed = true }
    }
    val stories = loaded?.filterNot { it.id in removed }

    var index by remember(deck) { mutableIntStateOf(-1) }
    LaunchedEffect(loaded) {
        val list = loaded ?: return@LaunchedEffect
        if (index < 0) index = StoriesRules.startIndex(list)
        if (list.isEmpty()) onNextDeck()
    }
    LaunchedEffect(stories?.size) {
        val list = stories ?: return@LaunchedEffect
        if (list.isEmpty() && loaded?.isNotEmpty() == true) onNextDeck()
        if (index >= list.size && list.isNotEmpty()) index = list.size - 1
    }

    var holding by remember { mutableStateOf(false) }
    var typing by remember { mutableStateOf(false) }
    // The story the viewers sheet was opened FOR. A tap that advanced the deck
    // while a lagging sheet came up must not make the sheet (and its Apagar)
    // belong to the next story.
    var sheetStory by remember { mutableStateOf<Story?>(null) }
    val sheetOpen = sheetStory != null
    var menuOpen by remember { mutableStateOf(false) }
    var reporting by remember { mutableStateOf<Story?>(null) }
    var confirmingDelete by remember { mutableStateOf<Story?>(null) }
    var muted by remember { mutableStateOf(true) }
    val paused = holding || typing || sheetOpen || menuOpen || reporting != null || confirmingDelete != null

    val story = stories?.getOrNull(index)
    val progress = remember(story?.id) { Animatable(0f) }
    var videoProgress by remember(story?.id) { mutableFloatStateOf(0f) }

    val advance: () -> Unit = {
        val list = stories.orEmpty()
        if (index < list.lastIndex) index += 1 else onNextDeck()
    }
    val back: () -> Unit = {
        if (index > 0) index -= 1 else onPreviousDeck()
    }

    // The clock for a photo, a text card or a call sticker. Linear, because it
    // is a clock; it stops where it is when paused and resumes from there.
    LaunchedEffect(story?.id, active, paused) {
        val current = story ?: return@LaunchedEffect
        if (current.kind == "video" || !active || paused) {
            progress.stop()
            return@LaunchedEffect
        }
        val total = StoriesRules.displayMs(current)
        val left = ((1f - progress.value) * total).toInt().coerceAtLeast(1)
        // A clock, not an animation: Compose scales every animateTo by the
        // system animator duration scale, and at 0 ("Remove animations") the
        // tween would finish in one frame, skipping every photo and text
        // story before it is seen. Pin the scale to 1 for this one.
        withContext(RealTimeClock) { progress.animateTo(1f, tween(left, easing = LinearEasing)) }
        advance()
    }

    // Seen after a second on screen, never for the author's own.
    LaunchedEffect(story?.id, active) {
        val current = story ?: return@LaunchedEffect
        if (!active || current.own != null) return@LaunchedEffect
        delay(StoriesRules.SEEN_AFTER_MS)
        store.markSeen(current.id, meId)
    }

    val chromeAlpha by animateFloatAsState(if (holding) 0f else 1f, tween(200), label = "story-chrome")
    val nextLabel = stringResource(R.string.stories_viewer_next)
    val previousLabel = stringResource(R.string.stories_viewer_previous)
    val pauseLabel = stringResource(R.string.stories_viewer_pause)
    val resumeLabel = stringResource(R.string.stories_viewer_resume)

    Box(modifier.fillMaxSize().background(Color.Black)) {
        when {
            failed -> Text(
                stringResource(R.string.error_network),
                color = Color.White,
                modifier = Modifier.align(Alignment.Center),
            )
            story == null -> CircularProgressIndicator(Modifier.align(Alignment.Center), color = Color.White)
            else -> {
                // The story itself, with the gestures on it.
                Box(
                    Modifier
                        .fillMaxSize()
                        // The tap zones are invisible to TalkBack, so the same
                        // moves are offered as custom actions.
                        .semantics {
                            customActions = listOf(
                                CustomAccessibilityAction(nextLabel) { advance(); true },
                                CustomAccessibilityAction(previousLabel) { back(); true },
                                CustomAccessibilityAction(if (holding) resumeLabel else pauseLabel) { holding = !holding; true },
                            )
                        }
                        .pointerInput(story.id) {
                            detectTapGestures(
                                onPress = {
                                    val hold = scope.launch {
                                        delay(250)
                                        holding = true
                                        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
                                    }
                                    tryAwaitRelease()
                                    hold.cancel()
                                    holding = false
                                },
                                // Present so a hold never also counts as a tap.
                                onLongPress = {},
                                onTap = { at -> if (at.x < size.width / 3f) back() else advance() },
                            )
                        }
                        .testTag("stories.viewer.content"),
                ) {
                    StoryBody(
                        story = story,
                        active = active,
                        paused = paused,
                        muted = muted,
                        onVideoProgress = { videoProgress = it },
                        onVideoEnded = advance,
                    )
                    story.call?.let { call ->
                        CallStickerCard(
                            call = call,
                            onJoin = {
                                onJoinCall(call.serverId, call.channelId, call.channelName)
                                onClose()
                            },
                            modifier = Modifier
                                .align(Alignment.Center)
                                .padding(top = 160.dp),
                        )
                    }
                }

                // Writing a reply: the story pauses and steps back.
                val dim by animateFloatAsState(if (typing) 0.45f else 0f, tween(200), label = "story-dim")
                if (dim > 0f) Box(Modifier.fillMaxSize().background(Color.Black.copy(alpha = dim)))

                // Chrome: bars and header on top, reply and reactions below.
                Column(
                    Modifier
                        .fillMaxWidth()
                        .statusBarsPadding()
                        .graphicsLayer { alpha = chromeAlpha }
                        .background(Brush.verticalGradient(listOf(Color.Black.copy(alpha = 0.55f), Color.Transparent)))
                        .padding(horizontal = Spacing.sm, vertical = Spacing.sm),
                ) {
                    ProgressBars(
                        count = stories.size,
                        index = index,
                        progress = if (story.kind == "video") videoProgress else progress.value,
                    )
                    Spacer(Modifier.height(Spacing.sm))
                    Header(
                        story = story,
                        contextLabel = contextLabel,
                        muted = muted,
                        onToggleMute = { muted = !muted },
                        menuOpen = menuOpen,
                        onMenu = { menuOpen = it },
                        onClose = onClose,
                        menu = {
                            StoryMenu(
                                story = story,
                                onDismiss = { menuOpen = false },
                                onDelete = { confirmingDelete = story },
                                onMute = {
                                    scope.launch {
                                        runCatching { session.api.muteStories(story.author.id) }
                                        store.refresh(contextServerId?.let(store::serverKey) ?: StoriesStore.FRIENDS)
                                        onNextDeck()
                                    }
                                },
                                onReport = { reporting = story },
                                onModRemove = { serverId ->
                                    scope.launch {
                                        val ok = runCatching { session.api.removeStoryFromServer(serverId, story.id) }.isSuccess
                                        if (ok) {
                                            store.forget(story.id)
                                            store.refresh(store.serverKey(serverId))
                                        }
                                    }
                                },
                            )
                        },
                    )
                }

                Column(
                    Modifier
                        .align(Alignment.BottomCenter)
                        .fillMaxWidth()
                        .graphicsLayer { alpha = chromeAlpha }
                        .background(Brush.verticalGradient(listOf(Color.Transparent, Color.Black.copy(alpha = 0.6f))))
                        .navigationBarsPadding()
                        .imePadding()
                        .padding(Spacing.md),
                ) {
                    story.caption?.takeIf { it.isNotBlank() && story.kind != "text" }?.let {
                        Text(
                            it,
                            color = Color.White,
                            style = MaterialTheme.typography.bodyLarge,
                            modifier = Modifier.padding(bottom = Spacing.sm),
                        )
                    }
                    if (story.own != null) {
                        OwnFooter(story = story, onOpenViewers = { sheetStory = story })
                    } else {
                        ReplyFooter(
                            session = session,
                            story = story,
                            onFocus = { typing = it },
                        )
                    }
                }
            }
        }
    }

    sheetStory?.let { target ->
        StoryViewersSheet(
            session = session,
            store = store,
            story = target,
            onDismiss = { sheetStory = null },
            onDelete = {
                sheetStory = null
                confirmingDelete = target
            },
        )
    }

    reporting?.let { target ->
        ReportSheet(
            api = session.api,
            target = ReportTarget.Story(target.id, target.author.displayName, contextServerId),
            onDismiss = { reporting = null },
        )
    }

    confirmingDelete?.let { target ->
        AlertDialog(
            onDismissRequest = { confirmingDelete = null },
            text = { Text(stringResource(R.string.stories_own_delete_confirm)) },
            confirmButton = {
                TextButton(
                    onClick = {
                        confirmingDelete = null
                        scope.launch {
                            val ok = runCatching { session.api.deleteStory(target.id) }.isSuccess
                            if (ok) store.forget(target.id)
                        }
                    },
                    modifier = Modifier.testTag("stories.delete.confirm"),
                ) { Text(stringResource(R.string.stories_own_delete), color = MaterialTheme.colorScheme.error) }
            },
            dismissButton = {
                TextButton(onClick = { confirmingDelete = null }) { Text(stringResource(R.string.cancel)) }
            },
        )
    }
}

@Composable
private fun ProgressBars(count: Int, index: Int, progress: Float) {
    Row(horizontalArrangement = Arrangement.spacedBy(4.dp), modifier = Modifier.fillMaxWidth()) {
        repeat(count) { i ->
            val fill = when {
                i < index -> 1f
                i == index -> progress.coerceIn(0f, 1f)
                else -> 0f
            }
            Box(
                Modifier
                    .weight(1f)
                    .height(3.dp)
                    .clip(RoundedCornerShape(2.dp))
                    .background(Color.White.copy(alpha = 0.3f)),
            ) {
                // scaleX from the start edge: a clock is never a width animation.
                Box(
                    Modifier
                        .fillMaxSize()
                        .graphicsLayer {
                            transformOrigin = androidx.compose.ui.graphics.TransformOrigin(0f, 0.5f)
                            scaleX = fill
                        }
                        .background(Color.White),
                )
            }
        }
    }
}

@Composable
private fun Header(
    story: Story,
    contextLabel: String,
    muted: Boolean,
    onToggleMute: () -> Unit,
    menuOpen: Boolean,
    onMenu: (Boolean) -> Unit,
    onClose: () -> Unit,
    menu: @Composable () -> Unit,
) {
    val now = System.currentTimeMillis()
    Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.fillMaxWidth()) {
        AuthorAvatar(story.author, 32.dp)
        Spacer(Modifier.width(Spacing.sm))
        Column(Modifier.weight(1f)) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = if (story.own != null) stringResource(R.string.stories_yours) else story.author.displayName,
                    color = Color.White,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                StoriesRules.age(story.publishedAt, now)?.let {
                    Text(
                        "  $it",
                        color = Color.White.copy(alpha = 0.7f),
                        style = MaterialTheme.typography.labelMedium,
                    )
                }
            }
            Text(
                text = contextLabel,
                color = Color.White.copy(alpha = 0.7f),
                style = MaterialTheme.typography.labelMedium,
                maxLines = 1,
            )
        }
        if (story.kind == "video") {
            IconButton(onClick = onToggleMute) {
                Icon(
                    if (muted) PqpIcons.Deafened else PqpIcons.Listening,
                    contentDescription = stringResource(
                        if (muted) R.string.stories_viewer_sound_on else R.string.stories_viewer_sound_off,
                    ),
                    tint = Color.White,
                )
            }
        }
        Box {
            IconButton(onClick = { onMenu(true) }, modifier = Modifier.testTag("stories.viewer.more")) {
                Icon(PqpIcons.More, contentDescription = stringResource(R.string.stories_viewer_more), tint = Color.White)
            }
            DropdownMenu(expanded = menuOpen, onDismissRequest = { onMenu(false) }) { menu() }
        }
        IconButton(onClick = onClose, modifier = Modifier.testTag("stories.viewer.close")) {
            Icon(PqpIcons.Close, contentDescription = stringResource(R.string.stories_viewer_close), tint = Color.White)
        }
    }
}

@Composable
private fun StoryMenu(
    story: Story,
    onDismiss: () -> Unit,
    onDelete: () -> Unit,
    onMute: () -> Unit,
    onReport: () -> Unit,
    onModRemove: (String) -> Unit,
) {
    if (story.own != null) {
        DropdownMenuItem(
            text = { Text(stringResource(R.string.stories_own_delete), color = MaterialTheme.colorScheme.error) },
            onClick = {
                onDismiss()
                onDelete()
            },
            modifier = Modifier.testTag("stories.menu.delete"),
        )
        return
    }
    DropdownMenuItem(
        text = { Text(stringResource(R.string.stories_menu_mute, story.author.displayName)) },
        onClick = {
            onDismiss()
            onMute()
        },
        modifier = Modifier.testTag("stories.menu.mute"),
    )
    DropdownMenuItem(
        text = { Text(stringResource(R.string.stories_menu_report)) },
        onClick = {
            onDismiss()
            onReport()
        },
        modifier = Modifier.testTag("stories.menu.report"),
    )
    // A moderator owns only their server's slice of a story that may also be
    // in friends and in other servers.
    story.viewer.canModerate.forEach { serverId ->
        val name = story.audiences.firstOrNull { it.serverId == serverId }?.serverName ?: return@forEach
        DropdownMenuItem(
            text = { Text(stringResource(R.string.stories_menu_mod_remove, name), color = MaterialTheme.colorScheme.error) },
            onClick = {
                onDismiss()
                onModRemove(serverId)
            },
            modifier = Modifier.testTag("stories.menu.modRemove"),
        )
    }
}

/** What fills the screen: the picture, the clip, or the text card. */
@OptIn(UnstableApi::class)
@Composable
private fun StoryBody(
    story: Story,
    active: Boolean,
    paused: Boolean,
    muted: Boolean,
    onVideoProgress: (Float) -> Unit,
    onVideoEnded: () -> Unit,
) {
    val media = story.media
    when {
        story.kind == "text" -> TextCard(story.text.orEmpty(), story.background)
        story.own?.status == "processing" || story.own?.status == "pending" -> Box(Modifier.fillMaxSize()) {
            Text(
                stringResource(R.string.stories_own_processing),
                color = Color.White,
                modifier = Modifier.align(Alignment.Center),
            )
        }
        story.kind == "video" && media != null -> StoryVideo(
            url = absolute(media.url),
            posterUrl = media.posterUrl?.let(::absolute),
            active = active,
            paused = paused,
            muted = muted,
            onProgress = onVideoProgress,
            onEnded = onVideoEnded,
        )
        media != null -> AsyncImage(
            model = absolute(media.url),
            contentDescription = story.caption,
            contentScale = ContentScale.Fit,
            modifier = Modifier.fillMaxSize(),
        )
    }
}

@OptIn(UnstableApi::class)
@Composable
private fun StoryVideo(
    url: String,
    posterUrl: String?,
    active: Boolean,
    paused: Boolean,
    muted: Boolean,
    onProgress: (Float) -> Unit,
    onEnded: () -> Unit,
) {
    val context = LocalContext.current
    var ready by remember(url) { mutableStateOf(false) }
    val player = remember(url) {
        ExoPlayer.Builder(context).build().apply {
            setMediaItem(MediaItem.fromUri(url))
            repeatMode = Player.REPEAT_MODE_OFF
            prepare()
        }
    }
    DisposableEffect(player) {
        val listener = object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_READY) ready = true
                if (state == Player.STATE_ENDED) onEnded()
            }
        }
        player.addListener(listener)
        onDispose {
            player.removeListener(listener)
            player.release()
        }
    }
    LaunchedEffect(active, paused) { player.playWhenReady = active && !paused }
    LaunchedEffect(muted) { player.volume = if (muted) 0f else 1f }
    LaunchedEffect(player, active) {
        while (active) {
            val duration = player.duration
            if (duration > 0) onProgress((player.currentPosition.toFloat() / duration).coerceIn(0f, 1f))
            delay(50)
        }
    }
    Box(Modifier.fillMaxSize()) {
        AndroidView(
            factory = { PlayerView(it).apply { useController = false; this.player = player } },
            modifier = Modifier.fillMaxSize(),
        )
        // The poster until the first frame, so the open never flashes black.
        if (!ready && posterUrl != null) {
            AsyncImage(model = posterUrl, contentDescription = null, contentScale = ContentScale.Fit, modifier = Modifier.fillMaxSize())
        }
    }
}

/** A text card is data, drawn here: crisp on every screen, nothing stored. */
@Composable
fun TextCard(text: String, background: String?, modifier: Modifier = Modifier, fontSize: Int = 34) {
    Box(
        modifier = modifier
            .fillMaxSize()
            .background(backgroundBrush(background)),
        contentAlignment = Alignment.Center,
    ) {
        Text(
            text = text,
            color = textOn(background),
            fontSize = fontSize.sp,
            lineHeight = (fontSize + 6).sp,
            fontFamily = MaterialTheme.typography.headlineLarge.fontFamily,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(horizontal = Spacing.xl),
        )
    }
}

/** `STORY_BACKGROUNDS`: two stops each, so a card has depth without an image. */
fun backgroundBrush(key: String?): Brush {
    val (top, bottom) = when (key) {
        "lime" -> Palette.Signal to Palette.SignalDim
        "ember" -> Color(0xFF7A1F12) to Color(0xFFE0662E)
        "grape" -> Color(0xFF2B1446) to Color(0xFF7B3FB0)
        "sand" -> Color(0xFF8C6A3E) to Color(0xFFE2C48E)
        "ink" -> Color(0xFF0A0A0A) to Color(0xFF2A2F36)
        else -> Color(0xFF0B1020) to Color(0xFF1E2A4A)
    }
    return Brush.verticalGradient(listOf(top, bottom))
}

fun textOn(background: String?): Color = when (background) {
    "lime", "sand" -> Palette.Ink
    else -> Color.White
}

/** The call sticker, live: who is in the room right now, and one tap to join. */
@Composable
private fun CallStickerCard(
    call: gg.pqp.app.stories.StoryCallLive,
    onJoin: () -> Unit,
    modifier: Modifier = Modifier,
) {
    Column(
        modifier = modifier
            .padding(horizontal = Spacing.xl)
            .fillMaxWidth()
            .clip(MaterialTheme.shapes.medium)
            .background(Color.Black.copy(alpha = 0.55f))
            .border(1.dp, Palette.Signal.copy(alpha = 0.6f), MaterialTheme.shapes.medium)
            .padding(Spacing.md)
            .testTag("stories.callSticker"),
    ) {
        Text(
            text = stringResource(
                when (call.state) {
                    "live" -> R.string.stories_call_live
                    "full" -> R.string.stories_call_full
                    else -> R.string.stories_call_ended
                },
            ).uppercase(),
            color = Palette.Signal,
            style = MaterialTheme.typography.labelSmall,
        )
        Text(call.channelName, color = Color.White, style = MaterialTheme.typography.titleMedium)
        if (call.participants.isNotEmpty()) {
            Row(verticalAlignment = Alignment.CenterVertically, modifier = Modifier.padding(vertical = Spacing.xs)) {
                call.participants.take(5).forEach { person ->
                    Box(Modifier.padding(end = 2.dp)) { AuthorAvatar(person, 22.dp) }
                }
                Spacer(Modifier.width(Spacing.xs))
                Text(
                    call.participants.joinToString(", ") { it.displayName.substringBefore(' ') },
                    color = Color.White.copy(alpha = 0.8f),
                    style = MaterialTheme.typography.bodySmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (call.joinable) {
            Button(
                onClick = onJoin,
                shape = MaterialTheme.shapes.small,
                colors = ButtonDefaults.buttonColors(containerColor = Palette.Signal, contentColor = Palette.Ink),
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(top = Spacing.sm)
                    .testTag("stories.callSticker.join"),
            ) {
                Icon(PqpIcons.Listening, contentDescription = null, modifier = Modifier.size(16.dp))
                Spacer(Modifier.width(Spacing.xs))
                Text(stringResource(R.string.stories_call_join))
            }
        }
    }
}

@Composable
private fun OwnFooter(story: Story, onOpenViewers: () -> Unit) {
    val own = story.own ?: return
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onOpenViewers)
            .padding(Spacing.sm)
            .testTag("stories.viewers.open"),
    ) {
        Icon(PqpIcons.SlideUp, contentDescription = null, tint = Color.White, modifier = Modifier.size(18.dp))
        Spacer(Modifier.width(Spacing.xs))
        Text(stringResource(R.string.stories_viewers_title, own.viewCount), color = Color.White)
    }
}

/**
 * Reply and react. A text reply becomes a message in the 1:1 with the author;
 * a reaction stays on the story and only the author sees it. Focusing the box
 * pauses the story and raises the full reaction row.
 */
@Composable
private fun ReplyFooter(session: SessionStore, story: Story, onFocus: (Boolean) -> Unit) {
    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val focus = LocalFocusManager.current
    var text by remember(story.id) { mutableStateOf("") }
    /** The words of a reply that has not been confirmed yet, and its nonce. */
    var pendingReply by remember(story.id) { mutableStateOf<Pair<String, String>?>(null) }
    var focused by remember { mutableStateOf(false) }
    var reaction by remember(story.id) { mutableStateOf(story.viewer.reaction) }
    var flash by remember(story.id) { mutableStateOf<String?>(null) }
    LaunchedEffect(flash) {
        if (flash != null) {
            delay(1_200)
            flash = null
        }
    }
    val react: (String) -> Unit = { value ->
        val next = if (reaction == value) null else value
        reaction = next
        haptics.performHapticFeedback(HapticFeedbackType.TextHandleMove)
        if (next != null) flash = StoriesRules.reactionGlyph(next)
        scope.launch { runCatching { session.api.reactToStory(story.id, next) } }
    }
    val sentLabel = stringResource(R.string.stories_viewer_sent)

    Column {
        flash?.let {
            Text(
                stringResource(R.string.stories_viewer_reacted, it),
                color = Color.White,
                style = MaterialTheme.typography.labelLarge,
                modifier = Modifier
                    .align(Alignment.CenterHorizontally)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.5f))
                    .padding(horizontal = Spacing.md, vertical = Spacing.xs)
                    .testTag("stories.reacted"),
            )
            Spacer(Modifier.height(Spacing.sm))
        }
        AnimatedVisibility(
            visible = focused,
            enter = fadeIn(tween(200)) + slideInVertically(tween(200)) { it / 3 },
            exit = fadeOut(tween(150)),
        ) {
            ReactionRow(selected = reaction, onReact = react)
        }
        if (!story.viewer.canReply) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                Text(
                    text = when (story.viewer.replyBlockedReason) {
                        "dm_closed" -> stringResource(R.string.stories_viewer_dm_closed, story.author.displayName)
                        else -> stringResource(R.string.stories_viewer_replies_off, story.author.displayName)
                    },
                    color = Color.White.copy(alpha = 0.75f),
                    style = MaterialTheme.typography.bodySmall,
                    modifier = Modifier.weight(1f),
                )
                ReactionChip("gg", selected = reaction == "gg", onClick = { react("gg") })
            }
            return@Column
        }
        Row(verticalAlignment = Alignment.CenterVertically) {
            TextField(
                value = text,
                onValueChange = { text = it.take(StoriesRules.REPLY_MAX) },
                singleLine = true,
                placeholder = { Text(stringResource(R.string.stories_viewer_reply_to, story.author.displayName.substringBefore(' '))) },
                shape = CircleShape,
                colors = TextFieldDefaults.colors(
                    focusedContainerColor = Color.Black.copy(alpha = 0.4f),
                    unfocusedContainerColor = Color.Black.copy(alpha = 0.4f),
                    focusedIndicatorColor = Color.Transparent,
                    unfocusedIndicatorColor = Color.Transparent,
                    focusedTextColor = Color.White,
                    unfocusedTextColor = Color.White,
                    focusedPlaceholderColor = Color.White.copy(alpha = 0.7f),
                    unfocusedPlaceholderColor = Color.White.copy(alpha = 0.7f),
                    cursorColor = Palette.Signal,
                ),
                modifier = Modifier
                    .weight(1f)
                    .onFocusChanged {
                        focused = it.isFocused
                        onFocus(it.isFocused)
                    }
                    .testTag("stories.reply"),
            )
            Spacer(Modifier.width(Spacing.sm))
            if (text.isBlank()) {
                ReactionChip("gg", selected = reaction == "gg", onClick = { react("gg") })
            } else {
                IconButton(
                    onClick = {
                        val body = text.trim()
                        // A retry of the same words reuses the nonce, so an
                        // answer lost on the way back never sends the DM twice.
                        val nonce = pendingReply?.takeIf { it.first == body }?.second
                            ?: java.util.UUID.randomUUID().toString()
                        pendingReply = body to nonce
                        text = sentLabel
                        focus.clearFocus()
                        scope.launch {
                            val ok = runCatching { session.api.replyToStory(story.id, body, nonce) }.isSuccess
                            if (ok) {
                                pendingReply = null
                                // The reply may have opened a conversation the
                                // list has never held, and no frame tells the
                                // person who sent it.
                                SocialRepository.of(session).refreshConversations()
                            }
                            delay(1_200)
                            text = if (ok) "" else body
                        }
                    },
                    modifier = Modifier
                        .clip(CircleShape)
                        .background(Palette.Signal)
                        .testTag("stories.reply.send"),
                ) {
                    Icon(PqpIcons.Send, contentDescription = stringResource(R.string.stories_viewer_send), tint = Palette.Ink)
                }
            }
        }
    }
}

@Composable
private fun ReactionRow(selected: String?, onReact: (String) -> Unit) {
    Row(
        horizontalArrangement = Arrangement.SpaceEvenly,
        modifier = Modifier
            .fillMaxWidth()
            .padding(bottom = Spacing.sm)
            .clip(CircleShape)
            .background(Color.Black.copy(alpha = 0.45f))
            .padding(vertical = Spacing.xs)
            .testTag("stories.reactions"),
    ) {
        StoriesRules.REACTIONS.forEach { reaction ->
            ReactionChip(reaction, selected = selected == reaction, onClick = { onReact(reaction) })
        }
    }
}

@Composable
private fun ReactionChip(reaction: String, selected: Boolean, onClick: () -> Unit) {
    val glyph = StoriesRules.reactionGlyph(reaction)
    val reactLabel = stringResource(R.string.stories_viewer_react, glyph)
    Box(
        contentAlignment = Alignment.Center,
        modifier = Modifier
            .size(44.dp)
            .clip(CircleShape)
            .background(if (reaction == "gg") Palette.Signal.copy(alpha = 0.18f) else Color.Transparent)
            .then(if (selected) Modifier.border(2.dp, Palette.Signal, CircleShape) else Modifier)
            .semantics {
                role = Role.Button
                this.selected = selected
                contentDescription = reactLabel
            }
            .clickable(onClick = onClick)
            .testTag("stories.react.$reaction"),
    ) {
        Text(
            glyph,
            color = if (reaction == "gg") Palette.Signal else Color.White,
            fontWeight = if (reaction == "gg") FontWeight.Black else null,
            fontSize = if (reaction == "gg") 15.sp else 22.sp,
        )
    }
}

/** A story URL is either signed storage or an API path; the API one needs the host. */
fun absolute(url: String): String = if (url.startsWith("/")) Backend.apiUrl.trimEnd('/') + url else url

