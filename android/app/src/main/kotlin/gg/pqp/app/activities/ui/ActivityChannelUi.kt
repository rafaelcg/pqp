package gg.pqp.app.activities.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
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
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.LifecycleResumeEffect
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.activities.ActivitiesHintStore
import gg.pqp.app.activities.ActivitiesStore
import gg.pqp.app.activities.ActivityConsents
import gg.pqp.app.activities.ActivityRules
import gg.pqp.app.activities.ActivityRules.StripAction
import gg.pqp.app.activities.ActivityStarter
import gg.pqp.app.activities.startActivity
import gg.pqp.app.core.PermissionsCache
import gg.pqp.app.core.PermissionsSnapshot
import gg.pqp.app.core.SessionStore
import gg.pqp.app.core.Permission
import gg.pqp.app.core.channelBits
import gg.pqp.app.core.hasPermission
import gg.pqp.app.core.serverPermissions
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/** Where a tap on the strip or the launcher goes: the activity screen, onto this session. */
data class ActivityOpen(val sessionId: String, val appId: String, val spectate: Boolean)

/**
 * What a channel's app bar and header need to know about activities, in one
 * place, so the two surfaces ([ActivityChannelHeader], [ActivityChannelAction])
 * cannot disagree: the config the server answered, the live session, this
 * person's bits in the channel and the channel's kind.
 *
 * Nothing here draws or asks for anything while the server's config is `enabled:
 * false`, or has not answered yet, so a server without activities (and every
 * conversation, forum, jam and watch party) is exactly what it was.
 */
@androidx.compose.runtime.Stable
class ActivityChannelState(
    val store: ActivitiesStore,
    val serverId: String,
    val channelId: String,
    val channelType: String,
    val bits: Long?,
    val manageServer: Boolean,
)

@Composable
fun rememberActivityChannel(
    session: SessionStore,
    serverId: String?,
    channelId: String,
    channelType: String,
): ActivityChannelState? {
    if (serverId == null || ActivityRules.channelKind(channelType) == null) return null
    val store = remember(session) { ActivitiesStore.of(session) }
    LaunchedEffect(serverId) { store.watch(serverId) }
    // The flag may flip while a screen is open: asked again when it comes back to the front (a minute's TTL).
    LifecycleResumeEffect(serverId) {
        store.watch(serverId)
        onPauseOrDispose { }
    }
    val me = (session.phase.collectAsStateWithLifecycle().value as? gg.pqp.app.core.SessionPhase.Ready)?.me?.id
    var snapshot by remember(serverId, me) {
        mutableStateOf<PermissionsSnapshot?>(PermissionsCache.fresh(me, serverId, System.currentTimeMillis()))
    }
    LaunchedEffect(serverId, me) {
        if (snapshot == null) snapshot = runCatching { session.api.serverPermissions(serverId) }.getOrNull()
    }
    val s = snapshot
    return ActivityChannelState(
        store = store,
        serverId = serverId,
        channelId = channelId,
        channelType = channelType,
        bits = s?.channelBits(channelId),
        manageServer = s != null && hasPermission(s.channelBits(channelId), Permission.MANAGE_SERVER),
    )
}

/**
 * The strip of a live activity, and above it, once, the first-run hint. Drawn in
 * the header slot of the chat, above the transcript.
 */
@Composable
fun ActivityChannelHeader(
    session: SessionStore,
    state: ActivityChannelState?,
    onOpen: (ActivityOpen) -> Unit,
) {
    if (state == null) return
    val store = state.store
    val sessions by store.sessions.collectAsStateWithLifecycle()
    val configs by store.configs.collectAsStateWithLifecycle()
    val members by store.members.collectAsStateWithLifecycle()
    val config = configs[state.serverId] ?: return
    if (!config.enabled) return
    val live = sessions[state.channelId]
    val app = live?.let { s -> config.apps.firstOrNull { it.id == s.appId } }
    val viewerId = ActivitiesStore.viewerId(session)
    val starter = members[state.serverId]?.get(live?.startedBy)
    val context = LocalContext.current
    val hints = remember(context) { ActivitiesHintStore(context) }
    var hintGone by remember { mutableStateOf(hints.seen()) }
    val launcherVisible = ActivityRules.launcherVisible(config, state.channelType)
    Column(Modifier.fillMaxWidth()) {
        ActivityStrip(
            session = live,
            app = app,
            startedByName = ActivityRules.nameOf(starter),
            viewerId = viewerId,
            onAction = { action ->
                val sessionId = live?.id ?: return@ActivityStrip
                val appId = live.appId
                when (action) {
                    StripAction.Join -> onOpen(ActivityOpen(sessionId, appId, spectate = false))
                    StripAction.Back -> onOpen(
                        ActivityOpen(sessionId, appId, spectate = live.participants.firstOrNull { it.userId == viewerId }?.role == "spectator"),
                    )
                    StripAction.Watch -> onOpen(ActivityOpen(sessionId, appId, spectate = true))
                    else -> Unit
                }
            },
        )
        ActivityHint(
            visible = launcherVisible && live == null && !hintGone,
            onDismiss = {
                hints.markSeen()
                hintGone = true
            },
        )
    }
}

/** "Novo: atividades", once per device, pointing at the button it is about. */
@Composable
private fun ActivityHint(visible: Boolean, onDismiss: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    AnimatedVisibility(
        visible = visible,
        enter = fadeIn(spring(stiffness = 400f)) + expandVertically(spring(dampingRatio = 0.85f, stiffness = 420f)),
        exit = fadeOut() + shrinkVertically(),
    ) {
        Surface(
            shape = MaterialTheme.shapes.medium,
            color = colors.primary.copy(alpha = 0.10f),
            border = BorderStroke(1.dp, colors.primary.copy(alpha = 0.35f)),
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
                .testTag("activities.hint"),
        ) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier.padding(start = Spacing.md, top = Spacing.sm, bottom = Spacing.sm, end = Spacing.xs),
            ) {
                Icon(PqpIcons.Activities, contentDescription = null, tint = colors.primary)
                Spacer(Modifier.width(Spacing.md))
                Column(Modifier.weight(1f)) {
                    Text(
                        stringResource(R.string.activities_hint_title),
                        style = MaterialTheme.typography.titleSmall,
                        color = colors.onSurface,
                    )
                    Text(
                        stringResource(R.string.activities_hint_body),
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant,
                    )
                }
                TextButton(onClick = onDismiss, modifier = Modifier.testTag("activities.hint.dismiss")) {
                    Text(stringResource(R.string.activities_hint_got_it))
                }
            }
        }
    }
}

/**
 * The app bar button that opens the picker, and the picker with the consent
 * sheet behind it. Absent unless the server released something for this kind of
 * channel (or this person runs the server, who gets the empty state and learns
 * why there is nothing).
 */
@Composable
fun ActivityChannelAction(
    session: SessionStore,
    state: ActivityChannelState?,
    onOpen: (ActivityOpen) -> Unit,
) {
    if (state == null) return
    val store = state.store
    val configs by store.configs.collectAsStateWithLifecycle()
    val sessions by store.sessions.collectAsStateWithLifecycle()
    val config = configs[state.serverId] ?: return
    if (!config.enabled || config.origin == null) return
    val visible = ActivityRules.launcherVisible(config, state.channelType) || state.manageServer
    if (!visible) return

    val scope = rememberCoroutineScope()
    val haptics = LocalHapticFeedback.current
    val context = LocalContext.current
    val hints = remember(context) { ActivitiesHintStore(context) }
    val consents = remember(session) { ActivityConsents.of(session.api) }
    val starter = remember(state.channelId, session) {
        ActivityStarter(
            scope = scope,
            store = store,
            consents = consents,
            channelId = state.channelId,
            start = { appId -> session.api.startActivity(state.channelId, appId) },
        )
    }
    val starterState by starter.state.collectAsStateWithLifecycle()
    var open by remember { mutableStateOf(false) }

    LaunchedEffect(starter) {
        starter.started.collect { started ->
            haptics.performHapticFeedback(HapticFeedbackType.Confirm)
            open = false
            onOpen(ActivityOpen(started.session.id, started.session.appId, spectate = false))
        }
    }

    val bits = state.bits
    val tiles = ActivityRules.tiles(
        config = config,
        channelType = state.channelType,
        live = sessions[state.channelId],
        // Unknown bits (the read has not landed) are allowed: the server stays the gate and says so on start.
        canUseApps = bits == null || ActivityRules.mayUseApps(bits),
        canManageChannels = bits == null || ActivityRules.mayManageChannels(bits),
    )
    IconButton(
        onClick = {
            hints.markSeen()
            starter.clearFailure()
            open = true
        },
        modifier = Modifier.testTag("activities.open"),
    ) {
        Icon(
            imageVector = PqpIcons.Activities,
            contentDescription = stringResource(R.string.activities_open_launcher),
        )
    }
    if (open) {
        ActivityLauncherSheet(
            tiles = tiles,
            state = starterState,
            liveByName = ActivityRules.nameOf(store.memberOf(state.serverId, starterState.liveByUserId)),
            onStart = { tile -> starter.tap(tile.app) },
            onDismiss = { open = false },
        )
    }
    val consentApp = starterState.consentFor?.let { id -> config.apps.firstOrNull { it.id == id } }
    if (consentApp != null) {
        ActivityConsentSheet(
            app = consentApp,
            mode = ConsentMode.Start,
            startedByName = null,
            working = starterState.consentWorking,
            failed = starterState.consentFailed,
            phoneWatchesOnly = !ActivityRules.phoneMayPlay(consentApp),
            onConfirm = { identity -> starter.confirmConsent(consentApp, identity) },
            onDismiss = starter::dismissConsent,
        )
    }
}
