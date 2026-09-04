package gg.pqp.app.ui.screens

import android.Manifest
import android.content.pm.PackageManager
import android.os.Build
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.snap
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.SnackbarHost
import androidx.compose.material3.SnackbarHostState
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.material3.rememberTopAppBarState
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
import androidx.compose.ui.input.nestedscroll.nestedScroll
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.core.content.ContextCompat
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.bau.CommunityHomeConfig
import gg.pqp.app.bau.CommunityHomeConfigs
import gg.pqp.app.bau.bauUnread
import gg.pqp.app.core.Channel
import gg.pqp.app.core.SessionStore
import gg.pqp.app.social.ui.CountBadge
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.components.SectionLabel
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.Motion
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.Refusal
import gg.pqp.app.voice.VoiceController
import kotlinx.coroutines.launch
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * A server's channels.
 *
 * Ordering has one trap in it: `position` is unique only within a sibling
 * group, and top-level text channels, top-level voice channels and categories
 * are three separate groups that all carry `parentId == null`. Sorting them as
 * one list interleaves three sequences of 0, 1, 2. They are rendered as
 * separate sections for that reason, not for looks.
 *
 * Visually this is the web app's sidebar on a phone, and it is drawn that way
 * on purpose: chrome at the top carrying the server itself, then uppercase
 * section rules and inset pills on the page below. It is not a settings menu
 * with a title, which is what it read as before, and the difference is almost
 * entirely the app bar and the pill.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ChannelsScreen(
    session: SessionStore,
    voice: VoiceController,
    serverId: String,
    serverName: String,
    onBack: () -> Unit,
    onOpenChannel: (Channel) -> Unit,
    onOpenBau: () -> Unit = {},
) {
    var channels by remember { mutableStateOf<List<Channel>?>(null) }

    // The Baú row needs two yeses: the instance flag, asked once per session,
    // and this server's own switch, which rides on the row `/api/servers`
    // already delivered. Either no, and the row is not drawn; there is
    // nothing to tap into on a server that would 404 it.
    val servers by session.servers.collectAsStateWithLifecycle()
    var communityHome by remember { mutableStateOf(CommunityHomeConfig()) }
    LaunchedEffect(session) { communityHome = CommunityHomeConfigs.resolve(session.api) }
    val showBau = communityHome.enabled &&
        servers.firstOrNull { it.id == serverId }?.communityHomeEnabled == true

    val scrollBehavior = TopAppBarDefaults.pinnedScrollBehavior(rememberTopAppBarState())
    val context = LocalContext.current
    val snackbars = remember { SnackbarHostState() }
    val scope = rememberCoroutineScope()
    val voiceState by voice.state.collectAsStateWithLifecycle()

    // Held across the permission round trip: the system dialog takes the app
    // out of the foreground, so the channel that was tapped cannot be a local
    // in the click handler.
    var pendingVoice by remember { mutableStateOf<Channel?>(null) }

    val micDenied = stringResource(R.string.voice_mic_denied)
    val callPermissions = rememberLauncherForActivityResult(
        ActivityResultContracts.RequestMultiplePermissions(),
    ) { _ ->
        val channel = pendingVoice
        pendingVoice = null
        // Only the microphone gates the call. Notifications are asked for in
        // the same breath because the foreground service's notification is what
        // the person uses to get back to the call and to hang up, and a refusal
        // there leaves a call running that nothing on screen mentions.
        //
        // The answer is read back from the permission itself rather than from
        // the results map: the map only carries what was *asked* this time, so
        // a request that only needed notifications would otherwise read as a
        // microphone refusal.
        val micGranted =
            ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) ==
                PackageManager.PERMISSION_GRANTED
        when {
            micGranted && channel != null -> voice.join(channel.id, channel.name)
            !micGranted -> scope.launch { snackbars.showSnackbar(micDenied) }
        }
    }

    fun joinVoice(channel: Channel) {
        val wanted = buildList {
            if (
                ContextCompat.checkSelfPermission(context, Manifest.permission.RECORD_AUDIO) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.RECORD_AUDIO)
            }
            if (
                Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU &&
                ContextCompat.checkSelfPermission(context, Manifest.permission.POST_NOTIFICATIONS) !=
                PackageManager.PERMISSION_GRANTED
            ) {
                add(Manifest.permission.POST_NOTIFICATIONS)
            }
        }
        if (wanted.isEmpty()) {
            voice.join(channel.id, channel.name)
        } else {
            pendingVoice = channel
            callPermissions.launch(wanted.toTypedArray())
        }
    }

    val roomFull = stringResource(R.string.voice_room_full)
    val unsupported = stringResource(R.string.voice_transport_unsupported)
    val screenDenied = stringResource(R.string.voice_screen_share_denied)
    LaunchedEffect(voiceState.refusal) {
        when (voiceState.refusal) {
            Refusal.RoomFull -> snackbars.showSnackbar(roomFull)
            Refusal.TransportUnsupported -> snackbars.showSnackbar(unsupported)
            Refusal.ScreenShareDenied -> snackbars.showSnackbar(screenDenied)
            null -> return@LaunchedEffect
        }
        voice.dismissRefusal()
    }

    // Voice moderation. The frame carries the whole sentence, already written
    // and already translated by the server, so it is shown verbatim rather than
    // mapped onto a string this client picked. An eviction the target cannot
    // see is indistinguishable from a network failure.
    LaunchedEffect(voiceState.notice) {
        val notice = voiceState.notice ?: return@LaunchedEffect
        snackbars.showSnackbar(notice)
        voice.dismissNotice()
    }

    LaunchedEffect(serverId) {
        channels = runCatching { session.api.channels(serverId) }.getOrDefault(emptyList())
    }

    // The Baú's unread count, for the badge on its row.
    //
    // Fetched on every resume rather than once, because the moment it is most
    // wrong is the moment this screen comes back from the Baú itself: the feed
    // marked itself read while this screen sat in the back stack at CREATED,
    // and a badge that survives the read it is counting is the bug on the web
    // this whole endpoint pair exists to end. The live nudge covers the other
    // direction, a post published while somebody is looking at the list.
    // Zero on any failure, which is the one honest number when the count is
    // not known, and also what an older server with no route at all answers.
    var bauUnread by remember { mutableStateOf(0) }
    LifecycleResumeEffect(serverId, showBau) {
        if (showBau) {
            scope.launch {
                bauUnread = runCatching { session.api.bauUnread(serverId) }.getOrDefault(0)
            }
        }
        onPauseOrDispose { }
    }
    LaunchedEffect(serverId, showBau) {
        if (!showBau) return@LaunchedEffect
        session.realtime.frames.collect { frame ->
            when (frame["type"]?.jsonPrimitive?.contentOrNull) {
                "community-home-update" -> {
                    if (frame["serverId"]?.jsonPrimitive?.contentOrNull != serverId) return@collect
                    bauUnread = runCatching { session.api.bauUnread(serverId) }.getOrDefault(0)
                }
            }
        }
    }

    Scaffold(
        modifier = Modifier
            .fillMaxSize()
            .nestedScroll(scrollBehavior.nestedScrollConnection),
        topBar = {
            Column {
                TopAppBar(
                    // The bar carries the server, not just its name. A phone
                    // has no room for the web app's column of server icons, so
                    // this squircle is the only thing on the screen that says
                    // which place these channels belong to, and it is the same
                    // derived colour the servers list gave it.
                    title = {
                        Row(verticalAlignment = Alignment.CenterVertically) {
                            Avatar(
                                name = serverName,
                                url = null,
                                size = Sizes.avatarSmall,
                                // Nine rather than fourteen: the same corner to
                                // size ratio the 44dp squircle has, so the two
                                // read as one shape at two sizes.
                                cornerRadius = 9.dp,
                                seed = serverId,
                            )
                            Spacer(Modifier.width(Spacing.md))
                            Text(
                                text = serverName,
                                style = MaterialTheme.typography.titleLarge,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    navigationIcon = {
                        IconButton(onClick = onBack) {
                            Icon(
                                imageVector = PqpIcons.Back,
                                contentDescription = stringResource(R.string.chat_back),
                                modifier = Modifier.size(Sizes.iconAction),
                            )
                        }
                    },
                    colors = pqpTopBarColors(),
                    scrollBehavior = scrollBehavior,
                )
                // The rule is what makes the bar the frame and the list the
                // page. Without it the two dark surfaces meet with nothing
                // between them and the eye reads one tall field.
                ChromeDivider()
            }
        },
        snackbarHost = { SnackbarHost(snackbars) },
    ) { padding ->
        val list = channels
        when {
            list == null -> Box(
                Modifier.fillMaxSize().padding(padding),
                contentAlignment = Alignment.Center,
            ) { CircularProgressIndicator() }

            list.isEmpty() && !showBau -> Box(Modifier.padding(padding)) {
                EmptyState(stringResource(R.string.channels_empty), icon = PqpIcons.TextChannel)
            }

            else -> {
                val sections = remember(list) { sectionsOf(list) }
                LazyColumn(
                    modifier = Modifier.fillMaxSize().padding(padding),
                    contentPadding = PaddingValues(bottom = Spacing.xl),
                ) {
                    // Above TEXT, where the web sidebar puts it. It is not a
                    // channel and is not drawn as one: it carries its own hint
                    // so nobody opens it expecting to type.
                    if (showBau) {
                        item(key = "bau") {
                            Spacer(Modifier.height(Spacing.sm))
                            BauRow(unread = bauUnread, onClick = onOpenBau)
                        }
                    }
                    sections.forEachIndexed { index, section ->
                        item(key = "header-${section.key}") {
                            SectionHeader(
                                title = section.title,
                                // One category arrives as two sections, text
                                // then voice, for the `position` reason above.
                                // Drawing its name over both of them puts
                                // GERAL directly under GERAL, which reads as
                                // two categories that happen to share a name.
                                // The heading is drawn once and the second
                                // group keeps only its gap, which is what the
                                // web sidebar looks like and is also the truth:
                                // it is one category with channels of two
                                // kinds. Compared on the category id rather
                                // than the name, so two different categories
                                // called "geral" still get a heading each.
                                continued = index > 0 &&
                                    sections[index - 1].group == section.group,
                            )
                        }
                        items(section.channels.size, key = { section.channels[it].id }) { index ->
                            val channel = section.channels[index]
                            ChannelRow(
                                channel = channel,
                                inCall = voiceState.channelId == channel.id,
                                onClick = {
                                    if (channel.isVoice) joinVoice(channel) else onOpenChannel(channel)
                                },
                            )
                        }
                    }
                }
            }
        }
    }
}

/**
 * The Baú's row. Same pill as a channel, so it sits in the list, but with a
 * second line: the one thing a person needs to know before tapping is that
 * this is not a place to type.
 *
 * The badge is the quiet one. A new post is "there is something here", which
 * the number already says by existing; the lime is kept for a mention, and
 * nothing in the Baú can mention anybody.
 */
@Composable
private fun BauRow(unread: Int, onClick: () -> Unit) {
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.railInset)
            .heightIn(min = Sizes.channelRow)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.md, vertical = Spacing.xs)
            .testTag("channels.bau"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Box(
            modifier = Modifier.size(Sizes.iconInline),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = PqpIcons.Bau,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Column(Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.bau_title),
                style = MaterialTheme.typography.bodyLarge,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = stringResource(R.string.bau_row_hint),
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
        }
        if (unread > 0) {
            Spacer(Modifier.width(Spacing.sm))
            CountBadge(
                count = unread,
                loud = false,
                modifier = Modifier.testTag("channels.bau.unread"),
            )
        }
    }
}

private data class Section(val key: String, val title: String, val channels: List<Channel>) {
    /**
     * Which category this section belongs to, with the `-text` / `-voice` half
     * dropped. Two sections in the same group are one category split by the
     * ordering rule, and only the first of them draws a heading.
     */
    val group: String get() = key.substringBeforeLast('-')
}

/**
 * Categories first as containers, then whatever sits at the top level.
 *
 * A category is a channel row with `type == "category"`, not a separate object,
 * and its children point at it through `parentId`.
 */
private fun sectionsOf(all: List<Channel>): List<Section> {
    val categories = all.filter { it.isCategory }.sortedBy { it.position }
    val byParent = all.filterNot { it.isCategory }.groupBy { it.parentId }

    val sections = mutableListOf<Section>()

    fun add(key: String, title: String, channels: List<Channel>) {
        if (channels.isNotEmpty()) sections += Section(key, title, channels.sortedBy { it.position })
    }

    val topLevel = byParent[null].orEmpty()
    add("top-text", "", topLevel.filter { it.isText })
    add("top-voice", "", topLevel.filter { it.isVoice })

    categories.forEach { category ->
        val children = byParent[category.id].orEmpty()
        add("cat-${category.id}-text", category.name, children.filter { it.isText })
        add("cat-${category.id}-voice", category.name, children.filter { it.isVoice })
    }

    return sections
}

/**
 * A named category is a section rule; an unnamed group is only a breath.
 *
 * The blank-title case is the top-level text and voice groups, which exist
 * because of the `position` trap above rather than because a person put a
 * heading there. Giving them an invented heading would be inventing copy, so
 * they keep the gap that separates them and say nothing. A continued category
 * is the same case for a different reason and gets the same treatment.
 */
@Composable
private fun SectionHeader(title: String, continued: Boolean) {
    if (title.isBlank() || continued) {
        Spacer(Modifier.height(Spacing.sm))
        return
    }
    SectionLabel(title)
}

@Composable
private fun ChannelRow(channel: Channel, inCall: Boolean, onClick: () -> Unit) {
    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()

    // Selected and pressed are the same fill on purpose, so pressing a row is a
    // preview of where the finger is about to land rather than a separate
    // effect happening on the way there.
    val filled = inCall || pressed
    val surface by animateColorAsState(
        targetValue = if (filled) {
            MaterialTheme.colorScheme.surfaceContainerHigh
        } else {
            Color.Transparent
        },
        animationSpec = if (filled) snap() else tween(Motion.QUICK_MILLIS),
        label = "channel-row-press",
    )

    // The one lime object this screen is allowed, and it means exactly what the
    // colour always means here: this is the call you are in right now. No bold,
    // no dot, no badge; a second marker would only say the same thing again.
    val content = if (inCall) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurface
    }
    val glyph = if (inCall) {
        MaterialTheme.colorScheme.primary
    } else {
        MaterialTheme.colorScheme.onSurfaceVariant
    }

    Row(
        modifier = Modifier
            .fillMaxWidth()
            // Inset from the screen edge and rounded, which is simultaneously
            // the most Discord-shaped thing in the app and exactly what
            // `NavigationDrawerItem` draws. The name lands 4dp to the right of
            // the section rule above it, which is the pill's own inset showing
            // and is what stops the two from looking accidentally misaligned.
            .padding(horizontal = Spacing.railInset)
            .heightIn(min = Sizes.channelRow)
            .clip(MaterialTheme.shapes.small)
            .background(surface)
            .clickable(
                interactionSource = interactions,
                // No ripple: the pill above already is the press.
                indication = null,
                onClick = onClick,
            )
            .padding(horizontal = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        // A fixed box rather than a bare icon, so the hash, the speaker and the
        // padlock are three different widths that all start their name at the
        // same x. A ragged left edge down twenty channel names is the kind of
        // thing nobody names and everybody sees.
        Box(
            modifier = Modifier.size(Sizes.iconInline),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = when {
                    channel.isPrivate -> PqpIcons.PrivateChannel
                    channel.isVoice -> PqpIcons.VoiceChannel
                    else -> PqpIcons.TextChannel
                },
                contentDescription = null,
                tint = glyph,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Text(
            text = channel.name,
            style = MaterialTheme.typography.bodyLarge,
            color = content,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
