package gg.pqp.app.ui.screens

import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.IntOffset
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.bau.BauComposeGate
import gg.pqp.app.bau.BauLatest
import gg.pqp.app.bau.BauPreviewState
import gg.pqp.app.bau.CommunityHomeConfig
import gg.pqp.app.bau.CommunityHomeConfigs
import gg.pqp.app.bau.bauLatest
import gg.pqp.app.bau.bauPreviewState
import gg.pqp.app.bau.bauUnread
import gg.pqp.app.bau.ui.BauPreview
import gg.pqp.app.core.Channel
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.RealtimeClient
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.VoiceParticipant
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.screens.channels.CategoryHeader
import gg.pqp.app.ui.screens.channels.ChannelRow
import gg.pqp.app.ui.screens.channels.ChannelUnread
import gg.pqp.app.ui.screens.channels.CompactBarHeight
import gg.pqp.app.ui.screens.channels.CompactServerBar
import gg.pqp.app.ui.screens.channels.FoldedCategoriesStore
import gg.pqp.app.ui.screens.channels.SectionGap
import gg.pqp.app.ui.screens.channels.ServerBanner
import gg.pqp.app.ui.screens.channels.ServerBannerHeight
import gg.pqp.app.ui.screens.channels.VoiceOccupantRow
import gg.pqp.app.ui.screens.channels.VoiceOverflowRow
import gg.pqp.app.ui.screens.channels.channelsInCategory
import gg.pqp.app.ui.screens.channels.foldedSummary
import gg.pqp.app.ui.screens.channels.mutedChannelIds
import gg.pqp.app.ui.screens.channels.mutedChannels
import gg.pqp.app.ui.screens.channels.occupantSummary
import gg.pqp.app.ui.screens.channels.rowBadge
import gg.pqp.app.ui.screens.channels.sectionsOf
import gg.pqp.app.ui.screens.channels.serverActivity
import gg.pqp.app.ui.screens.channels.serverUnread
import gg.pqp.app.ui.screens.channels.withActivity
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.watch.WatchLiveStore
import gg.pqp.app.watch.WatchPartyListBlock
import gg.pqp.app.watch.liveHlsConfig
import gg.pqp.app.watch.watchPartyListBlock
import gg.pqp.app.watch.watchPartyListEntry
import gg.pqp.app.watch.ui.WatchPartyListBlockView
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.delay
import kotlinx.coroutines.flow.collectLatest
import kotlinx.coroutines.flow.filter
import kotlinx.coroutines.launch
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * How many times a `channels-update` refetch is tried before the list on
 * screen is left as it is. On `RealtimeClient.backoffMillis`, eight tries
 * span about a minute.
 */
private const val CHANNELS_REFETCH_TRIES = 8

/**
 * Tickets for every fetch of the channel list on this screen: the first load
 * and each `channels-update` refetch. A later fetch reads a later state of the
 * list, so a fetch may write it unless a newer one already has, and an older
 * list never lands on top of a newer one.
 *
 * Not "only the newest may write": a refetch that overtook the first load and
 * then failed through every retry left the screen with no list at all, though
 * the load had fetched one. Written tickets are what order the lists; taken
 * tickets only tell a refetch that a newer one is running.
 *
 * [takeFirst] is the first load of a server. Nothing taken before it may write
 * again, so a fetch still finishing for the server this screen just left is
 * stale as well.
 */
internal class ChannelListTickets {
    private var latest = 0
    private var written = 0

    /** A refetch starts. */
    @Synchronized
    fun take(): Int = ++latest

    /** The first load of a server starts; every fetch before it is stale. */
    @Synchronized
    fun takeFirst(): Int {
        latest += 1
        written = latest - 1
        return latest
    }

    /** No newer fetch has started since this one. */
    @Synchronized
    fun isLatest(ticket: Int): Boolean = ticket == latest

    /**
     * The fetch holding [ticket] has a list. True when it may write it, which
     * also makes it the newest list written; the caller then writes.
     */
    @Synchronized
    fun tryWrite(ticket: Int): Boolean {
        if (ticket <= written) return false
        written = ticket
        return true
    }
}

/** The list's item animation: fade and settle on the shared springs, never a slide. */
private fun Modifier.listMotion(scope: LazyItemScope): Modifier = with(scope) {
    this@listMotion.animateItem(
        fadeInSpec = spring(stiffness = 400f),
        placementSpec = spring(dampingRatio = 0.85f, stiffness = 380f, visibilityThreshold = IntOffset.VisibilityThreshold),
        fadeOutSpec = spring(stiffness = 600f),
    )
}

/**
 * A server's channels: the "Lista viva".
 *
 * The web sidebar on a phone. The server's banner at the top, shrinking into
 * a compact bar as the list scrolls; a live watch party as one red card above
 * everything; the Baú as a card while it has something new and a slim row
 * once it has been seen; then 40dp rows with no card around them, unread in
 * bold with a tick, mentions in lime, muted channels dimmed, categories that
 * fold, and under every voice room the people sitting in it.
 *
 * Who is talking is drawn only in the room this device is in. Nothing else
 * reaches this phone: the roster does not carry it, on purpose.
 *
 * The pieces live in `ui/screens/channels/` (rows, occupants, banner, rules)
 * and `bau/ui/BauPreview.kt`, so the next things to land here (forum
 * channels, a bottom bar) can add a piece rather than grow this file.
 */
@Composable
fun ChannelsScreen(
    session: SessionStore,
    voice: VoiceController,
    watch: WatchLiveStore,
    serverId: String,
    serverName: String,
    onBack: () -> Unit,
    onOpenChannel: (Channel) -> Unit,
    onOpenBau: () -> Unit = {},
) {
    var channels by remember { mutableStateOf<List<Channel>?>(null) }

    // The Baú needs two yeses: the instance flag, asked once per session, and
    // this server's own switch, which rides on the row `/api/servers` already
    // delivered. Either no, and nothing is drawn; there is nothing to tap into
    // on a server that would 404 it.
    val servers by session.servers.collectAsStateWithLifecycle()
    val server = servers.firstOrNull { it.id == serverId }
    var communityHome by remember { mutableStateOf(CommunityHomeConfig()) }
    LaunchedEffect(session) { communityHome = CommunityHomeConfigs.resolve(session.api) }
    val showBau = communityHome.enabled && server?.communityHomeEnabled == true

    val scope = rememberCoroutineScope()
    val voiceState by voice.state.collectAsStateWithLifecycle()
    val rooms by voice.rooms.rooms.collectAsStateWithLifecycle()
    val speakingPeers by voice.speakingPeers.collectAsStateWithLifecycle()
    // Which rooms have a picture on them. The server pushes a `channel-live`
    // for every live channel this person may see at socket auth.
    val liveChannels by watch.channels.collectAsStateWithLifecycle()
    // The party running (or drafted) in every `watch_party` channel this
    // account may see. See `WatchPartyListState.kt`.
    val parties by watch.parties.collectAsStateWithLifecycle()
    val phase by session.phase.collectAsStateWithLifecycle()
    val me = (phase as? SessionPhase.Ready)?.me

    // Watch-party eligibility: the server's live-hls config and this
    // account's permission bits, both fetched here because "may I host" on
    // the list itself needs them before any channel is opened.
    //
    // A FAILED LOOKUP MUST NOT READ AS A CONFIRMED NO. [liveHlsConfirmed] /
    // [permissionsConfirmed] flip to `true` only on an actual answer, the
    // defaults fail closed until then, and [retryTick] retries sooner on a
    // resume or a socket reconnect.
    var liveHlsEnabled by remember(serverId) { mutableStateOf(false) }
    var liveHlsConfirmed by remember(serverId) { mutableStateOf(false) }
    var permissions by remember(serverId) { mutableStateOf(PermissionsSnapshot()) }
    var permissionsConfirmed by remember(serverId) { mutableStateOf(false) }
    var retryTick by remember(serverId) { mutableIntStateOf(0) }

    LifecycleResumeEffect(serverId) {
        retryTick++
        onPauseOrDispose { }
    }
    LaunchedEffect(serverId) {
        session.realtime.state.collect { state ->
            if (state == RealtimeState.Ready) retryTick++
        }
    }

    LaunchedEffect(serverId, retryTick) {
        var attempt = 0
        while (!liveHlsConfirmed) {
            attempt++
            val config = runCatching { session.api.liveHlsConfig(serverId) }.getOrNull()
            if (config != null) {
                liveHlsEnabled = config.enabled
                liveHlsConfirmed = true
            } else {
                delay(RealtimeClient.backoffMillis(attempt))
            }
        }
    }
    LaunchedEffect(serverId, retryTick) {
        var attempt = 0
        while (!permissionsConfirmed) {
            attempt++
            val snapshot = runCatching { session.api.serverPermissions(serverId) }.getOrNull()
            if (snapshot != null) {
                permissions = snapshot
                permissionsConfirmed = true
            } else {
                delay(RealtimeClient.backoffMillis(attempt))
            }
        }
    }

    // Every fetch of the list takes a ticket (see [ChannelListTickets]).
    val channelsTickets = remember { ChannelListTickets() }
    LaunchedEffect(serverId) {
        val ticket = channelsTickets.takeFirst()
        val list = try {
            session.api.channels(serverId)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            emptyList()
        }
        if (channelsTickets.tryWrite(ticket)) channels = list
    }
    // A channel this viewer can see was created, renamed, moved or deleted.
    // The frame names no channel, so the list is refetched. Filtered to this
    // server BEFORE collectLatest, so only a newer nudge cancels a refetch.
    LaunchedEffect(serverId) {
        session.realtime.frames
            .filter { frame ->
                frame["type"]?.jsonPrimitive?.contentOrNull == "channels-update" &&
                    frame["serverId"]?.jsonPrimitive?.contentOrNull == serverId
            }
            .collectLatest {
                val ticket = channelsTickets.take()
                for (attempt in 1..CHANNELS_REFETCH_TRIES) {
                    val list = try {
                        session.api.channels(serverId)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        null
                    }
                    if (list != null) {
                        if (channelsTickets.tryWrite(ticket)) channels = list
                        return@collectLatest
                    }
                    if (!channelsTickets.isLatest(ticket)) return@collectLatest
                    if (attempt < CHANNELS_REFETCH_TRIES) {
                        delay(RealtimeClient.backoffMillis(attempt))
                    }
                }
            }
    }

    // Unread per channel. Fetched on every resume, because the moment it is
    // most wrong is coming back from a channel that was just read; the
    // `channel-activity` frame bumps it live in between, the same arithmetic
    // the iOS list does. A failed fetch keeps what is on screen.
    var unread by remember(serverId) { mutableStateOf<Map<String, ChannelUnread>>(emptyMap()) }
    LifecycleResumeEffect(serverId) {
        val job = scope.launch {
            runCatching { session.api.serverUnread(serverId) }.onSuccess { unread = it }
        }
        onPauseOrDispose { job.cancel() }
    }
    LaunchedEffect(serverId) {
        session.realtime.frames.collect { frame ->
            if (frame["type"]?.jsonPrimitive?.contentOrNull != "channel-activity") return@collect
            if (frame["serverId"]?.jsonPrimitive?.contentOrNull != serverId) return@collect
            val channelId = frame["channelId"]?.jsonPrimitive?.contentOrNull ?: return@collect
            val mention = frame["mention"]?.jsonPrimitive?.booleanOrNull ?: false
            unread = unread.withActivity(channelId, mention)
        }
    }

    // Silenced channels: what the session started with, then a fresh read so
    // a mute set on the web a minute ago shows here without a relaunch.
    var muted by remember(serverId) {
        mutableStateOf(mutedChannelIds(me?.preferences?.notifications?.channels))
    }
    LaunchedEffect(serverId) {
        runCatching { session.api.mutedChannels() }.onSuccess { muted = it }
    }

    // Folded categories, remembered per server on this device.
    val context = LocalContext.current
    val foldedStore = remember(context) { FoldedCategoriesStore(context.applicationContext) }
    val foldedFlow = remember(serverId) { foldedStore.folded(serverId) }
    val folded by foldedFlow.collectAsStateWithLifecycle(initialValue = emptySet())

    // The Baú preview. `/home/latest` when the API has it; a 404 means an
    // older API or the flag off for this server, and the screen falls back to
    // `/home/unread` and the plain row. Fetched on every resume (opening the
    // Baú marks it read, and coming back is what shrinks the card) and again
    // on the `community-home-update` nudge. A failure keeps what is drawn.
    var bauLatest by remember(serverId) { mutableStateOf<BauLatest?>(null) }
    var bauLegacyUnread by remember(serverId) { mutableIntStateOf(0) }
    var bauAnswered by remember(serverId) { mutableStateOf(false) }
    suspend fun refreshBau() {
        try {
            val latest = session.api.bauLatest(serverId)
            if (latest == null) {
                bauLegacyUnread = runCatching { session.api.bauUnread(serverId) }.getOrDefault(0)
            }
            bauLatest = latest
            bauAnswered = true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep what is on screen; a first failure draws today's row.
            if (!bauAnswered) {
                bauLegacyUnread = runCatching { session.api.bauUnread(serverId) }.getOrDefault(0)
                bauAnswered = true
            }
        }
    }
    LifecycleResumeEffect(serverId, showBau) {
        val job = if (showBau) scope.launch { refreshBau() } else null
        onPauseOrDispose { job?.cancel() }
    }
    LaunchedEffect(serverId, showBau) {
        if (!showBau) return@LaunchedEffect
        session.realtime.frames
            .filter { frame ->
                frame["type"]?.jsonPrimitive?.contentOrNull == "community-home-update" &&
                    frame["serverId"]?.jsonPrimitive?.contentOrNull == serverId
            }
            .collectLatest { refreshBau() }
    }
    val canPostToBau = BauComposeGate.canPost(communityHome, permissions.takeIf { permissionsConfirmed })
    val bauState = if (!bauAnswered) {
        BauPreviewState.Loading
    } else {
        bauPreviewState(bauLatest, bauLegacyUnread, canPostToBau)
    }

    val listState = rememberLazyListState()
    val density = LocalDensity.current
    val collapseAtPx = with(density) { (ServerBannerHeight - CompactBarHeight).toPx() }
    val collapsed by remember {
        derivedStateOf {
            listState.firstVisibleItemIndex > 0 || listState.firstVisibleItemScrollOffset > collapseAtPx
        }
    }

    val list = channels
    val activity = remember(list, rooms, liveChannels) {
        val ids = list.orEmpty().filter { it.isVoice }.map { it.id }
        serverActivity(
            voiceChannelIds = ids,
            rooms = rooms,
            liveChannelIds = list.orEmpty().map { it.id }.filter { liveChannels[it]?.live == true },
        )
    }

    Box(
        Modifier
            .fillMaxSize()
            .background(MaterialTheme.colorScheme.background),
    ) {
        LazyColumn(
            state = listState,
            modifier = Modifier.fillMaxSize(),
            contentPadding = PaddingValues(bottom = Spacing.xl),
        ) {
            item(key = "banner") {
                ServerBanner(
                    serverId = serverId,
                    serverName = serverName,
                    bannerUrl = server?.bannerUrl,
                    activity = activity,
                    scrolledPx = {
                        if (listState.firstVisibleItemIndex == 0) {
                            listState.firstVisibleItemScrollOffset.toFloat()
                        } else {
                            0f
                        }
                    },
                )
            }
            when {
                list == null -> item(key = "loading") {
                    Box(Modifier.fillMaxWidth().padding(Spacing.xl), contentAlignment = Alignment.Center) {
                        CircularProgressIndicator()
                    }
                }

                list.isEmpty() && !showBau -> item(key = "empty") {
                    EmptyState(stringResource(R.string.channels_empty), icon = PqpIcons.TextChannel)
                }

                else -> channelListItems(
                    list = list,
                    showBau = showBau,
                    bauState = bauState,
                    serverId = serverId,
                    parties = parties,
                    liveChannels = liveChannels,
                    permissions = permissions,
                    liveHlsEnabled = liveHlsEnabled,
                    unread = unread,
                    muted = muted,
                    folded = folded,
                    rooms = rooms,
                    callChannelId = voiceState.channelId.takeIf { voiceState.isActive },
                    callParticipants = voiceState.participants,
                    speakingPeers = speakingPeers,
                    myUserId = me?.id,
                    onOpenChannel = onOpenChannel,
                    onOpenBau = onOpenBau,
                    onToggleCategory = { categoryId ->
                        scope.launch { foldedStore.setFolded(serverId, categoryId, categoryId !in folded) }
                    },
                )
            }
        }
        CompactServerBar(
            serverName = serverName,
            activity = activity,
            collapsed = collapsed,
            onBack = onBack,
            modifier = Modifier.align(Alignment.TopCenter),
        )
    }
}

/**
 * Everything below the banner. A function over [LazyListScope] rather than a
 * composable, so each row, each person under a room and each folded section
 * is its own lazy item and animates in and out on its own.
 */
private fun LazyListScope.channelListItems(
    list: List<Channel>,
    showBau: Boolean,
    bauState: BauPreviewState,
    serverId: String,
    parties: Map<String, gg.pqp.app.watch.WatchPartyPayload>,
    liveChannels: Map<String, gg.pqp.app.watch.ChannelLive>,
    permissions: PermissionsSnapshot,
    liveHlsEnabled: Boolean,
    unread: Map<String, ChannelUnread>,
    muted: Set<String>,
    folded: Set<String>,
    rooms: Map<String, List<VoiceParticipant>>,
    callChannelId: String?,
    callParticipants: List<VoiceParticipant>,
    speakingPeers: Set<String>,
    myUserId: String?,
    onOpenChannel: (Channel) -> Unit,
    onOpenBau: () -> Unit,
    onToggleCategory: (String) -> Unit,
) {
    val sections = sectionsOf(list)
    // Every `watch_party` channel this server has, folded into ONE block: a
    // live or pending party sits above everything, and the "Criar watch
    // party" row sits at the end of the list, where creating one belongs.
    val watchPartyBlock = watchPartyListBlock(
        list.filter { it.type == "watch_party" }.map { channel ->
            watchPartyListEntry(
                channelId = channel.id,
                channelName = channel.name,
                party = parties[channel.id],
                watching = liveChannels[channel.id]?.watching,
                canHost = liveHlsEnabled &&
                    hasPermission(permissions.channelBits(channel.id), Permission.START_WATCH_PARTY),
            )
        },
    )
    val openById: (String) -> Unit = { id -> list.firstOrNull { it.id == id }?.let(onOpenChannel) }

    if (watchPartyBlock !is WatchPartyListBlock.None && watchPartyBlock !is WatchPartyListBlock.Host) {
        item(key = "watchParty") {
            Box(Modifier.listMotion(this).padding(top = Spacing.xs)) {
                WatchPartyListBlockView(block = watchPartyBlock, onOpen = openById, onHost = openById)
            }
        }
    }
    if (showBau) {
        item(key = "bau") {
            Box(Modifier.listMotion(this).padding(top = Spacing.xs)) {
                BauPreview(state = bauState, serverId = serverId, onOpen = onOpenBau)
            }
        }
    }

    sections.forEachIndexed { index, section ->
        val categoryId = section.categoryId
        val continued = index > 0 && sections[index - 1].group == section.group
        val isFolded = categoryId != null && categoryId in folded
        item(key = "header-${section.key}") {
            Box(Modifier.listMotion(this)) {
                when {
                    // One category arrives as two sections, text then voice,
                    // for the `position` reason in `sectionsOf`. Its heading is
                    // drawn once; the second half keeps only nothing, so the
                    // voice rooms sit right under the text channels.
                    continued -> Unit
                    categoryId == null || section.title.isBlank() -> SectionGap()
                    else -> CategoryHeader(
                        title = section.title,
                        folded = isFolded,
                        summary = foldedSummary(channelsInCategory(sections, categoryId), unread, muted),
                        onToggle = { onToggleCategory(categoryId) },
                    )
                }
            }
        }
        if (isFolded) return@forEachIndexed
        section.channels.forEach { channel ->
            channelItems(
                channel = channel,
                badge = rowBadge(unread[channel.id], channel.id in muted),
                live = liveChannels[channel.id]?.live == true,
                people = when {
                    !channel.isVoice -> emptyList()
                    channel.id == callChannelId -> rooms[channel.id] ?: callParticipants
                    else -> rooms[channel.id].orEmpty()
                },
                inCall = channel.id == callChannelId,
                speakingPeers = speakingPeers,
                myUserId = myUserId,
                onOpenChannel = onOpenChannel,
            )
        }
    }

    if (watchPartyBlock is WatchPartyListBlock.Host) {
        item(key = "watchParty-host") {
            Box(Modifier.listMotion(this).padding(top = Spacing.sm)) {
                WatchPartyListBlockView(block = watchPartyBlock, onOpen = openById, onHost = openById)
            }
        }
    }
}

/** One channel's row, then the people in it when it is a voice room. */
private fun LazyListScope.channelItems(
    channel: Channel,
    badge: gg.pqp.app.ui.screens.channels.RowBadge,
    live: Boolean,
    people: List<VoiceParticipant>,
    inCall: Boolean,
    speakingPeers: Set<String>,
    myUserId: String?,
    onOpenChannel: (Channel) -> Unit,
) {
    val summary = occupantSummary(people, myUserId)
    item(key = channel.id) {
        ChannelRow(
            channel = channel,
            badge = badge,
            inCall = inCall,
            live = live,
            occupants = summary.total,
            // Opening a voice channel shows its transcript; it does not ask
            // for the microphone. The chat header owns the explicit join.
            onClick = { onOpenChannel(channel) },
            modifier = Modifier.listMotion(this),
        )
    }
    summary.listed.forEach { person ->
        item(key = "occupant-${channel.id}-${person.userId}") {
            VoiceOccupantRow(
                participant = person,
                isSelf = person.userId == myUserId,
                // Only in this device's own call; see [VoiceController.speakingPeers].
                speaking = inCall && person.peerId in speakingPeers,
                onClick = { onOpenChannel(channel) },
                modifier = Modifier.listMotion(this),
            )
        }
    }
    if (summary.overflow.isNotEmpty()) {
        item(key = "occupants-more-${channel.id}") {
            VoiceOverflowRow(
                people = summary.overflow,
                onClick = { onOpenChannel(channel) },
                modifier = Modifier.listMotion(this),
            )
        }
    }
    if (people.isNotEmpty()) {
        item(key = "occupants-gap-${channel.id}") {
            Spacer(Modifier.height(Spacing.xs).listMotion(this))
        }
    }
}
