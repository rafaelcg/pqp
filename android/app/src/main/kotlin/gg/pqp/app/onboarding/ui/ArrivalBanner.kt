package gg.pqp.app.onboarding.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.AssistChip
import androidx.compose.material3.AssistChipDefaults
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
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
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.paneTitle
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.core.Channel
import gg.pqp.app.core.Landing
import gg.pqp.app.core.SessionStore
import gg.pqp.app.onboarding.InviteRef
import gg.pqp.app.onboarding.taggedInviteUrl
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/**
 * The first thing somebody sees in a room they just reached from first run,
 * the Android twin of `client/src/components/onboarding/arrival-banner.tsx`.
 *
 * Two variants. Somebody who ARRIVED (an invite) is told where to say oi,
 * with the room's first text channel and first voice channel as one-tap
 * chips: that is the "what you can do here" moment, drawn from what this room
 * actually has rather than a tour of features it may not. Somebody who MADE
 * the room is told it is missing the crew, with the invite one tap away.
 *
 * Confetti is the invitee's: the organizer already had theirs on "pronto".
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun ArrivalBanner(
    session: SessionStore,
    landing: Landing,
    onOpenChannel: (Channel) -> Unit,
    onDismiss: () -> Unit,
) {
    val context = LocalContext.current
    val haptics = rememberOnboardingHaptics()
    var visible by remember { mutableStateOf(false) }
    var channels by remember { mutableStateOf<List<Channel>?>(null) }
    var copied by remember { mutableStateOf(false) }
    var dismissed by remember { mutableStateOf(false) }

    LaunchedEffect(dismissed) {
        if (dismissed) {
            delay(320)
            onDismiss()
        }
    }
    LaunchedEffect(landing.serverId) {
        channels = runCatching { session.api.channels(landing.serverId) }.getOrNull()
        // A beat after the room has drawn, so the banner arrives into it
        // rather than with it.
        delay(350)
        visible = true
        if (landing.kind == Landing.Kind.Arrived) haptics.celebrate()
    }
    LaunchedEffect(copied) {
        if (copied) {
            delay(1_600)
            copied = false
        }
    }

    val text = channels?.filter { it.isText }?.minByOrNull { it.position }
    val voice = channels?.filter { it.isVoice }?.minByOrNull { it.position }
    val paneLabel = stringResource(R.string.arrival_title, landing.serverName)

    Box(Modifier.fillMaxSize()) {
        if (visible && landing.kind == Landing.Kind.Arrived) {
            ConfettiBurst(originY = 0.55f, seed = 11)
        }
        AnimatedVisibility(
            visible = visible && !dismissed,
            enter = slideInVertically(spring(dampingRatio = 0.8f, stiffness = 320f)) { it / 2 } + fadeIn(),
            exit = slideOutVertically { it / 2 } + fadeOut(),
            modifier = Modifier
                .align(Alignment.BottomCenter)
                .navigationBarsPadding()
                .padding(Spacing.md),
        ) {
            Surface(
                shape = MaterialTheme.shapes.large,
                color = MaterialTheme.colorScheme.surfaceContainer,
                border = BorderStroke(1.dp, MaterialTheme.colorScheme.primary.copy(alpha = 0.35f)),
                shadowElevation = 8.dp,
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics {
                        paneTitle = paneLabel
                        liveRegion = LiveRegionMode.Polite
                    },
            ) {
                Column(Modifier.padding(Spacing.lg)) {
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        Icon(
                            if (landing.kind == Landing.Kind.Owner) PqpIcons.Done else PqpIcons.Sparkles,
                            contentDescription = null,
                            tint = MaterialTheme.colorScheme.primary,
                            modifier = Modifier.size(20.dp),
                        )
                        Spacer(Modifier.width(Spacing.sm))
                        Text(
                            text = if (landing.kind == Landing.Kind.Owner) {
                                stringResource(R.string.arrival_owner_title)
                            } else {
                                stringResource(R.string.arrival_title, landing.serverName)
                            },
                            style = MaterialTheme.typography.titleLarge,
                            color = MaterialTheme.colorScheme.onSurface,
                            modifier = Modifier.weight(1f),
                        )
                    }
                    Spacer(Modifier.height(Spacing.sm))
                    Text(
                        text = when {
                            landing.kind == Landing.Kind.Owner -> stringResource(R.string.arrival_owner_body)
                            text != null -> stringResource(R.string.arrival_body, text.name)
                            else -> stringResource(R.string.arrival_body_no_channel)
                        },
                        style = MaterialTheme.typography.bodyMedium,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                    if (landing.kind == Landing.Kind.Arrived && voice != null) {
                        Spacer(Modifier.height(Spacing.xs))
                        Text(
                            text = stringResource(R.string.arrival_voice_hint, voice.name),
                            style = MaterialTheme.typography.bodyMedium,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                    if (landing.kind == Landing.Kind.Arrived && (text != null || voice != null)) {
                        Spacer(Modifier.height(Spacing.md))
                        FlowRow(horizontalArrangement = Arrangement.spacedBy(Spacing.sm)) {
                            listOfNotNull(text, voice).forEach { channel ->
                                AssistChip(
                                    onClick = {
                                        haptics.tick()
                                        onOpenChannel(channel)
                                    },
                                    label = { Text(channel.name) },
                                    leadingIcon = {
                                        Icon(
                                            if (channel.isVoice) PqpIcons.VoiceChannel else PqpIcons.TextChannel,
                                            contentDescription = null,
                                            modifier = Modifier.size(AssistChipDefaults.IconSize),
                                        )
                                    },
                                )
                            }
                        }
                    }
                    Spacer(Modifier.height(Spacing.md))
                    Row(verticalAlignment = Alignment.CenterVertically) {
                        val code = landing.inviteCode
                        if (landing.kind == Landing.Kind.Owner && code != null) {
                            val paste = stringResource(
                                R.string.invite_paste_short_text,
                                taggedInviteUrl(Backend.appUrl, code, InviteRef.Onboarding),
                            )
                            Button(
                                onClick = {
                                    if (copyToClipboard(context, "pqp invite", paste)) {
                                        haptics.confirm()
                                        copied = true
                                    }
                                },
                                shape = MaterialTheme.shapes.small,
                                modifier = Modifier
                                    .heightIn(min = 44.dp)
                                    .semantics { liveRegion = LiveRegionMode.Polite },
                            ) {
                                CopyGlyph(copied = copied)
                                Spacer(Modifier.width(Spacing.xs + 2.dp))
                                Text(
                                    stringResource(
                                        if (copied) R.string.arrival_owner_copied else R.string.arrival_owner_copy,
                                    ),
                                )
                            }
                        }
                        Spacer(Modifier.weight(1f))
                        TextButton(onClick = { dismissed = true }) {
                            Text(stringResource(R.string.arrival_dismiss))
                        }
                    }
                }
            }
        }
    }
}
