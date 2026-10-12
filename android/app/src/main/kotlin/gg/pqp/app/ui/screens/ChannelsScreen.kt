package gg.pqp.app.ui.screens

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.VisibilityThreshold
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.unit.dp
import gg.pqp.app.core.parsePermissionBits
import gg.pqp.app.ui.screens.channels.CategoryNameDialog
import gg.pqp.app.ui.screens.channels.ChannelLayoutConfig
import gg.pqp.app.ui.screens.channels.ChannelLayoutMemory
import gg.pqp.app.ui.screens.channels.ChannelLayoutSaveOutcome
import gg.pqp.app.ui.screens.channels.ChannelLayoutSaveResult
import gg.pqp.app.ui.screens.channels.ChannelOrganizerDialog
import gg.pqp.app.ui.screens.channels.LayoutRow
import gg.pqp.app.ui.screens.channels.SidebarLayout
import gg.pqp.app.ui.screens.channels.applyChannelLayout
import gg.pqp.app.ui.screens.channels.applyLayoutToChannels
import gg.pqp.app.ui.screens.channels.channelLayoutConfig
import gg.pqp.app.ui.screens.channels.createChannel
import gg.pqp.app.ui.screens.channels.layoutToPayload
import gg.pqp.app.ui.screens.channels.mixedLayoutOf
import gg.pqp.app.ui.screens.channels.renameChannel
import gg.pqp.app.ui.theme.Sizes
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.LazyItemScope
import androidx.compose.foundation.lazy.LazyListScope
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.lazy.rememberLazyListState
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.derivedStateOf
import androidx.compose.runtime.getValue
import androidx.compose.runtime.key
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateMapOf
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
import androidx.compose.ui.unit.IntSize
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
import gg.pqp.app.ui.screens.channels.ChannelSection
import gg.pqp.app.ui.screens.channels.ChannelRow
import gg.pqp.app.ui.screens.channels.ChannelUnread
import gg.pqp.app.ui.screens.channels.CompactBarHeight
import gg.pqp.app.ui.screens.channels.CompactServerBar
import gg.pqp.app.ui.screens.channels.FoldedCategoriesStore
import gg.pqp.app.ui.screens.channels.SectionGap
import gg.pqp.app.stories.ui.StoriesSection
import gg.pqp.app.ui.screens.channels.ServerBanner
import gg.pqp.app.ui.screens.channels.ServerBannerHeight
import gg.pqp.app.ui.screens.channels.VoiceOccupantRow
import gg.pqp.app.ui.screens.channels.VoiceOverflowRow
import gg.pqp.app.ui.screens.channels.foldedSummary
import gg.pqp.app.ui.screens.channels.mutedChannelIds
import gg.pqp.app.ui.screens.channels.mutedChannels
import gg.pqp.app.ui.screens.channels.occupantSummary
import gg.pqp.app.ui.screens.channels.rowBadge
import gg.pqp.app.ui.screens.channels.sectionsOf
import gg.pqp.app.ui.screens.channels.serverActivity
import gg.pqp.app.ui.screens.channels.serverUnread
import gg.pqp.app.ui.screens.channels.UnreadLedger
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.contentOrNull
import kotlinx.serialization.json.jsonPrimitive

/**
 * How many times a `channels-update` refetch is tried before the list on
 * screen is left as it is. On `RealtimeClient.backoffMillis`, eight tries
 * span about a minute.
 */
private const val CHANNELS_REFETCH_TRIES = 8

/** How long the unread list waits before its first settling re-read; doubles after. */
private const val UNREAD_SETTLE_DELAY_MS = 1_500L

/** Settling re-reads after an overlapped answer: 1.5 s, 3 s, 6 s, 12 s. */
private const val UNREAD_SETTLE_PASSES = 4

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
    /** A story's call sticker: join that room (maybe in another server) and open it. */
    onJoinStoryCall: (serverId: String, channelId: String, channelName: String) -> Unit = { _, _, _ -> },
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

    // Which list to draw: the mixed one (categories are the only headings)
    // only when `GET …/channel-layout` says `mixed`; a 404 is an older server
    // and the old list. Seeded from the last answer this device saw so a
    // mixed server does not flash the old list, then asked on open, on every
    // resume and reconnect ([retryTick]) and on every `channels-update`.
    val appContext = LocalContext.current.applicationContext
    val layoutMemory = remember(appContext) { ChannelLayoutMemory(appContext) }
    var layoutConfig by remember(serverId) { mutableStateOf(ChannelLayoutConfig.Legacy) }
    var layoutAnswered by remember(serverId) { mutableStateOf(false) }
    fun adoptLayout(next: ChannelLayoutConfig) {
        layoutAnswered = true
        if (next == layoutConfig) return
        layoutConfig = next
        scope.launch { layoutMemory.save(serverId, next) }
    }
    suspend fun refreshLayoutConfig() {
        try {
            adoptLayout(session.api.channelLayoutConfig(serverId) ?: ChannelLayoutConfig.Legacy)
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep drawing whatever is drawn; the next resume asks again.
        }
    }
    LaunchedEffect(serverId) {
        val remembered = layoutMemory.load(serverId)
        if (!layoutAnswered) layoutConfig = remembered
    }
    LaunchedEffect(serverId, retryTick) { refreshLayoutConfig() }
    val mixed = layoutConfig.mixed
    // Reorder, create in a category, Criar categoria: MANAGE_CHANNELS
    // server-wide, the same permission the PUT checks.
    val canManageChannels = permissionsConfirmed &&
        hasPermission(parsePermissionBits(permissions.server), Permission.MANAGE_CHANNELS)
    var organizing by remember(serverId) { mutableStateOf(false) }
    var layoutNotice by remember(serverId) { mutableStateOf<String?>(null) }
    var newChannelIn by remember(serverId) { mutableStateOf<Pair<Channel, String>?>(null) }
    var creatingCategory by remember(serverId) { mutableStateOf(false) }

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
                // Which list to draw may have changed with it (the mixed list
                // switched on for this server, or a reorder bumped the version).
                refreshLayoutConfig()
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

    // Unread per channel. Fetched on every resume (via [retryTick]), because
    // the moment it is most wrong is coming back from a channel that was just
    // read, and on every socket reconnect; retried on the socket's backoff when
    // it fails. The `channel-activity` frame bumps it live in between, the same
    // arithmetic the iOS list does, and [UnreadLedger] replays any frame that
    // lands while a snapshot is in flight so the snapshot cannot erase it.
    val unreadLedger = remember(serverId) { UnreadLedger() }
    // A state map, so a frame changes one entry in place.
    val unread = remember(serverId) { mutableStateMapOf<String, ChannelUnread>() }
    LaunchedEffect(serverId, retryTick) {
        // When a frame overlapped the request the answer is a floor, so ask
        // again a moment later (see [UnreadLedger]), backing off, until an
        // answer lands with nothing in flight. Bounded, so a channel that never
        // goes quiet costs a few reads, not a loop; the next resume, reconnect
        // or frame carries on from there.
        for (pass in 0..UNREAD_SETTLE_PASSES) {
            if (pass > 0) delay(UNREAD_SETTLE_DELAY_MS shl (pass - 1))
            val ticket = unreadLedger.begin()
            var reconciled: UnreadLedger.Reconciled? = null
            var answered = false
            try {
                for (attempt in 1..CHANNELS_REFETCH_TRIES) {
                    val snapshot = try {
                        session.api.serverUnread(serverId)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        null
                    }
                    if (snapshot != null) {
                        answered = true
                        reconciled = unreadLedger.snapshot(ticket, snapshot)
                        reconciled?.let { fresh ->
                            unread.keys.retainAll(fresh.counts.keys)
                            unread.putAll(fresh.counts)
                        }
                        break
                    }
                    if (attempt < CHANNELS_REFETCH_TRIES) delay(RealtimeClient.backoffMillis(attempt))
                }
            } finally {
                // Gave up, or cancelled mid-request (a resume restarting this
                // effect): stop buffering for this ticket. A no-op when a newer
                // request has already begun, which keeps its buffer.
                if (!answered) unreadLedger.abandon(ticket)
            }
            if (!answered) return@LaunchedEffect
            if (reconciled?.unsettled != true) return@LaunchedEffect
        }
    }
    LaunchedEffect(serverId) {
        session.realtime.frames.collect { frame ->
            if (frame["type"]?.jsonPrimitive?.contentOrNull != "channel-activity") return@collect
            if (frame["serverId"]?.jsonPrimitive?.contentOrNull != serverId) return@collect
            val channelId = frame["channelId"]?.jsonPrimitive?.contentOrNull ?: return@collect
            val mention = frame["mention"]?.jsonPrimitive?.booleanOrNull ?: false
            unread[channelId] = unreadLedger.activity(channelId, mention)
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
    // `/home/unread` and the plain row, going straight there for the rest of
    // this visit. Fetched on every resume (opening the Baú marks it read, and
    // coming back is what shrinks the card), on a reconnect, and on the
    // `community-home-update` nudge. One refresh at a time ([bauRefresh]), so
    // an older answer never lands after a newer one. A failure keeps what is
    // drawn.
    var bauLatest by remember(serverId) { mutableStateOf<BauLatest?>(null) }
    var bauLegacyUnread by remember(serverId) { mutableIntStateOf(0) }
    var bauAnswered by remember(serverId) { mutableStateOf(false) }
    var bauLatestUnsupported by remember(serverId) { mutableStateOf(false) }
    val bauRefresh = remember(serverId) { Mutex() }
    suspend fun refreshBau() = bauRefresh.withLock {
        try {
            val latest = if (bauLatestUnsupported) null else session.api.bauLatest(serverId)
            if (latest == null) {
                bauLatestUnsupported = true
                bauLegacyUnread = runCatching { session.api.bauUnread(serverId) }.getOrElse { bauLegacyUnread }
            }
            bauLatest = latest
            bauAnswered = true
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            // Keep what is on screen; a first failure draws today's row.
            if (!bauAnswered) {
                bauLegacyUnread = runCatching { session.api.bauUnread(serverId) }.getOrElse { bauLegacyUnread }
                bauAnswered = true
            }
        }
    }
    LaunchedEffect(serverId, showBau, retryTick) {
        if (showBau) refreshBau()
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
    // Derived from the channel list only, so a roster or unread change does
    // not regroup and sort every channel again.
    val textTitle = stringResource(R.string.channels_section_text)
    val voiceTitle = stringResource(R.string.channels_section_voice)
    val sections = remember(list, textTitle, voiceTitle, mixed, canManageChannels) {
        list?.let {
            sectionsOf(it, textTitle, voiceTitle, mixed = mixed, keepEmptyCategories = canManageChannels)
        }.orEmpty()
    }

    // --- The mixed list's writes ---

    val failedText = stringResource(R.string.channels_reorder_failed)
    val organizeLabel = stringResource(R.string.channels_organize)
    fun writeChannels(next: List<Channel>) {
        val ticket = channelsTickets.take()
        if (channelsTickets.tryWrite(ticket)) channels = next
    }
    suspend fun freshLayoutVersion(): Int? = try {
        session.api.channelLayoutConfig(serverId)?.version
    } catch (e: CancellationException) {
        throw e
    } catch (_: Exception) {
        null
    }

    /**
     * Sends a whole order, drawn at once and put back if refused. A 409
     * because the list moved adopts the server's list and version.
     */
    suspend fun saveLayout(next: SidebarLayout<LayoutRow>, baseVersion: Int): ChannelLayoutSaveOutcome {
        val before = channels ?: return ChannelLayoutSaveOutcome.Failed(failedText)
        writeChannels(applyLayoutToChannels(before, next))
        return try {
            when (val result = session.api.applyChannelLayout(serverId, layoutToPayload(next, baseVersion))) {
                is ChannelLayoutSaveResult.Saved -> {
                    // A null read-back: saved, keep the order drawn above.
                    result.channels?.let(::writeChannels)
                    adoptLayout(ChannelLayoutConfig(mixed = true, version = result.version))
                    ChannelLayoutSaveOutcome.Saved
                }
                is ChannelLayoutSaveResult.Stale -> {
                    writeChannels(result.channels)
                    adoptLayout(ChannelLayoutConfig(mixed = true, version = result.version))
                    ChannelLayoutSaveOutcome.Stale(mixedLayoutOf(result.channels), result.version)
                }
                ChannelLayoutSaveResult.Off -> {
                    writeChannels(before)
                    adoptLayout(ChannelLayoutConfig.Legacy)
                    ChannelLayoutSaveOutcome.Off
                }
                is ChannelLayoutSaveResult.Invalid -> {
                    writeChannels(before)
                    ChannelLayoutSaveOutcome.Failed(result.message)
                }
            }
        } catch (e: CancellationException) {
            writeChannels(before)
            throw e
        } catch (_: Exception) {
            writeChannels(before)
            ChannelLayoutSaveOutcome.Failed(failedText)
        }
    }

    suspend fun createCategory(name: String): Channel {
        val category = session.api.createChannel(serverId, name, "category")
        channels?.let { current -> if (current.none { it.id == category.id }) writeChannels(current + category) }
        return category
    }

    suspend fun renameCategory(category: Channel, name: String): Channel {
        val updated = session.api.renameChannel(category.id, name)
        channels?.let { current -> writeChannels(current.map { if (it.id == updated.id) updated else it }) }
        return updated
    }

    /** A channel made from a category's "+": in that category, which unfolds so the new row is seen. */
    suspend fun createChannelIn(category: Channel, type: String, rawName: String) {
        val name = rawName.trim().replace(' ', '-')
        if (name.isEmpty()) return
        try {
            val channel = session.api.createChannel(serverId, name, type, isPrivate = false, parentId = category.id)
            channels?.let { current -> if (current.none { it.id == channel.id }) writeChannels(current + channel) }
            if (category.id in folded) foldedStore.setFolded(serverId, category.id, false)
        } catch (e: CancellationException) {
            throw e
        } catch (e: Exception) {
            layoutNotice = e.message ?: failedText
        }
    }
    // Every `watch_party` channel this server has, folded into ONE block: a
    // live or pending party sits above everything, and the "Criar watch
    // party" row sits at the end of the list, where creating one belongs.
    val watchPartyBlock = remember(list, parties, liveChannels, permissions, liveHlsEnabled) {
        watchPartyListBlock(
            list.orEmpty().filter { it.type == "watch_party" }.map { channel ->
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
    }
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
            // Stories: below the banner, above the watch party and the Baú.
            // Scrolls away with the list and draws nothing while the server's
            // `stories` flag is off or nobody has a story up.
            item(key = "stories") {
                StoriesSection(
                    session = session,
                    serverId = serverId,
                    contextLabel = serverName,
                    onJoinCall = onJoinStoryCall,
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
                    sections = sections,
                    watchPartyBlock = watchPartyBlock,
                    showBau = showBau,
                    bauState = bauState,
                    serverId = serverId,
                    liveChannels = liveChannels,
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
                    manage = if (mixed && canManageChannels) {
                        CategoryManage(
                            organizeLabel = organizeLabel,
                            onOrganize = { organizing = true },
                            onAddChannel = { category, type -> newChannelIn = category to type },
                            onCreateCategory = { creatingCategory = true },
                        )
                    } else {
                        null
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
            actions = { shown ->
                if (mixed && canManageChannels) {
                    ServerMenu(
                        shown = shown,
                        onOrganize = { organizing = true },
                        onCreateCategory = { creatingCategory = true },
                    )
                }
            },
        )
    }

    if (organizing && list != null) {
        ChannelOrganizerDialog(
            layout = mixedLayoutOf(list),
            baseVersion = layoutConfig.version,
            onDismiss = { organizing = false },
            save = ::saveLayout,
            createCategory = { name -> createCategory(name) to freshLayoutVersion() },
            renameCategory = { category, name -> renameCategory(category, name) to freshLayoutVersion() },
        )
    }
    if (creatingCategory) {
        CategoryNameDialog(
            title = stringResource(R.string.channels_create_category),
            confirm = stringResource(R.string.channels_create),
            initial = "",
            onDismiss = { creatingCategory = false },
            onConfirm = { name ->
                creatingCategory = false
                scope.launch {
                    try {
                        createCategory(name)
                    } catch (e: CancellationException) {
                        throw e
                    } catch (e: Exception) {
                        layoutNotice = e.message ?: failedText
                    }
                }
            },
        )
    }
    newChannelIn?.let { (category, type) ->
        ChannelNameDialog(
            onDismiss = { newChannelIn = null },
            onConfirm = { name ->
                newChannelIn = null
                scope.launch { createChannelIn(category, type, name) }
            },
        )
    }
    layoutNotice?.let { text ->
        AlertDialog(
            onDismissRequest = { layoutNotice = null },
            confirmButton = {
                TextButton(onClick = { layoutNotice = null }) { Text(stringResource(R.string.channels_got_it)) }
            },
            text = { Text(text) },
        )
    }
}

/** What a manager gets on the mixed list: a "+" on each heading, a long press to organize, Criar categoria. */
private class CategoryManage(
    val organizeLabel: String,
    val onOrganize: () -> Unit,
    val onAddChannel: (category: Channel, type: String) -> Unit,
    val onCreateCategory: () -> Unit,
)

/** The "+" on a category heading: Canal de texto, Canal de voz. */
@Composable
private fun AddChannelButton(category: Channel, onAdd: (Channel, String) -> Unit) {
    var open by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    Box {
        IconButton(
            onClick = { open = true },
            modifier = Modifier.size(36.dp).testTag("channels.categoryCreate.${category.name}"),
        ) {
            Icon(
                imageVector = PqpIcons.Add,
                contentDescription = stringResource(R.string.channels_create_in, category.name),
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(16.dp),
            )
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.channels_add_text)) },
                leadingIcon = { Icon(PqpIcons.TextChannel, contentDescription = null, modifier = Modifier.size(18.dp)) },
                onClick = {
                    open = false
                    onAdd(category, "text")
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.channels_add_voice)) },
                leadingIcon = { Icon(PqpIcons.VoiceChannel, contentDescription = null, modifier = Modifier.size(18.dp)) },
                onClick = {
                    open = false
                    onAdd(category, "voice")
                },
            )
        }
    }
}

/** ⋯ at the end of the bar, for whoever may manage channels on the mixed list. */
@Composable
private fun ServerMenu(shown: Float, onOrganize: () -> Unit, onCreateCategory: () -> Unit) {
    var open by remember { mutableStateOf(false) }
    val colors = MaterialTheme.colorScheme
    Box {
        IconButton(onClick = { open = true }, modifier = Modifier.testTag("channels.menu")) {
            Box(
                Modifier
                    .size(36.dp)
                    .clip(CircleShape)
                    .background(Color.Black.copy(alpha = 0.35f * (1f - shown))),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = PqpIcons.Menu,
                    contentDescription = stringResource(R.string.channels_more),
                    tint = colors.onSurface,
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
        DropdownMenu(expanded = open, onDismissRequest = { open = false }) {
            DropdownMenuItem(
                text = { Text(stringResource(R.string.channels_organize)) },
                modifier = Modifier.testTag("channels.organize"),
                onClick = {
                    open = false
                    onOrganize()
                },
            )
            DropdownMenuItem(
                text = { Text(stringResource(R.string.channels_create_category)) },
                onClick = {
                    open = false
                    onCreateCategory()
                },
            )
        }
    }
}

/** A text or voice channel's name: the server takes letters, numbers, - and _, so spaces become hyphens. */
@Composable
private fun ChannelNameDialog(onDismiss: () -> Unit, onConfirm: (String) -> Unit) {
    var text by remember { mutableStateOf("") }
    AlertDialog(
        onDismissRequest = onDismiss,
        title = { Text(stringResource(R.string.channels_new_channel)) },
        text = {
            OutlinedTextField(
                value = text,
                onValueChange = { text = it },
                singleLine = true,
                label = { Text(stringResource(R.string.channels_channel_name)) },
                modifier = Modifier.testTag("channels.channelName"),
            )
        },
        confirmButton = {
            TextButton(
                onClick = { onConfirm(text) },
                enabled = text.isNotBlank(),
                modifier = Modifier.testTag("channels.channelName.confirm"),
            ) { Text(stringResource(R.string.channels_create)) }
        },
        dismissButton = {
            TextButton(onClick = onDismiss) { Text(stringResource(R.string.channels_organize_cancel)) }
        },
    )
}

/**
 * Everything below the banner. A function over [LazyListScope] rather than a
 * composable, so each row, each person under a room and each folded section
 * is its own lazy item and animates in and out on its own.
 */
private fun LazyListScope.channelListItems(
    list: List<Channel>,
    sections: List<ChannelSection>,
    watchPartyBlock: WatchPartyListBlock,
    showBau: Boolean,
    bauState: BauPreviewState,
    serverId: String,
    liveChannels: Map<String, gg.pqp.app.watch.ChannelLive>,
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
    /** Set on the mixed list for whoever may manage channels. */
    manage: CategoryManage?,
) {
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

    sections.forEach { section ->
        val categoryId = section.categoryId
        val isFolded = categoryId != null && categoryId in folded
        val category = section.category
        item(key = "header-${section.key}") {
            Box(Modifier.listMotion(this)) {
                when {
                    categoryId == null || section.title.isBlank() -> SectionGap()
                    else -> CategoryHeader(
                        title = section.title,
                        folded = isFolded,
                        summary = foldedSummary(section.channels, unread, muted),
                        onToggle = { onToggleCategory(categoryId) },
                        onLongClick = manage?.onOrganize,
                        onLongClickLabel = manage?.organizeLabel,
                        trailing = if (manage != null && category != null) {
                            { AddChannelButton(category, manage.onAddChannel) }
                        } else {
                            null
                        },
                    )
                }
            }
        }
        // Folding never hides where you are: the call this phone is in stays
        // on screen under its folded category.
        val shown = if (isFolded) section.channels.filter { it.id == callChannelId } else section.channels
        // One lazy interval per section, not one per channel: a busy server
        // recomposes on every unread frame and roster change, and only the
        // rows on screen should pay for it. Each item is the row plus the
        // people in it, worked out when the item is drawn.
        items(shown, key = { it.id }, contentType = { "channel" }) { channel ->
            val inCall = channel.id == callChannelId
            ChannelEntry(
                channel = channel,
                badge = rowBadge(unread[channel.id], channel.id in muted),
                live = liveChannels[channel.id]?.live == true,
                people = when {
                    !channel.isVoice -> emptyList()
                    inCall -> rooms[channel.id] ?: callParticipants
                    else -> rooms[channel.id].orEmpty()
                },
                inCall = inCall,
                speakingPeers = speakingPeers,
                myUserId = myUserId,
                onOpenChannel = onOpenChannel,
                modifier = Modifier.listMotion(this),
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
    // The last row of the mixed list, managers only. It replaces a heading
    // over a create button, which read as an empty category.
    if (manage != null) {
        item(key = "createCategory") {
            CreateCategoryRow(
                onClick = manage.onCreateCategory,
                modifier = Modifier.listMotion(this).padding(top = Spacing.sm),
            )
        }
    }
}

@Composable
private fun CreateCategoryRow(onClick: () -> Unit, modifier: Modifier = Modifier) {
    val colors = MaterialTheme.colorScheme
    Row(
        modifier = modifier
            .fillMaxWidth()
            .height(40.dp)
            .padding(horizontal = Spacing.railInset)
            .clip(MaterialTheme.shapes.small)
            .clickable(onClick = onClick)
            .padding(horizontal = Spacing.md)
            .testTag("channels.createCategory"),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(PqpIcons.Add, contentDescription = null, tint = colors.onSurfaceVariant, modifier = Modifier.size(Sizes.iconInline))
        Spacer(Modifier.width(Spacing.sm + 2.dp))
        Text(
            text = stringResource(R.string.channels_create_category),
            style = MaterialTheme.typography.bodyLarge,
            color = colors.onSurfaceVariant,
        )
    }
}

/**
 * One channel's row, then the people in it when it is a voice room. People
 * joining and leaving grow and shrink the entry on a spring
 * (`animateContentSize`), which the system animator scale turns off.
 */
@Composable
private fun ChannelEntry(
    channel: Channel,
    badge: gg.pqp.app.ui.screens.channels.RowBadge,
    live: Boolean,
    people: List<VoiceParticipant>,
    inCall: Boolean,
    speakingPeers: Set<String>,
    myUserId: String?,
    onOpenChannel: (Channel) -> Unit,
    modifier: Modifier = Modifier,
) {
    val summary = remember(people, myUserId) { occupantSummary(people, myUserId) }
    Column(
        modifier.animateContentSize(
            spring(dampingRatio = 0.85f, stiffness = 380f, visibilityThreshold = IntSize.VisibilityThreshold),
        ),
    ) {
        ChannelRow(
            channel = channel,
            badge = badge,
            inCall = inCall,
            live = live,
            occupants = summary.total,
            // Opening a voice channel shows its transcript; it does not ask
            // for the microphone. The chat header owns the explicit join.
            onClick = { onOpenChannel(channel) },
        )
        summary.listed.forEach { person ->
            key(person.userId) {
                VoiceOccupantRow(
                    participant = person,
                    isSelf = person.userId == myUserId,
                    // Only in this device's own call; see [VoiceController.speakingPeers].
                    speaking = inCall && person.peerId in speakingPeers,
                    onClick = { onOpenChannel(channel) },
                )
            }
        }
        if (summary.overflowCount > 0) {
            VoiceOverflowRow(
                faces = summary.overflowFaces,
                count = summary.overflowCount,
                onClick = { onOpenChannel(channel) },
            )
        }
        if (people.isNotEmpty()) {
            Spacer(Modifier.height(Spacing.xs))
        }
    }
}
