package gg.pqp.app.activities.ui

import android.provider.Settings
import androidx.activity.compose.BackHandler
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.animateFloatAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.background
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
import androidx.compose.foundation.layout.statusBarsPadding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.lazy.LazyColumn
import androidx.compose.foundation.lazy.items
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.DropdownMenu
import androidx.compose.material3.DropdownMenuItem
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.runtime.DisposableEffect
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.rememberUpdatedState
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.graphics.toArgb
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.viewinterop.AndroidView
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.activities.ActivitiesStore
import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityConsents
import gg.pqp.app.activities.ActivityEndReason
import gg.pqp.app.activities.ActivityRules
import gg.pqp.app.activities.ActivitySeat
import gg.pqp.app.activities.StoreActivityPeople
import gg.pqp.app.activities.bridge.ActivityTheme
import gg.pqp.app.activities.bridge.BridgeHost
import gg.pqp.app.activities.bridge.SeatSnapshot
import gg.pqp.app.activities.endActivity
import gg.pqp.app.activities.web.ActivityFrameStatus
import gg.pqp.app.activities.web.ActivityHostSession
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.components.ChromeDivider
import gg.pqp.app.ui.components.pqpTopBarColors
import gg.pqp.app.ui.theme.LocalIsDark
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/**
 * A running activity, full screen: the bundle in its sandboxed frame
 * ([ActivityHostSession]) under a quiet bar that says what it is and who is in,
 * with the seat taken over the app's socket ([ActivitySeat]).
 *
 * Leaving the screen leaves the seat (the web does the same: "leaving the
 * channel unmounts the frame and releases the seat"). Coming back from the
 * channel's strip takes it again, as the same person, in a moment.
 *
 * The order, and why: the consent sheet first when this person never accepted
 * the app (nothing is sent until they say yes), then the frame loads while the
 * seat is taken, and the page is revealed on a short fade once the app has
 * said hello. A frame that never does, a refused seat, an ended session and a
 * dropped connection each have a face of their own and never a blank page.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityScreen(
    session: SessionStore,
    serverId: String,
    channelId: String,
    sessionId: String,
    appId: String,
    startAsSpectator: Boolean,
    onBack: () -> Unit,
) {
    val scope = rememberCoroutineScope()
    val store = remember(session) { ActivitiesStore.of(session) }
    val consents = remember(session) { ActivityConsents.of(session.api) }
    LaunchedEffect(serverId) { store.watch(serverId) }
    val configs by store.configs.collectAsStateWithLifecycle()
    val config = configs[serverId]
    val app = config?.apps?.firstOrNull { it.id == appId }
    val live by store.sessions.collectAsStateWithLifecycle()

    // Consent: on file and not stale, the sheet is skipped.
    var gate by remember(appId) { mutableStateOf<Gate>(Gate.Checking) }
    var consentWorking by remember(appId) { mutableStateOf(false) }
    var consentFailed by remember(appId) { mutableStateOf(false) }
    LaunchedEffect(appId) { gate = if (consents.accepted(appId)) Gate.Passed else Gate.Asking }

    var attempt by remember { mutableIntStateOf(0) }
    val phoneWatchesOnly = app != null && !ActivityRules.phoneMayPlay(app)
    val viewerId = ActivitiesStore.viewerId(session)
    val spectate = remember(app, startAsSpectator, live[channelId]) {
        app != null && ActivityRules.joinAsSpectator(
            app,
            live[channelId]?.takeIf { it.id == sessionId } ?: gg.pqp.app.activities.ActivitySession(sessionId, appId),
            viewerId,
            startAsSpectator,
        )
    }

    var permissions by remember(serverId) { mutableStateOf<PermissionsSnapshot?>(null) }
    LaunchedEffect(serverId) { permissions = runCatching { session.api.serverPermissions(serverId) }.getOrNull() }
    val mayManage = permissions?.let { ActivityRules.mayManageChannels(it.channelBits(channelId)) } == true

    Surface(color = MaterialTheme.colorScheme.background, modifier = Modifier.fillMaxSize()) {
        when {
            config == null || gate == Gate.Checking -> LoadingFace(app)
            app == null || config.origin == null -> UnavailableFace(onBack)
            gate == Gate.Asking -> {
                LoadingFace(app)
                ActivityConsentSheet(
                    app = app,
                    mode = if (spectate) ConsentMode.Watch else ConsentMode.Join,
                    startedByName = ActivityRules.nameOf(
                        store.memberOf(serverId, live[channelId]?.takeIf { it.id == sessionId }?.startedBy),
                    ),
                    working = consentWorking,
                    failed = consentFailed,
                    phoneWatchesOnly = phoneWatchesOnly,
                    onConfirm = { identity ->
                        consentWorking = true
                        consentFailed = false
                        scope.launch {
                            try {
                                consents.accept(appId, identity)
                                gate = Gate.Passed
                            } catch (e: kotlinx.coroutines.CancellationException) {
                                throw e
                            } catch (e: Exception) {
                                consentFailed = true
                            }
                            consentWorking = false
                        }
                    },
                    onDismiss = onBack,
                )
            }

            else -> RunningActivity(
                key = attempt,
                session = session,
                store = store,
                serverId = serverId,
                sessionId = sessionId,
                app = app,
                origin = config.origin,
                asSpectator = spectate,
                phoneWatchesOnly = phoneWatchesOnly,
                mayManage = mayManage,
                onRetry = { attempt += 1 },
                onBack = onBack,
            )
        }
    }
}

private enum class Gate { Checking, Asking, Passed }

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun RunningActivity(
    key: Int,
    session: SessionStore,
    store: ActivitiesStore,
    serverId: String,
    sessionId: String,
    app: ActivityApp,
    origin: String,
    asSpectator: Boolean,
    phoneWatchesOnly: Boolean,
    mayManage: Boolean,
    onRetry: () -> Unit,
    onBack: () -> Unit,
) {
    val context = LocalContext.current
    val scope = rememberCoroutineScope()
    val locale = activityLocale()
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val name = app.displayName(locale)
    val dark = LocalIsDark.current

    val palette = ActivityTheme.Palette(
        dark = dark,
        background = colors.background.toArgb(),
        surface = colors.surfaceContainer.toArgb(),
        surfaceRaised = colors.surfaceContainerHigh.toArgb(),
        chrome = colors.surfaceContainerLowest.toArgb(),
        border = colors.outline.toArgb(),
        onSurface = colors.onSurface.toArgb(),
        onSurfaceVariant = colors.onSurfaceVariant.toArgb(),
        primary = colors.primary.toArgb(),
        primaryHover = colors.primaryContainer.toArgb(),
        onPrimary = colors.onPrimary.toArgb(),
        danger = colors.error.toArgb(),
        onDanger = colors.onError.toArgb(),
        warning = gg.pqp.app.ui.theme.Palette.Warning.toArgb(),
        success = gg.pqp.app.ui.theme.Palette.Success.toArgb(),
    )
    val paletteState = rememberUpdatedState(palette)
    val localeState = rememberUpdatedState(locale)

    var status by remember(key) { mutableStateOf<ActivityFrameStatus>(ActivityFrameStatus.Loading) }
    var fullscreen by remember(key) { mutableStateOf(false) }
    var endedByMe by remember(key) { mutableStateOf(false) }
    var peopleOpen by remember { mutableStateOf(false) }
    var menuOpen by remember { mutableStateOf(false) }
    var confirmEnd by remember { mutableStateOf(false) }
    var endFailed by remember { mutableStateOf(false) }

    val seat = remember(key, sessionId) {
        ActivitySeat(
            sessionId = sessionId,
            scope = scope,
            frames = session.realtime.frames,
            connection = session.realtime.state,
            send = { session.realtime.send(it) },
            endCall = { session.api.endActivity(sessionId) },
        )
    }
    val host = remember(key, sessionId) {
        val env = object : BridgeHost.Env {
            override fun locale(): String = localeState.value
            override fun theme(): Map<String, String> = ActivityTheme.tokens(paletteState.value)
            override fun reducedMotion(): Boolean =
                Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) == 0f
        }
        ActivityHostSession(
            context = context,
            app = app,
            appsOrigin = origin,
            scope = scope,
            title = name,
            backgroundColorInt = palette.background,
            onStatus = { status = it },
            makeBridge = { post, onViolation, onEnded ->
                BridgeHost(
                    app = app,
                    transport = seat,
                    people = StoreActivityPeople(store, serverId, session.http),
                    env = env,
                    post = post,
                    scope = scope,
                    hooks = BridgeHost.Hooks(
                        fullscreen = { on ->
                            fullscreen = on
                            on
                        },
                        onViolation = onViolation,
                        onEnded = onEnded,
                    ),
                )
            },
        )
    }
    LaunchedEffect(host) { host.start(asSpectator) }
    DisposableEffect(host) { onDispose { host.destroy() } }
    LaunchedEffect(palette) { host.refreshTheme() }
    LifecycleResumeEffect(host) {
        host.onResume()
        onPauseOrDispose { host.onPause() }
    }
    BackHandler(enabled = fullscreen) { fullscreen = false }

    val snapshot by seat.snapshot.collectAsStateWithLifecycle()
    val linkUp by seat.linkUp.collectAsStateWithLifecycle()
    val members by store.members.collectAsStateWithLifecycle()
    val canEnd = snapshot?.isHost == true || mayManage
    val ready = status == ActivityFrameStatus.Ready
    val webAlpha by animateFloatAsState(if (ready) 1f else 0f, spring(stiffness = 300f), label = "activity-web-alpha")

    Column(Modifier.fillMaxSize()) {
        AnimatedVisibility(
            visible = !fullscreen,
            enter = slideInVertically(spring(stiffness = 500f)) { -it } + fadeIn(),
            exit = slideOutVertically(spring(stiffness = 500f)) { -it } + fadeOut(),
        ) {
            Column {
                TopAppBar(
                    colors = pqpTopBarColors(),
                    navigationIcon = {
                        IconButton(onClick = onBack, modifier = Modifier.testTag("activities.back")) {
                            Icon(PqpIcons.Back, contentDescription = stringResource(R.string.activities_leave))
                        }
                    },
                    title = {
                        Column {
                            Text(
                                text = name,
                                style = MaterialTheme.typography.titleMedium,
                                fontWeight = FontWeight.SemiBold,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                            Text(
                                text = peopleLine(snapshot),
                                style = MaterialTheme.typography.labelMedium,
                                color = colors.onSurfaceVariant,
                                maxLines = 1,
                                overflow = TextOverflow.Ellipsis,
                            )
                        }
                    },
                    actions = {
                        IconButton(onClick = { peopleOpen = true }, modifier = Modifier.testTag("activities.people")) {
                            Icon(PqpIcons.People, contentDescription = stringResource(R.string.activities_people))
                        }
                        Box {
                            IconButton(onClick = { menuOpen = true }, modifier = Modifier.testTag("activities.menu")) {
                                Icon(PqpIcons.More, contentDescription = null)
                            }
                            DropdownMenu(expanded = menuOpen, onDismissRequest = { menuOpen = false }) {
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.activities_fullscreen)) },
                                    leadingIcon = { Icon(PqpIcons.EnterFullscreen, null) },
                                    onClick = {
                                        menuOpen = false
                                        fullscreen = true
                                    },
                                )
                                DropdownMenuItem(
                                    text = { Text(stringResource(R.string.activities_leave)) },
                                    leadingIcon = { Icon(PqpIcons.SignOut, null) },
                                    onClick = {
                                        menuOpen = false
                                        onBack()
                                    },
                                    modifier = Modifier.testTag("activities.leave"),
                                )
                                if (canEnd) {
                                    DropdownMenuItem(
                                        text = { Text(stringResource(R.string.activities_end), color = colors.error) },
                                        leadingIcon = { Icon(PqpIcons.Close, null, tint = colors.error) },
                                        onClick = {
                                            menuOpen = false
                                            endFailed = false
                                            confirmEnd = true
                                        },
                                        modifier = Modifier.testTag("activities.end"),
                                    )
                                }
                            }
                        }
                    },
                )
                ChromeDivider()
            }
        }
        AnimatedVisibility(visible = !linkUp && status is ActivityFrameStatus.Ready) {
            Text(
                text = stringResource(R.string.activities_reconnecting),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurface,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .background(colors.surfaceContainerHigh)
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                    .testTag("activities.reconnecting"),
            )
        }
        AnimatedVisibility(visible = phoneWatchesOnly && ready && !fullscreen) {
            Text(
                text = stringResource(R.string.activities_phone_watch_note),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant,
                textAlign = TextAlign.Center,
                modifier = Modifier
                    .fillMaxWidth()
                    .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                    .testTag("activities.watchNote"),
            )
        }
        Box(Modifier.weight(1f).fillMaxWidth()) {
            AndroidView(
                factory = { host.webView },
                modifier = Modifier
                    .fillMaxSize()
                    .alpha(webAlpha)
                    .navigationBarsPadding()
                    .testTag("activities.web"),
            )
            when (val s = status) {
                ActivityFrameStatus.Loading -> LoadingFace(app)
                ActivityFrameStatus.Ready -> Unit
                is ActivityFrameStatus.Ended -> EndedFace(name, s.reason, endedByMe, onBack)
                is ActivityFrameStatus.Failed -> FailedFace(s, name, onRetry, onBack)
            }
            // Full screen hides the bar; one quiet control brings it back.
            FadeWhen(
                visible = fullscreen && ready,
                modifier = Modifier.align(Alignment.TopEnd).statusBarsPadding().padding(Spacing.sm),
            ) {
                Surface(
                    shape = CircleShape,
                    color = colors.surfaceContainerHigh.copy(alpha = 0.85f),
                    modifier = Modifier.size(40.dp),
                ) {
                    IconButton(onClick = { fullscreen = false }, modifier = Modifier.testTag("activities.exitFullscreen")) {
                        Icon(PqpIcons.ExitFullscreen, contentDescription = stringResource(R.string.activities_exit_fullscreen))
                    }
                }
            }
        }
    }

    if (peopleOpen) {
        PeopleSheet(
            appName = name,
            snapshot = snapshot,
            members = members[serverId].orEmpty(),
            onDismiss = { peopleOpen = false },
        )
    }
    if (confirmEnd) {
        AlertDialog(
            onDismissRequest = { confirmEnd = false },
            title = { Text(stringResource(R.string.activities_end_confirm_title, name)) },
            text = {
                Column {
                    Text(stringResource(R.string.activities_end_confirm_body))
                    if (endFailed) {
                        Text(
                            stringResource(R.string.activities_end_failed),
                            color = colors.error,
                            style = MaterialTheme.typography.bodySmall,
                            modifier = Modifier.padding(top = Spacing.sm),
                        )
                    }
                }
            },
            confirmButton = {
                TextButton(
                    onClick = {
                        scope.launch {
                            val ok = runCatching { session.api.endActivity(sessionId) }.isSuccess
                            if (ok) {
                                haptics.performHapticFeedback(HapticFeedbackType.Confirm)
                                endedByMe = true
                                confirmEnd = false
                            } else {
                                haptics.performHapticFeedback(HapticFeedbackType.Reject)
                                endFailed = true
                            }
                        }
                    },
                    modifier = Modifier.testTag("activities.end.confirm"),
                ) { Text(stringResource(R.string.activities_end_for_all), color = colors.error) }
            },
            dismissButton = { TextButton(onClick = { confirmEnd = false }) { Text(stringResource(R.string.activities_end_keep)) } },
        )
    }
}

@Composable
private fun peopleLine(snapshot: SeatSnapshot?): String {
    if (snapshot == null) return stringResource(R.string.activities_loading)
    val players = snapshot.participants.count { it.role == "player" }
    val watching = snapshot.participants.count { it.role == "spectator" }
    return when {
        players == 0 && watching == 0 -> stringResource(R.string.activities_strip_nobody)
        // a room only watched (an emulator nobody is playing yet) is not "0 inside"
        players == 0 -> pluralStringResource(R.plurals.activities_strip_watching, watching, watching)
        watching > 0 -> pluralStringResource(R.plurals.activities_strip_inside, players, players) + ", " +
            pluralStringResource(R.plurals.activities_strip_watching, watching, watching)
        else -> pluralStringResource(R.plurals.activities_strip_inside, players, players)
    }
}

@Composable
private fun LoadingFace(app: ActivityApp?) {
    Box(Modifier.fillMaxSize(), contentAlignment = Alignment.Center) {
        Column(horizontalAlignment = Alignment.CenterHorizontally) {
            ActivityBadge(app, size = 64.dp)
            Spacer(Modifier.height(Spacing.lg))
            CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            Spacer(Modifier.height(Spacing.md))
            Text(
                text = stringResource(R.string.activities_loading),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun FaceColumn(content: @Composable () -> Unit) {
    Box(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.background), contentAlignment = Alignment.Center) {
        Column(
            horizontalAlignment = Alignment.CenterHorizontally,
            verticalArrangement = Arrangement.Center,
            modifier = Modifier.padding(Spacing.xxl),
        ) { content() }
    }
}

@Composable
private fun UnavailableFace(onBack: () -> Unit) {
    FaceColumn {
        ActivityBadge(null, size = 64.dp, dim = true)
        Spacer(Modifier.height(Spacing.lg))
        Text(stringResource(R.string.activities_unavailable_title), style = MaterialTheme.typography.headlineSmall, textAlign = TextAlign.Center)
        Spacer(Modifier.height(Spacing.sm))
        Text(
            stringResource(R.string.activities_unavailable_body),
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
        )
        TextButton(onClick = onBack, modifier = Modifier.padding(top = Spacing.lg)) { Text(stringResource(R.string.activities_back_to_channel)) }
    }
}

@Composable
private fun EndedFace(name: String, reason: ActivityEndReason, endedByMe: Boolean, onBack: () -> Unit) {
    FaceColumn {
        Box(Modifier.testTag("activities.ended")) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                ActivityBadge(null, size = 64.dp, dim = true)
                Spacer(Modifier.height(Spacing.lg))
                Text(
                    stringResource(R.string.activities_ended_title, name),
                    style = MaterialTheme.typography.headlineSmall,
                    textAlign = TextAlign.Center,
                )
                Spacer(Modifier.height(Spacing.sm))
                Text(
                    endReasonText(reason, endedByMe),
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    textAlign = TextAlign.Center,
                )
                TextButton(onClick = onBack, modifier = Modifier.padding(top = Spacing.lg)) {
                    Text(stringResource(R.string.activities_back_to_channel))
                }
            }
        }
    }
}

@Composable
private fun FailedFace(status: ActivityFrameStatus.Failed, name: String, onRetry: () -> Unit, onBack: () -> Unit) {
    // A refused join because the session is over is an ending, not a failure.
    if (status.reason == ActivityFrameStatus.Reason.JoinFailed && status.code == "ended") {
        EndedFace(name, ActivityEndReason.Other, false, onBack)
        return
    }
    val text = stringResource(
        when {
            status.reason == ActivityFrameStatus.Reason.JoinFailed -> when (status.code) {
                "not-allowed" -> R.string.activities_failed_not_allowed
                "full" -> R.string.activities_failed_full
                "rate-limited" -> R.string.activities_failed_rate_limited
                "unavailable" -> R.string.activities_failed_connection
                else -> R.string.activities_failed_unavailable
            }
            status.reason == ActivityFrameStatus.Reason.BadEntry -> R.string.activities_failed_unavailable
            status.reason == ActivityFrameStatus.Reason.Timeout -> R.string.activities_failed_connection
            else -> R.string.activities_failed_frame
        },
    )
    val retryable = !(status.reason == ActivityFrameStatus.Reason.JoinFailed && (status.code == "not-allowed" || status.code == "full"))
    FaceColumn {
        Box(Modifier.testTag("activities.failed")) {
            Column(horizontalAlignment = Alignment.CenterHorizontally) {
                ActivityBadge(null, size = 64.dp, dim = true)
                Spacer(Modifier.height(Spacing.lg))
                Text(
                    text,
                    style = MaterialTheme.typography.bodyLarge,
                    textAlign = TextAlign.Center,
                    modifier = Modifier.padding(horizontal = Spacing.md),
                )
                Row(Modifier.padding(top = Spacing.lg), verticalAlignment = Alignment.CenterVertically) {
                    if (retryable) {
                        TextButton(onClick = onRetry, modifier = Modifier.testTag("activities.retry")) {
                            Text(stringResource(R.string.activities_failed_retry))
                        }
                    }
                    TextButton(onClick = onBack) { Text(stringResource(R.string.activities_back_to_channel)) }
                }
            }
        }
    }
}

@OptIn(ExperimentalMaterial3Api::class)
@Composable
private fun PeopleSheet(
    appName: String,
    snapshot: SeatSnapshot?,
    members: Map<String, gg.pqp.app.core.ServerMember>,
    onDismiss: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false),
        modifier = Modifier.testTag("activities.peopleSheet"),
    ) {
        Column(Modifier.navigationBarsPadding().padding(bottom = Spacing.lg)) {
            Text(
                text = stringResource(R.string.activities_people_title, appName),
                style = MaterialTheme.typography.titleLarge,
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )
            Spacer(Modifier.height(Spacing.md))
            val people = snapshot?.participants.orEmpty()
            if (people.isEmpty()) {
                Text(
                    stringResource(R.string.activities_people_empty),
                    style = MaterialTheme.typography.bodyMedium,
                    color = colors.onSurfaceVariant,
                    modifier = Modifier.padding(horizontal = Spacing.gutter, vertical = Spacing.lg),
                )
            } else {
                LazyColumn {
                    items(people, key = { it.seatId }) { person ->
                        val member = members[person.userId]
                        val name = ActivityRules.nameOf(member) ?: "?"
                        Row(
                            verticalAlignment = Alignment.CenterVertically,
                            modifier = Modifier
                                .fillMaxWidth()
                                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm),
                        ) {
                            Avatar(name = name, url = member?.avatarUrl, size = Sizes.avatarRow, seed = person.userId)
                            Spacer(Modifier.width(Spacing.md))
                            Text(name, style = MaterialTheme.typography.bodyLarge, modifier = Modifier.weight(1f), maxLines = 1, overflow = TextOverflow.Ellipsis)
                            val tag = when {
                                person.connection == "reconnecting" -> stringResource(R.string.activities_people_reconnecting)
                                person.isHost -> stringResource(R.string.activities_people_host)
                                person.role == "spectator" -> stringResource(R.string.activities_people_watching)
                                else -> null
                            }
                            if (tag != null) {
                                Text(tag, style = MaterialTheme.typography.labelMedium, color = colors.primary)
                            }
                        }
                    }
                }
            }
        }
    }
}

/** A fade in and out, from a scope with no layout receiver: inside a Box inside a Column the receiver overloads hide the plain one. */
@Composable
private fun FadeWhen(visible: Boolean, modifier: Modifier, content: @Composable () -> Unit) {
    AnimatedVisibility(visible = visible, modifier = modifier, enter = fadeIn(), exit = fadeOut()) { content() }
}
