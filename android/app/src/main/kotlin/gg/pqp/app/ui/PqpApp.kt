package gg.pqp.app.ui

import androidx.compose.animation.AnimatedContent
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
import gg.pqp.app.core.RealtimeClient
import gg.pqp.app.core.RealtimeState
import gg.pqp.app.core.SessionPhase
import gg.pqp.app.core.SessionStore
import gg.pqp.app.push.DeepLinkTarget
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
import gg.pqp.app.voice.Refusal
import gg.pqp.app.voice.VoiceController
import gg.pqp.app.watch.WatchLiveStore
import gg.pqp.app.watch.ui.WatchChannelPane
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
)

@Serializable object YouRoute

@Composable
fun PqpApp(
    session: SessionStore,
    voice: VoiceController,
    push: PushController,
    calls: CallController,
    watch: WatchLiveStore,
) {
    val phase by session.phase.collectAsStateWithLifecycle()

    Surface(
        modifier = Modifier.fillMaxSize(),
        color = MaterialTheme.colorScheme.background,
    ) {
        AnimatedContent(
            targetState = phaseKey(phase),
            transitionSpec = { fadeIn() togetherWith fadeOut() },
            label = "session-phase",
        ) { key ->
            when (key) {
                PhaseKey.Launching -> Box(Modifier.fillMaxSize())
                PhaseKey.SignedOut -> SignInScreen(session)
                PhaseKey.AgeGate -> AgeGateScreen(session)
                PhaseKey.Failed -> FailedScreen(
                    reason = (phase as? SessionPhase.Failed)?.reason.orEmpty(),
                    onRetry = session::restore,
                )
                PhaseKey.Blocked -> FailedScreen(
                    reason = (phase as? SessionPhase.Blocked)?.reason.orEmpty(),
                    onRetry = null,
                )
                PhaseKey.Ready -> SignedInNav(session, voice, push, calls, watch)
            }
        }
    }
}

/**
 * `AnimatedContent` keys on equality, and `SessionPhase.Ready` carries the
 * account. Without this projection every profile refresh would be a new target
 * state and cross-fade the whole app.
 */
private enum class PhaseKey { Launching, SignedOut, AgeGate, Ready, Failed, Blocked }

private fun phaseKey(phase: SessionPhase): PhaseKey = when (phase) {
    is SessionPhase.Launching -> PhaseKey.Launching
    is SessionPhase.SignedOut -> PhaseKey.SignedOut
    is SessionPhase.AgeGate -> PhaseKey.AgeGate
    is SessionPhase.Ready -> PhaseKey.Ready
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
    val roomFull = stringResource(R.string.voice_room_full)
    val unsupported = stringResource(R.string.voice_transport_unsupported)
    val screenDenied = stringResource(R.string.voice_screen_share_denied)
    val backendUnreachable = stringResource(R.string.voice_backend_unreachable)
    LaunchedEffect(voiceState.refusal) {
        val text = when (voiceState.refusal) {
            Refusal.RoomFull -> roomFull
            Refusal.TransportUnsupported -> unsupported
            Refusal.ScreenShareDenied -> screenDenied
            Refusal.VoiceBackendUnreachable -> backendUnreachable
            null -> return@LaunchedEffect
        }
        android.widget.Toast.makeText(context, text, android.widget.Toast.LENGTH_LONG).show()
        voice.dismissRefusal()
    }
    LaunchedEffect(voiceState.notice) {
        val notice = voiceState.notice ?: return@LaunchedEffect
        android.widget.Toast.makeText(context, notice, android.widget.Toast.LENGTH_LONG).show()
        voice.dismissNotice()
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
                    ChatScreen(
                        session = session,
                        channelId = route.channelId,
                        channelName = route.channelName,
                        slowmodeSeconds = route.slowmodeSeconds,
                        onBack = nav::popBackStack,
                        serverId = route.serverId,
                        // The watch party, above the transcript, for anybody
                        // who may see the channel. It draws nothing at all
                        // unless the server says a stream is live, so an
                        // ordinary voice channel is untouched.
                        header = {
                            if (route.isVoiceChannel) {
                                WatchChannelPane(
                                    session = session,
                                    store = watch,
                                    channelId = route.channelId,
                                )
                            }
                        },
                        actions = {
                            // Offered only while this room is not already the
                            // call. Once joining or connected, the call bar
                            // above the NavHost owns every voice control, and a
                            // second `join` mid-connect would tear the session
                            // down and rebuild it.
                            val inThisRoom =
                                voiceState.channelId == route.channelId && voiceState.isActive
                            if (route.isVoiceChannel && !inThisRoom) {
                                IconButton(
                                    onClick = {
                                        withMicrophone {
                                            voice.join(route.channelId, route.channelName)
                                        }
                                    },
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
