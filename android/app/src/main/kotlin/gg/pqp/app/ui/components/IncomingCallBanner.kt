package gg.pqp.app.ui.components

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.expandVertically
import androidx.compose.animation.shrinkVertically
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.FilledIconButton
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.IconButtonDefaults
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import gg.pqp.app.voice.CallController
import gg.pqp.app.voice.CallKind
import gg.pqp.app.voice.CallState
import gg.pqp.app.voice.IncomingCall

/**
 * The ringing surface: one card per conversation calling this account, laid
 * over whatever the person is doing.
 *
 * Drawn at the app root, the way the web's `IncomingCallOverlay` is, because a
 * call arrives wherever you are. Three answers, mirroring a phone: accept
 * joins the room (the join is the acceptance, there is no frame), decline
 * tells the caller no, and the cross is silence on this device only.
 */
@Composable
fun IncomingCallBanner(state: CallState, calls: CallController, modifier: Modifier = Modifier) {
    AnimatedVisibility(
        visible = state.isRinging,
        enter = expandVertically(),
        exit = shrinkVertically(),
        modifier = modifier,
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .padding(horizontal = Spacing.sm, vertical = Spacing.xs),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            state.incoming.forEach { call ->
                IncomingCallCard(
                    call = call,
                    onAccept = { calls.accept(call.conversationId) },
                    onDecline = { calls.decline(call.conversationId) },
                    onDismiss = { calls.dismiss(call.conversationId) },
                )
            }
        }
    }
}

@Composable
private fun IncomingCallCard(
    call: IncomingCall,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
    onDismiss: () -> Unit,
) {
    val subtitle = stringResource(
        if (call.kind == CallKind.Group) R.string.call_incoming_group_title else R.string.call_incoming_title,
    )
    // The microphone is asked for on the tap, never on the ring: a permission
    // dialog jumping out of a card nobody has touched yet is a card that gets
    // declined by reflex.
    val withMicrophone = rememberMicrophoneGate()
    val label = "${call.caller.displayName}: $subtitle"

    Surface(
        color = MaterialTheme.colorScheme.surfaceContainerHigh,
        shape = MaterialTheme.shapes.medium,
        modifier = Modifier
            .fillMaxWidth()
            .testTag("call.incoming")
            .semantics { contentDescription = label },
    ) {
        Row(
            modifier = Modifier.padding(
                start = Spacing.md,
                end = Spacing.xs,
                top = Spacing.sm,
                bottom = Spacing.sm,
            ),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Avatar(name = call.caller.displayName, url = call.caller.avatarUrl, size = Sizes.avatarRow)
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f)) {
                Text(
                    text = call.caller.displayName,
                    style = MaterialTheme.typography.titleSmall,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            FilledIconButton(
                onClick = { withMicrophone(onAccept) },
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.primary,
                    contentColor = MaterialTheme.colorScheme.onPrimary,
                ),
                modifier = Modifier.testTag("call.accept"),
            ) {
                Icon(
                    imageVector = PqpIcons.Call,
                    contentDescription = stringResource(R.string.call_accept),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
            FilledIconButton(
                onClick = onDecline,
                colors = IconButtonDefaults.filledIconButtonColors(
                    containerColor = MaterialTheme.colorScheme.error,
                    contentColor = MaterialTheme.colorScheme.onError,
                ),
                modifier = Modifier.testTag("call.decline"),
            ) {
                Icon(
                    imageVector = PqpIcons.HangUp,
                    contentDescription = stringResource(R.string.call_decline),
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
            IconButton(onClick = onDismiss) {
                Icon(
                    imageVector = PqpIcons.Close,
                    contentDescription = stringResource(R.string.call_ignore),
                    tint = MaterialTheme.colorScheme.onSurfaceVariant,
                    modifier = Modifier.size(Sizes.iconAction),
                )
            }
        }
    }
}
