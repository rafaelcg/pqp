package gg.pqp.app.jam.ui

import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.ExperimentalLayoutApi
import androidx.compose.foundation.layout.FlowRow
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.AlertDialog
import androidx.compose.material3.Button
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pqp.app.R
import gg.pqp.app.jam.JamAnswer
import gg.pqp.app.jam.JamAnswerKind
import gg.pqp.app.jam.JamBidi
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamNaming
import gg.pqp.app.jam.JamRequestAction
import gg.pqp.app.jam.JamRequestFailure
import gg.pqp.app.jam.JamRequestsUi
import gg.pqp.app.jam.JamTrack
import gg.pqp.app.jam.JamWriteFailure
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/**
 * "N partes esperando tua resposta": the parts people outside sent to a song this person started, FIRST on the page and
 * above the stage (finding them took a starter six minutes when they sat below it, launch user test N1), each heard with
 * the band and then accepted or declined (the web's `JamPublicRequests`). They are a question, not part of the song yet,
 * so they sit apart from the lanes.
 *
 * Every row is a [FlowRow] of whole buttons: none is pushed off, or broken mid-word, between 320 and 430 dp and at any
 * font scale. A refused write is said directly under the part it is about.
 */
@OptIn(ExperimentalLayoutApi::class)
@Composable
fun JamRequestsBlock(
    takes: List<JamTrack>,
    autoAccept: Boolean,
    /** The parts being heard RIGHT NOW (playing, or about to): the label follows real playback, never a refused tap. */
    listening: Set<String>,
    requests: JamRequestsUi,
    onListen: (JamTrack) -> Unit,
    onAccept: (JamTrack) -> Unit,
    onDecline: (JamTrack) -> Unit,
    modifier: Modifier = Modifier,
) {
    if (takes.isEmpty()) return
    val colors = MaterialTheme.colorScheme
    Column(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(20.dp))
            .background(colors.surfaceContainer)
            .border(BorderStroke(2.dp, colors.primary), RoundedCornerShape(20.dp))
            .padding(Spacing.md)
            .animateContentSize(spring(dampingRatio = 0.85f, stiffness = 380f))
            .testTag("jam.requests"),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Text(
            pluralStringResource(R.plurals.jam_requests_banner, takes.size, takes.size),
            style = MaterialTheme.typography.titleMedium,
            fontWeight = FontWeight.ExtraBold,
            modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite },
        )
        Text(
            stringResource(if (autoAccept) R.string.jam_requests_hint_auto else R.string.jam_requests_hint),
            style = MaterialTheme.typography.bodySmall,
            color = colors.onSurfaceVariant,
        )
        takes.forEach { track ->
            androidx.compose.runtime.key(track.id) {
                RequestRow(
                    track = track,
                    heard = track.id in listening,
                    busy = requests.busy != null,
                    failure = requests.failure?.takeIf { it.trackId == track.id },
                    onListen = { onListen(track) },
                    onAccept = { onAccept(track) },
                    onDecline = { onDecline(track) },
                )
            }
        }
    }
}

@OptIn(ExperimentalLayoutApi::class)
@Composable
private fun RequestRow(
    track: JamTrack,
    heard: Boolean,
    busy: Boolean,
    failure: JamRequestFailure?,
    onListen: () -> Unit,
    onAccept: () -> Unit,
    onDecline: () -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val name = JamBidi.clean(track.authorName ?: stringResource(R.string.jam_answer_anonymous))
    // What a screen reader says for each button: whose part and which instrument, so three parts are not three
    // identical "Aceitar".
    val who = track.instrument.label()
    val listenFor = stringResource(if (heard) R.string.jam_requests_stop_for else R.string.jam_requests_listen_for, who, name)
    val acceptFor = stringResource(R.string.jam_requests_accept_for, who, name)
    val declineFor = stringResource(R.string.jam_requests_decline_for, who, name)
    // The glyph grows with the text it sits beside.
    val glyph = with(androidx.compose.ui.platform.LocalDensity.current) { 16.sp.toDp() }
    Column(
        Modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(14.dp))
            .background(colors.surfaceContainerHigh)
            .padding(Spacing.md)
            .testTag("jam.request.${track.id}"),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically, horizontalArrangement = Arrangement.spacedBy(Spacing.sm + 2.dp)) {
            androidx.compose.foundation.layout.Box(
                Modifier.size(36.dp).clip(CircleShape).background(track.instrument.color()),
                contentAlignment = Alignment.Center,
            ) {
                Icon(track.instrument.icon(), contentDescription = null, tint = JamInk, modifier = Modifier.size(18.dp))
            }
            Column(Modifier.weight(1f)) {
                Text(
                    JamNaming.heading(track.instrument.title(), track.label),
                    style = MaterialTheme.typography.titleSmall,
                    fontWeight = FontWeight.Bold,
                    maxLines = 2,
                    overflow = TextOverflow.Ellipsis,
                )
                Text(
                    name,
                    style = MaterialTheme.typography.labelMedium,
                    color = colors.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        // Whole buttons that wrap as buttons: a fixed row of three squeezed the last one out at a large font.
        FlowRow(
            horizontalArrangement = Arrangement.spacedBy(Spacing.sm),
            verticalArrangement = Arrangement.spacedBy(2.dp),
            itemVerticalAlignment = Alignment.CenterVertically,
            modifier = Modifier.fillMaxWidth(),
        ) {
            OutlinedButton(
                onClick = onListen,
                modifier = Modifier.semantics { contentDescription = listenFor }.testTag("jam.request.listen.${track.id}"),
            ) {
                Icon(if (heard) PqpIcons.Pause else PqpIcons.Play, contentDescription = null, modifier = Modifier.size(glyph))
                Spacer(Modifier.width(6.dp))
                Text(stringResource(if (heard) R.string.jam_requests_stop else R.string.jam_requests_listen))
            }
            Button(
                onClick = onAccept,
                enabled = !busy,
                modifier = Modifier.semantics { contentDescription = acceptFor }.testTag("jam.request.accept.${track.id}"),
            ) {
                Text(stringResource(R.string.jam_requests_accept))
            }
            TextButton(
                onClick = onDecline,
                enabled = !busy,
                modifier = Modifier.semantics { contentDescription = declineFor }.testTag("jam.request.decline.${track.id}"),
            ) {
                Text(stringResource(R.string.jam_requests_decline))
            }
        }
        if (failure != null) {
            // Directly under the buttons that caused it, announced, and kept until the next try or the next answer.
            Text(
                requestFailureText(failure),
                style = MaterialTheme.typography.bodySmall,
                color = colors.error,
                modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("jam.request.error.${track.id}"),
            )
        }
    }
}

@Composable
fun requestFailureText(failure: JamRequestFailure): String = stringResource(
    when (failure.failure) {
        JamWriteFailure.Off -> R.string.jam_err_off
        JamWriteFailure.Network -> R.string.jam_err_network
        JamWriteFailure.RateLimited -> R.string.jam_err_rate_limited
        else -> when (failure.action) {
            JamRequestAction.Accept -> R.string.jam_requests_failed_accept
            JamRequestAction.Decline -> R.string.jam_requests_failed_decline
            JamRequestAction.Undo -> R.string.jam_requests_failed_undo
        }
    },
)

/**
 * What the starter's last answer did, said where they gave it (user test round 3, n-1: after "Aceitar" the box vanished
 * and a tile appeared, and the starter said it was quiet): the part is in, and what the public sees now, with
 * "Desfazer" for the length of the box; back in the queue; or declined, with no undo. It leaves by itself.
 */
@Composable
fun JamAnswerBox(
    answer: JamAnswer,
    busy: Boolean,
    failure: JamRequestFailure?,
    onUndo: () -> Unit,
    onDismiss: () -> Unit,
    modifier: Modifier = Modifier,
) {
    // One timer per answer: a recomposition with the same answer must not start the clock over.
    LaunchedEffect(answer.kind, answer.trackId) {
        delay(answer.lifetimeMs)
        onDismiss()
    }
    val colors = MaterialTheme.colorScheme
    val name = JamBidi.isolate(answer.name ?: stringResource(R.string.jam_answer_anonymous))
    val instrument = answer.instrument.label()
    Row(
        modifier
            .fillMaxWidth()
            .clip(RoundedCornerShape(16.dp))
            .background(colors.surfaceContainerHigh)
            .padding(start = Spacing.md, top = Spacing.md, bottom = Spacing.md, end = Spacing.xs)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("jam.answer.${answer.kind.name.lowercase()}"),
        horizontalArrangement = Arrangement.spacedBy(Spacing.md),
    ) {
        androidx.compose.foundation.layout.Box(
            Modifier.padding(top = 2.dp).size(32.dp).clip(CircleShape).background(colors.surfaceContainerHighest),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                if (answer.kind == JamAnswerKind.Refused) PqpIcons.Block else PqpIcons.Confirm,
                contentDescription = null,
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(18.dp),
            )
        }
        Column(Modifier.weight(1f), verticalArrangement = Arrangement.spacedBy(Spacing.sm)) {
            Text(
                stringResource(
                    when (answer.kind) {
                        JamAnswerKind.Accepted -> R.string.jam_answer_accepted
                        JamAnswerKind.Undone -> R.string.jam_answer_undone
                        JamAnswerKind.Refused -> R.string.jam_answer_refused
                    },
                    name,
                    instrument,
                ),
                style = MaterialTheme.typography.titleSmall,
                fontWeight = FontWeight.SemiBold,
            )
            if (answer.kind == JamAnswerKind.Accepted) {
                OutlinedButton(onClick = onUndo, enabled = !busy, modifier = Modifier.testTag("jam.answer.undo")) {
                    Icon(PqpIcons.Undo, contentDescription = null, modifier = Modifier.size(with(androidx.compose.ui.platform.LocalDensity.current) { 16.sp.toDp() }))
                    Spacer(Modifier.width(6.dp))
                    Text(stringResource(R.string.jam_answer_undo))
                }
            }
            if (failure != null) {
                Text(
                    requestFailureText(failure),
                    style = MaterialTheme.typography.bodySmall,
                    color = colors.error,
                    modifier = Modifier.semantics { liveRegion = LiveRegionMode.Polite }.testTag("jam.answer.error"),
                )
            }
        }
        IconButton(onClick = onDismiss, modifier = Modifier.testTag("jam.answer.close")) {
            Icon(PqpIcons.Close, contentDescription = stringResource(R.string.jam_answer_close), modifier = Modifier.size(18.dp))
        }
    }
}

/** "Recusar esse pedido?": the recording is deleted, so it asks. */
@Composable
fun JamDeclineDialog(track: JamTrack, enabled: Boolean, onConfirm: () -> Unit, onDismiss: () -> Unit) {
    AlertDialog(
        onDismissRequest = onDismiss,
        title = {
            Text(
                stringResource(
                    R.string.jam_requests_decline_title,
                    track.instrument.label(),
                    JamBidi.isolate(track.authorName ?: stringResource(R.string.jam_answer_anonymous)),
                ),
            )
        },
        text = { Text(stringResource(R.string.jam_requests_decline_body)) },
        confirmButton = {
            TextButton(onClick = onConfirm, enabled = enabled, modifier = Modifier.testTag("jam.decline.confirm")) {
                Text(stringResource(R.string.jam_requests_decline), color = MaterialTheme.colorScheme.error)
            }
        },
        dismissButton = { TextButton(onClick = onDismiss) { Text(stringResource(R.string.jam_cancel)) } },
        modifier = Modifier.testTag("jam.decline.${track.id}"),
    )
}
