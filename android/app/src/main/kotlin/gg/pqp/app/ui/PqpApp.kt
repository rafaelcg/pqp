package gg.pqp.app.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.consumeWindowInsets
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.statusBars
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import androidx.navigation.compose.NavHost
import androidx.navigation.compose.composable
import androidx.navigation.compose.rememberNavController
import androidx.navigation.toRoute
import gg.pqp.app.R
import gg.pqp.app.bau.ui.BauScreen
import gg.pqp.app.core.Permission
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.RealtimeClient
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.push.DeepLinkTarget
import gg.pqp.app.core.Landing
import gg.pqp.app.onboarding.shouldRunOnboarding
import gg.pqp.app.onboarding.ui.ArrivalBanner
import gg.pqp.app.onboarding.ui.OnboardingFlow
import gg.pqp.app.push.PushController
import gg.pqp.app.social.SocialRepository
import gg.pqp.app.social.ui.ConversationRoute
import gg.pqp.app.social.ui.HomeScreen
import gg.pqp.app.social.ui.conversationDestination
import gg.pqp.app.social.ui.titleOr
import gg.pqp.app.ui.components.CallBar
import gg.pqp.app.ui.components.ConnectionBanner
import gg.pqp.app.ui.components.ConnectionDoctorDialog
import gg.pqp.app.ui.components.IncomingCallBanner
import gg.pqp.app.ui.components.rememberMicrophoneGate
import gg.pqp.app.ui.screens.AgeGateScreen
import gg.pqp.app.ui.screens.ChannelsScreen
import gg.pqp.app.ui.screens.ChatScreen
import gg.pqp.app.ui.components.FailedScreen
import gg.pqp.app.ui.screens.SignInScreen
import gg.pqp.app.ui.screens.YouScreen
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.voice.CallController
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.voice.voiceRefusalStringRes
import gg.pqp.app.watch.WatchLiveStore
import gg.pqp.app.watch.WatchPartyHostController
import gg.pqp.app.watch.liveHlsConfig
import gg.pqp.app.watch.mayJoinWatchPartyRoom
import gg.pqp.app.watch.mayManageWatchPartyWithoutASeat
import gg.pqp.app.watch.needsHlsHostAck
import gg.pqp.app.watch.confirmHlsHostAck
import gg.pqp.app.watch.watchPartyHostGate
import gg.pqp.app.watch.ui.WatchChannelPane
import gg.pqp.app.watch.ui.WatchPartyHostControls
import kotlinx.coroutines.async
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.serialization.Serializable

@Serializable object ServersRoute

@Serializable data class ChannelsRoute(val serverId: String, val serverName: String)

/** A server's Baú. Reached from its channel list only, so it carries what that list knew. */
@Serializable data class BauRoute(val serverId: String, val serverName: String)

/**
 * `channelName` defaults because a notification tap knows the channel's id and
 * not its name: the push payload carries ids and a rendered sentence, never a
 * channel record. The name is filled in when it is cheap to look up and left
 * blank when it is not, which `ChatScreen` renders as a placeholder rather than
 * as `#`.
 */
@Serializable data class ChatRoute(
    val channelId: String,
    val channelName: String = "",
    /**
     * The channel's slow mode, so the composer can count down on its own
     * rather than learn the rule from the first refusal. Defaults to off for
     * the same notification-tap reason as the name: a push knows no channel
     * record, and a countdown that is missing is only a refusal away.
     */
    val slowmodeSeconds: Int = 0,
    /**
     * Null for a channel whose server is not known (a notification tap
     * carries only ids). The chat then behaves as a plain member there:
     * nothing is offered that only a moderator could do, and `@` offers no
     * names. It cannot be wrong, only quieter.
     */
    val serverId: String? = null,
    /** A server voice room's text transcript. Media remains opt-in in its header. */
    val isVoiceChannel: Boolean = false,
    /**
     * `channel.type == "watch_party"`, as opposed to an ordinary voice room.
     * Both answer [isVoiceChannel] true, so this is what tells the chat
     * header to draw the watch-party stage — with its idle card and its own
     * "Entrar na call" — rather than the bare HLS pane an ordinary voice
     * room gets (which draws nothing at all while no party is running).
     */
    val isWatchParty: Boolean = false,
)

@Serializable object YouRoute

@Composable
fun PqpApp(
    session: SessionStore,
    voice: VoiceController,
    push: PushController,
    calls: CallController,
    watch: WatchLiveStore,
    watchPartyHost: WatchPartyHostController,
) {
    val phase by session.phase.collectAsStateWithLifecycle()

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        AnimatedContent(
            targetState = phaseKey(phase),
            transitionSpec = {
                // First run rises into place once, from the gate or the
                // sign-in; everything else is the plain cross-fade it was.
                if (targetState == PhaseKey.Onboarding) {
                    (fadeIn(tween(320)) + slideInVertically(spring(dampingRatio = 0.85f, stiffness = 300f)) { it / 12 })
                        .togetherWith(fadeOut(tween(160)))
                } else {
                    fadeIn() togetherWith fadeOut()
                }
            },
            label = "session-phase",
        ) { key ->
            when (key) {
                PhaseKey.Launching -> Box(Modifier.fillMaxSize())
                PhaseKey.SignedOut -> SignInScreen(session, push)
                PhaseKey.AgeGate -> AgeGateScreen(
                    session = session,
                    arrivedOnInvite = push.pendingTarget.value is DeepLinkTarget.Invite,
                )
                PhaseKey.Onboarding -> OnboardingFlow(session, push)
                PhaseKey.Failed -> FailedScreen(
                    reason = (phase as? SessionPhase.Failed)?.reason.orEmpty(),
                    onRetry = session::restore,
                )
                PhaseKey.Blocked -> FailedScreen(
                    reason = (phase as? SessionPhase.Blocked)?.reason.orEmpty(),
                    onRetry = null,
                )
                PhaseKey.Ready -> SignedInNav(session, voice, push, calls, watch, watchPartyHost)
            }
        }
    }
}

/**
 * `AnimatedContent` keys on equality, and `SessionPhase.Ready` carries the
 * account. Without this projection every profile refresh would be a new target
 * state and cross-fade the whole app.
 */
private enum class PhaseKey { Launching, SignedOut, AgeGate, Onboarding, Ready, Failed, Blocked }

private fun phaseKey(phase: SessionPhase): PhaseKey = when (phase) {
    is SessionPhase.Launching -> PhaseKey.Launching
    is SessionPhase.SignedOut -> PhaseKey.SignedOut
    is SessionPhase.AgeGate -> PhaseKey.AgeGate
    // First run is a phase of its own rather than a dialog over the app: on a
    // phone the wizard is the whole screen, and the app behind it would only
    // be something to mount, load and throw away.
    is SessionPhase.Ready -> if (shouldRunOnboarding(phase.me)) PhaseKey.Onboarding else PhaseKey.Ready
    is SessionPhase.Failed -> PhaseKey.Failed
    is SessionPhase.Blocked -> PhaseKey.Blocked
}

@Composable
private fun SignedInNav(
    session: SessionStore,
    voice: VoiceController,
    push: PushController,
    calls: CallController,
    watch: WatchLiveStore,
    watchPartyHost: WatchPartyHostController,
) {
    val nav = rememberNavController()
    val voiceState by voice.state.collectAsStateWithLifecycle()
    val callState by calls.state.collectAsStateWithLifecycle()

    // Asked for on the tap that starts a call, never before. The gate lives
    // here rather than in the conversation screen so that answering a ring and
    // placing a call go through one piece of code.
    val micDenied = stringResource(R.string.voice_mic_denied)
    val context = androidx.compose.ui.platform.LocalContext.current
    val withMicrophone = rememberMicrophoneGate(
        onDenied = {
            android.widget.Toast.makeText(context, micDenied, android.widget.Toast.LENGTH_LONG).show()
        },
    )

    // The server's answer to a join or a screen share, and a moderator's
    // notice, shown from here rather than from any one screen. A join starts
    // from a chat screen, a share from the call bar, and the person may have
    // navigated on by the time the answer lands; a collector that lives on the
    // channel list was out of composition for every one of those. A toast,
    // like the microphone refusal above, because there is no scaffold at this
    // level to host a snackbar. The frame's own sentence is shown verbatim for
    // a notice: the server already wrote and translated it.
    //
    // Which SENTENCE a refusal gets is `voiceRefusalStringRes`'s call, not
    // this composable's: a watch party's own room fails the way a stream
    // fails ("could not connect to the stream"), never the way a call does
    // ("the voice server", "this call"), because a broadcast is not one. Fed
    // by whether the room this refusal came from is currently hosting or
    // being watched as a party -- `WatchLiveStore.parties` keyed by the
    // refusal's own `voiceState.channelId`, not by the screen on top, since
    // this toast is shown above the whole nav graph and may outlive the
    // screen that started the join.
    val parties by watch.parties.collectAsStateWithLifecycle()
    val inWatchPartyRefusalContext = voiceState.channelId?.let(parties::containsKey) == true
    val refusalText = voiceState.refusal?.let {
        stringResource(voiceRefusalStringRes(it, inWatchPartyRefusalContext))
    }
    // One sentence per failure class, and the four SFU ones are not
    // interchangeable: a refused token, a room the server says is peer-to-peer,
    // a media box nothing can reach and a handshake that ran out of time have
    // different causes and different next steps. They shared one string until
    // `SfuFailureKind` split them, which made every report of "voice does not
    // work on Android" unactionable.
    LaunchedEffect(voiceState.refusal) {
        val text = refusalText ?: return@LaunchedEffect
        android.widget.Toast.makeText(context, text, android.widget.Toast.LENGTH_LONG).show()
        voice.dismissRefusal()
    }
    LaunchedEffect(voiceState.notice) {
        val notice = voiceState.notice ?: return@LaunchedEffect
        android.widget.Toast.makeText(context, notice, android.widget.Toast.LENGTH_LONG).show()
        voice.dismissNotice()
    }

    // A watch-party hosting action (Criar, Ir ao vivo, Encerrar) that did not
    // land clean. Read here, above the per-channel UI, rather than inside
    // `WatchPartyHostControls`: an Encerrar failure is reported AFTER
    // `voice.leave()` has already dropped `canStartWatchParty`, which is
    // what unmounts that composable, so an inline message there would never
    // be seen. Same toast pattern as the two effects above.
    val hostState by watchPartyHost.state.collectAsStateWithLifecycle()
    LaunchedEffect(hostState.error) {
        val message = hostState.error ?: return@LaunchedEffect
        android.widget.Toast.makeText(context, message, android.widget.Toast.LENGTH_LONG).show()
        watchPartyHost.dismissError()
    }

    // A tapped notification, routed only once the app is signed in and has a
    // NavController. Anything tapped earlier waited on the controller.
    //
    // KEYED ON `Unit`, NOT ON THE TARGET, and that is not a style choice. Keyed
    // on the target, `consumeTarget()` changes the key mid-effect and cancels
    // the coroutine that is still resolving the channel's name, and because
    // `runCatching` catches `CancellationException` like any other throwable,
    // the cancellation is swallowed and the navigation completes with an empty
    // name instead of failing. That produced a chat screen titled
    // "Conversation" for a channel called #general, which is the kind of bug
    // that looks like a missing lookup and is actually a cancelled one.
    LaunchedEffect(Unit) {
        push.pendingTarget.filterNotNull().collect { target ->
            push.consumeTarget()
            navigateToPush(nav, session, target)
        }
    }

    // A `pqp://` link that went nowhere, in the server's own words. A dialog
    // rather than a banner: somebody who followed a link is waiting for an
    // answer, and "nothing happened" is the one answer that reads as a broken
    // app.
    val linkError by session.linkError.collectAsStateWithLifecycle()
    linkError?.let { message ->
        AlertDialog(
            onDismissRequest = session::clearLinkError,
            title = { Text(stringResource(R.string.invite_failed_title)) },
            text = { Text(message.ifBlank { stringResource(R.string.error_generic) }) },
            confirmButton = {
                TextButton(onClick = session::clearLinkError) {
                    Text(stringResource(R.string.ok))
                }
            },
        )
    }

    // Where first run handed over: open that room, and greet the person in it.
    // Consumed once, so a later recomposition cannot navigate a second time.
    var arrival by remember { mutableStateOf<Landing?>(null) }
    LaunchedEffect(Unit) {
        session.landing.filterNotNull().collect { landing ->
            session.consumeLanding()
            nav.navigate(ChannelsRoute(landing.serverId, landing.serverName))
            arrival = landing
        }
    }

    // The live connection, app-wide. It used to be a strip inside the chat
    // screen only, so somebody stuck on the home screen saw nothing, and
    // somebody in a chat saw "Something went wrong" with no way out.
    val connection by session.realtime.state.collectAsStateWithLifecycle()
    val refusals by session.realtime.unauthorizedStreak.collectAsStateWithLifecycle()
    val connectionBannerShowing = connection == RealtimeState.Connecting ||
        connection == RealtimeState.Reconnecting ||
        connection == RealtimeState.Refused
    var checkingConnection by remember { mutableStateOf(false) }
    if (checkingConnection) {
        ConnectionDoctorDialog(
            session = session,
            onDismiss = { checkingConnection = false },
            onSignInAgain = {
                checkingConnection = false
                session.signOut()
            },
        )
    }

    Column(Modifier.fillMaxSize()) {
        // The call bar belongs to the process, not to the screen that started
        // the call, so it lives above the NavHost rather than inside any one
        // destination. It carries the status-bar inset itself while it is
        // showing, and the content below then stops adding that inset a second
        // time. The connection banner sits under it and carries the inset only
        // when the call bar is not there to.
        CallBar(voiceState, voice, Modifier.statusBarsPadding(), call = callState.outgoing)

        // Above the NavHost and below the call bar: a ring is not part of any
        // screen, and it must not be hidden by the one that happens to be open.
        IncomingCallBanner(callState, calls)
        ConnectionBanner(
            state = connection,
            refusedRepeatedly = RealtimeClient.refusedForGood(refusals),
            onRetry = session.realtime::retryNow,
            onCheck = { checkingConnection = true },
            onSignInAgain = session::signOut,
            modifier = if (voiceState.isActive) Modifier else Modifier.statusBarsPadding(),
        )

        Box(
            modifier = Modifier
                .weight(1f)
                .then(
                    if (voiceState.isActive || connectionBannerShowing) {
                        Modifier.consumeWindowInsets(WindowInsets.statusBars)
                    } else {
                        Modifier
                    },
                ),
        ) {
            // Default transitions are left alone deliberately: Navigation
            // Compose's are the platform's, they cooperate with the predictive
            // back gesture the manifest opts into, and a bespoke slide would
            // break that cooperation.
            NavHost(navController = nav, startDestination = ServersRoute) {
                composable<ServersRoute> {
                    // The start destination is the three-tab home (servers,
                    // messages, friends) rather than the server list alone.
                    // The route keeps its name so nothing else that addresses
                    // it has to change.
                    HomeScreen(
                        session = session,
                        onOpenServer = { server ->
                            nav.navigate(ChannelsRoute(server.id, server.name))
                        },
                        onOpenConversation = { route -> nav.navigate(route) },
                        onOpenProfile = { nav.navigate(YouRoute) },
                    )
                }
                conversationDestination(
                    session = session,
                    onBack = nav::popBackStack,
                    onCall = { channelId, title ->
                        withMicrophone { calls.place(channelId, title) }
                    },
                )
                composable<ChannelsRoute> { entry ->
                    val route = entry.toRoute<ChannelsRoute>()
                    ChannelsScreen(
                        session = session,
                        voice = voice,
                        watch = watch,
                        serverId = route.serverId,
                        serverName = route.serverName,
                        onBack = nav::popBackStack,
                        onOpenChannel = { channel ->
                            nav.navigate(
                                ChatRoute(
                                    channel.id,
                                    channel.name,
                                    channel.slowmodeSeconds,
                                    serverId = route.serverId,
                                    isVoiceChannel = channel.isVoice,
                                    isWatchParty = channel.type == "watch_party",
                                ),
                            )
                        },
                        onOpenBau = {
                            nav.navigate(BauRoute(route.serverId, route.serverName))
                        },
                    )
                }
                composable<BauRoute> { entry ->
                    val route = entry.toRoute<BauRoute>()
                    BauScreen(
                        session = session,
                        serverId = route.serverId,
                        serverName = route.serverName,
                        onBack = nav::popBackStack,
                    )
                }
                composable<ChatRoute> { entry ->
                    val route = entry.toRoute<ChatRoute>()

                    // Offered only while this room is not already the call.
                    // Once joining or connected, the call bar above the
                    // NavHost owns every voice control, and a second `join`
                    // mid-connect would tear the session down and rebuild it.
                    val inThisRoom = voiceState.channelId == route.channelId && voiceState.isActive
                    // AND ONLY TO SOMEBODY WHO MAY HAVE A SEAT.
                    //
                    // `Channel.isVoice` answers true for `watch_party` as well
                    // as `voice`, so a blanket join button would be offered to
                    // a watch party's audience: five hundred people invited
                    // onto the media box for something the pane right below
                    // them plays for free. Watching is already the whole offer
                    // on this screen, and it is one tap and no seat, so a
                    // viewer who is not shown this loses nothing and is not
                    // sent anywhere else.
                    //
                    // The rule is the one the server refuses the join with,
                    // and it answers TRUE for a channel with no active party,
                    // so an ordinary voice room is untouched. See
                    // `WatchPartySeat.kt`.
                    val seats by watch.seats.collectAsStateWithLifecycle()
                    val parties by watch.parties.collectAsStateWithLifecycle()
                    val activeParty = parties[route.channelId]
                    // `welcome.canStream` in this channel, already resolved by
                    // the server to START_WATCH_PARTY for a `watch_party`
                    // channel type (`SpeakRule.kt`), and only known once this
                    // phone has actually joined the channel's own room -- see
                    // `WatchPartyHostGate.kt`'s doc for why that is the honest
                    // answer rather than a gap.
                    val canStartWatchParty = inThisRoom && voiceState.screenShareSupported
                    val maySit = mayJoinWatchPartyRoom(
                        canStartWatchParty = canStartWatchParty,
                        party = seats[route.channelId],
                    )
                    val onJoinVoice: () -> Unit = {
                        withMicrophone { voice.join(route.channelId, route.channelName) }
                    }

                    // Watch party hosting. `serverId` is null only for a
                    // notification tap that has not resolved a channel record
                    // yet, in which case there is nothing to host onto and
                    // this reads as "off", same direction every other gate
                    // here defaults to.
                    var liveHlsEnabled by remember(route.serverId) { mutableStateOf(false) }
                    var lowLatencyAvailable by remember(route.serverId) { mutableStateOf(false) }
                    var permissions by remember(route.serverId) { mutableStateOf(PermissionsSnapshot()) }
                    LaunchedEffect(route.serverId, route.isWatchParty) {
                        val serverId = route.serverId
                        if (!route.isWatchParty || serverId == null) return@LaunchedEffect
                        // Two independent GETs, run concurrently rather than
                        // one after the other: neither reads the other's
                        // answer, and awaiting them in sequence would make
                        // landing on a watch_party channel wait for both
                        // round trips added together for no reason.
                        coroutineScope {
                            val configDeferred = async {
                                runCatching { session.api.liveHlsConfig(serverId) }.getOrNull()
                            }
                            val permissionsDeferred = async {
                                runCatching { session.api.serverPermissions(serverId) }.getOrNull()
                            }
                            val config = configDeferred.await()
                            liveHlsEnabled = config?.enabled == true
                            lowLatencyAvailable = config?.lowLatency?.available == true
                            permissions = permissionsDeferred.await() ?: PermissionsSnapshot()
                        }
                    }
                    // A watch party is a broadcast, not a call: setting one
                    // up -- seeing "Criar watch party" with nothing running,
                    // or "Ir ao vivo" on a party this account already hosts
                    // -- must never require a voice-room join first
                    // (`docs/WATCH_PARTY.md` "A watch party has no voice by
                    // default"). `mayManageWatchPartyWithoutASeat` is that
                    // seatless path, fed by `Permission.START_WATCH_PARTY`
                    // (`gg.pqp.app.core.Permissions.kt`) and by [activeParty]
                    // 's own server-resolved `viewerRole`; it never widens
                    // `maySit` above, which still reads the bare
                    // `canStartWatchParty` unchanged -- holding the bit, or
                    // being this party's host, is not by itself a seat in
                    // the room.
                    val mayStartWatchParty = route.isWatchParty &&
                        hasPermission(permissions.channelBits(route.channelId), Permission.START_WATCH_PARTY)
                    val hostGate = watchPartyHostGate(
                        isWatchPartyChannel = route.isWatchParty,
                        serverWatchPartyEnabled = liveHlsEnabled,
                        canStartWatchParty = canStartWatchParty ||
                            mayManageWatchPartyWithoutASeat(mayStartWatchParty, activeParty),
                        party = activeParty,
                    )
                    // `hostState` itself is collected once, above, at
                    // `SignedInNav` level -- see the toast effect there.

                    ChatScreen(
                        session = session,
                        channelId = route.channelId,
                        channelName = route.channelName,
                        slowmodeSeconds = route.slowmodeSeconds,
                        onBack = nav::popBackStack,
                        serverId = route.serverId,
                        // The watch party, above the transcript, for anybody
                        // who may see the channel. A `watch_party` channel
                        // gets the full stage — a card even while nothing is
                        // live, and "Entrar na call" on the stage itself
                        // rather than only in the app bar. An ordinary voice
                        // channel gets the bare pane, which draws nothing at
                        // all unless the server says a stream is live (it
                        // never will, off `watch_party`) and is therefore
                        // untouched.
                        header = {
                            if (route.isVoiceChannel) {
                                WatchChannelPane(
                                    session = session,
                                    store = watch,
                                    channelId = route.channelId,
                                    isWatchPartyChannel = route.isWatchParty,
                                    canJoinCall = route.isWatchParty && !inThisRoom && maySit,
                                    onJoinCall = onJoinVoice,
                                    hostControls = if (route.isWatchParty &&
                                        (hostGate.canCreate || hostGate.canManage)
                                    ) {
                                        {
                                            WatchPartyHostControls(
                                                gate = hostGate,
                                                party = activeParty,
                                                hostState = hostState,
                                                lowLatencyAvailable = lowLatencyAvailable,
                                                selfMuted = voiceState.muted,
                                                sharingScreen = voiceState.sharingScreen,
                                                checkNeedsAck = {
                                                    val serverId = route.serverId
                                                    if (serverId == null) {
                                                        false
                                                    } else {
                                                        // FAIL CLOSED: a lookup that could not be
                                                        // answered must not be read as "already
                                                        // acknowledged". Showing the disclosure one
                                                        // extra time costs a tap; skipping it costs
                                                        // the one thing it exists to guarantee (a
                                                        // Farol finding on the first cut, which
                                                        // defaulted to `false` here).
                                                        runCatching { session.api.needsHlsHostAck(serverId) }
                                                            .getOrDefault(true)
                                                    }
                                                },
                                                confirmAck = {
                                                    // No `runCatching` here: a failure must reach
                                                    // the caller (`HostAckDialog`'s `onConfirm` in
                                                    // `WatchPartyHostPanel.kt`), which keeps the
                                                    // sheet open rather than silently starting the
                                                    // capture without a saved ack (another Farol
                                                    // finding on the first cut).
                                                    val serverId = route.serverId
                                                        ?: error("no server to acknowledge for")
                                                    session.api.confirmHlsHostAck(serverId)
                                                },
                                                onCreate = { name ->
                                                    watchPartyHost.create(route.channelId, name)
                                                },
                                                onGoLive = { lowLatency, consent ->
                                                    val id = activeParty?.id
                                                    if (id != null) {
                                                        withMicrophone {
                                                            watchPartyHost.goLive(
                                                                channelId = route.channelId,
                                                                channelName = route.channelName,
                                                                partyId = id,
                                                                lowLatency = lowLatency,
                                                                consent = consent,
                                                            )
                                                        }
                                                    }
                                                },
                                                onRetryShare = { consent ->
                                                    withMicrophone { watchPartyHost.retryShare(consent) }
                                                },
                                                onEnd = {
                                                    activeParty?.id?.let(watchPartyHost::end)
                                                },
                                                onUnmute = { voice.setMuted(false) },
                                            )
                                        }
                                    } else {
                                        null
                                    },
                                )
                            }
                        },
                        actions = {
                            // A watch party's join lives on the stage now (see
                            // above); the app bar icon stays only for an
                            // ordinary voice room, which has no stage to put
                            // it on.
                            if (route.isVoiceChannel && !route.isWatchParty && !inThisRoom && maySit) {
                                IconButton(
                                    onClick = onJoinVoice,
                                    modifier = Modifier.testTag("chat.joinVoice"),
                                ) {
                                    Icon(
                                        PqpIcons.Call,
                                        contentDescription = stringResource(R.string.voice_join),
                                        modifier = Modifier.size(Sizes.iconAction),
                                    )
                                }
                            }
                        },
                    )
                }
                composable<YouRoute> {
                    YouScreen(session = session, onBack = nav::popBackStack)
                }
            }

            arrival?.let { landing ->
                ArrivalBanner(
                    session = session,
                    landing = landing,
                    onOpenChannel = { channel ->
                        arrival = null
                        nav.navigate(
                            ChatRoute(
                                channel.id,
                                channel.name,
                                channel.slowmodeSeconds,
                                serverId = landing.serverId,
                                isVoiceChannel = channel.isVoice,
                                isWatchParty = channel.type == "watch_party",
                            ),
                        )
                    },
                    onDismiss = { arrival = null },
                )
            }
        }
    }
}

/**
 * Land a notification tap on the thing it is about.
 *
 * THE ROUTE COMES OUT OF THE PUSH, NOT OUT OF APP STATE. `DeepLink.target`
 * parsed `/app/server/<sid>/channel/<cid>` into both ids without consulting
 * anything the app happens to have loaded, which is what makes a tap on a
 * notification from a server this session has never opened land correctly.
 * Names are the only thing looked up, they are cosmetic, and a miss leaves a
 * placeholder rather than a dead end.
 *
 * A server target opens the channel list; a channel target pushes the chat on
 * top of it, so back goes where a person expects rather than to the server
 * list. An invite has nowhere to go on this client yet.
 */
private suspend fun navigateToPush(
    nav: androidx.navigation.NavHostController,
    session: SessionStore,
    target: DeepLinkTarget,
) {
    fun serverName(id: String): String =
        session.servers.value.firstOrNull { it.id == id }?.name.orEmpty()

    when (target) {
        is DeepLinkTarget.Channel -> {
            nav.navigate(ChannelsRoute(target.serverId, serverName(target.serverId)))
            // The row, not just its name. `isVoiceChannel` is what mounts the
            // watch party pane, and a tap on a notification about a live party
            // is exactly the way somebody arrives at one: landing there with no
            // player would be the one route where the feature is missing.
            val channel = runCatching { session.api.channels(target.serverId) }
                .getOrNull()
                ?.firstOrNull { it.id == target.channelId }
            nav.navigate(
                ChatRoute(
                    target.channelId,
                    channel?.name.orEmpty(),
                    serverId = target.serverId,
                    isVoiceChannel = channel?.isVoice == true,
                    isWatchParty = channel?.type == "watch_party",
                ),
            )
        }

        is DeepLinkTarget.Server ->
            nav.navigate(ChannelsRoute(target.serverId, serverName(target.serverId)))

        // A conversation id IS a channel id, but it is not a *channel* route:
        // a conversation's app bar is a person's name and opening one moves a
        // read cursor. Both belong to `conversationDestination`, so this goes
        // there rather than to the `#channel` screen it used to open, which
        // titled a DM "Conversation" and left its unread badge standing.
        is DeepLinkTarget.Conversation -> {
            val known = SocialRepository.of(session).conversations.value
                .firstOrNull { it.channelId == target.channelId }
            nav.navigate(
                ConversationRoute(
                    channelId = target.channelId,
                    // Empty rather than invented when the list has not loaded
                    // or the conversation is one this client has not seen: the
                    // screen renders a placeholder, and a wrong name is worse
                    // than none.
                    title = known?.titleOr("").orEmpty(),
                ),
            )
        }

        // `pqp://invite/<code>`, which is what the manifest has advertised
        // since the first commit. Redeemed here rather than shown on a
        // confirmation screen there is no design for, because the server's
        // redeem is idempotent: already being a member returns the same server
        // and burns no use, so following a link twice just takes you there.
        // A refusal is the server's own sentence, surfaced by `linkError`.
        is DeepLinkTarget.Invite -> {
            val joined = session.redeemInvite(target.code) ?: return
            nav.navigate(ChannelsRoute(joined.serverId, joined.serverName))
        }
    }
}
