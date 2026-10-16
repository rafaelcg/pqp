package gg.pqp.app.stories.editor

import androidx.compose.animation.core.LinearEasing
import androidx.compose.animation.core.RepeatMode
import androidx.compose.animation.core.animateFloat
import androidx.compose.animation.core.infiniteRepeatable
import androidx.compose.animation.core.rememberInfiniteTransition
import androidx.compose.animation.core.tween
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.em
import gg.pqp.app.R
import gg.pqp.app.stories.StoryLayers
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.Gabarito
import gg.pqp.app.ui.theme.InstrumentSans
import gg.pqp.app.ui.theme.Palette

/** What a call card says about its room right now. */
enum class CallCardState {
    /** People are in it. */
    Live,

    /** Nobody is in it (yet, or any more): the room is still the author's and still joinable. */
    Empty,

    /** The room exists and is open to the author, but this viewer may not connect to it: no button, a short reason. */
    Locked,

    /** A peer-to-peer room at its seat limit: the faces, no way in. */
    Full,

    /** The channel is gone or the author lost the right to use it: a quiet card, no button. */
    Ended,
}

/**
 * The server's `state`, head count and `joinable` as one of the five things the
 * card can say (the semantics of `story.call`, #1210).
 *
 * - `ended` only when the channel was deleted or the author lost CONNECT.
 * - `full` is a mesh room at its seat limit.
 * - `live` stays live with nobody in it: that is [CallCardState.Empty], and it is
 *   joinable. A `live` room this viewer cannot connect to is [CallCardState.Locked],
 *   whatever the head count.
 *
 * [joinable] defaults to true for the editor's preview, which has no viewer to refuse.
 */
fun callCardState(serverState: String, count: Int, joinable: Boolean = true): CallCardState = when {
    serverState == "ended" -> CallCardState.Ended
    serverState == "full" -> CallCardState.Full
    !joinable -> CallCardState.Locked
    count <= 0 -> CallCardState.Empty
    else -> CallCardState.Live
}

/** Whether the lime "Entrar" pill belongs on a card in [state]: only a room somebody may walk into. */
fun callCardCanJoin(state: CallCardState): Boolean = state == CallCardState.Live || state == CallCardState.Empty

/** How many faces are drawn, and what "+n" says about the rest. */
object CallFaces {
    const val SHOWN = 3
    fun more(count: Int): Int = (count - SHOWN).coerceAtLeast(0)
}

/**
 * The "chama pra call" card: the room, the server's icon, who is in it now
 * (up to three faces and "+n") with the count, a live dot that pulses while
 * people are in, and "Entrar". One drawing for the editor's preview and the
 * viewer's result, every size a share of the canvas width.
 *
 * [onJoin] null means the card is only shown (the editor); with it, the whole
 * card is a button for TalkBack and a tap, not only the lime pill.
 */
@Composable
fun StoryCallCard(
    state: CallCardState,
    roomName: String,
    serverName: String,
    serverId: String,
    serverIconUrl: String?,
    faces: List<CallFace>,
    count: Int,
    canvasWidthPx: Float,
    modifier: Modifier = Modifier,
    onJoin: (() -> Unit)? = null,
    /**
     * Whether the lime "Entrar" pill is drawn. The viewer draws it only when the
     * server says the room can be joined (the author watching their own card, in
     * the room already, gets none); the editor's preview always shows it.
     */
    showJoin: Boolean = onJoin != null,
) {
    val u = canvasWidthPx
    val density = LocalDensity.current
    fun dp(share: Float): Dp = with(density) { (u * share).toDp() }
    val ended = state == CallCardState.Ended
    val joinable = onJoin != null && callCardCanJoin(state)
    val locked = state == CallCardState.Locked
    val shape = RoundedCornerShape(dp(0.05f))

    val statusLabel = stringResource(
        when (state) {
            CallCardState.Live -> R.string.stories_call_live
            CallCardState.Empty -> R.string.stories_call_empty
            // Locked says what the room holds, then why there is no button.
            CallCardState.Locked -> if (count > 0) R.string.stories_call_live else R.string.stories_call_empty
            CallCardState.Full -> R.string.stories_call_full
            CallCardState.Ended -> R.string.stories_call_ended
        },
    )
    val peopleLabel = if (count > 0 && !ended) pluralStringResource(R.plurals.stories_editor_call_in_room, count, count) else null
    val join = stringResource(R.string.stories_editor_call_join)
    val lockedReason = if (locked) stringResource(R.string.stories_call_locked) else null
    val description = buildString {
        append(statusLabel)
        if (roomName.isNotBlank()) append(": ").append(roomName)
        if (serverName.isNotBlank()) append(", ").append(serverName)
        peopleLabel?.let { append(", ").append(it) }
        lockedReason?.let { append(". ").append(it) }
        if (joinable) append(". ").append(join)
    }

    val tap = if (joinable) Modifier.clickable(onClick = onJoin!!) else Modifier
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .width(dp(StoryLayers.CALL_CARD_WIDTH))
            .alpha(if (ended) 0.72f else 1f)
            .clip(shape)
            .background(Color.Black.copy(alpha = if (ended) 0.5f else 0.66f))
            .border(
                dp(0.004f),
                if (ended) Color.White.copy(alpha = 0.25f) else Palette.Signal.copy(alpha = 0.75f),
                shape,
            )
            .then(tap)
            .padding(dp(0.03f))
            .semantics(mergeDescendants = true) {
                contentDescription = description
                if (joinable) role = Role.Button
            }
            .testTag("stories.callCard"),
    ) {
        Avatar(
            name = serverName.ifBlank { roomName },
            url = serverIconUrl,
            seed = serverId,
            size = dp(0.11f),
            cornerRadius = dp(0.028f),
        )
        Column(Modifier.weight(1f).padding(horizontal = dp(0.028f))) {
            Row(verticalAlignment = Alignment.CenterVertically) {
                LiveDot(state, dp(0.018f))
                Spacer(Modifier.size(dp(0.012f)))
                Text(
                    statusLabel.uppercase(),
                    color = if (ended) Color.White.copy(alpha = 0.6f) else Palette.Signal,
                    fontFamily = InstrumentSans,
                    fontWeight = FontWeight.Bold,
                    fontSize = with(LocalDensity.current) { (u * 0.024f).toSp() },
                    // Capitals set tight run their words together at this size.
                    letterSpacing = 0.03.em,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            // A deleted channel has no name left to show.
            if (roomName.isNotBlank()) {
                Text(
                    roomName,
                    color = Color.White,
                    fontFamily = Gabarito,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = with(LocalDensity.current) { (u * 0.05f).toSp() },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (serverName.isNotBlank()) {
                Text(
                    serverName,
                    color = Color.White.copy(alpha = 0.65f),
                    fontFamily = InstrumentSans,
                    fontSize = with(LocalDensity.current) { (u * 0.029f).toSp() },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            if (lockedReason != null) {
                Text(
                    lockedReason,
                    color = Palette.Warning,
                    fontFamily = InstrumentSans,
                    fontWeight = FontWeight.SemiBold,
                    fontSize = with(LocalDensity.current) { (u * 0.029f).toSp() },
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
        if (faces.isNotEmpty() && !ended) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                horizontalArrangement = Arrangement.spacedBy(dp(-0.014f)),
                modifier = Modifier.padding(end = dp(0.014f)),
            ) {
                faces.take(CallFaces.SHOWN).forEach {
                    Box(Modifier.border(dp(0.004f), Color.Black, CircleShape).clip(CircleShape)) {
                        Avatar(name = it.name, url = it.avatarUrl, seed = it.id, size = dp(0.064f))
                    }
                }
                val more = CallFaces.more(count)
                if (more > 0) {
                    Box(
                        contentAlignment = Alignment.Center,
                        modifier = Modifier.size(dp(0.064f)).clip(CircleShape).background(Color.White.copy(alpha = 0.22f)),
                    ) {
                        Text(
                            "+$more",
                            color = Color.White,
                            fontFamily = Gabarito,
                            fontWeight = FontWeight.ExtraBold,
                            fontSize = with(LocalDensity.current) { (u * 0.028f).toSp() },
                        )
                    }
                }
            }
        }
        if (showJoin && callCardCanJoin(state)) {
            Row(
                verticalAlignment = Alignment.CenterVertically,
                modifier = Modifier
                    .padding(start = dp(0.01f))
                    .clip(RoundedCornerShape(50))
                    .background(Palette.Signal)
                    .padding(horizontal = dp(0.03f), vertical = dp(0.017f))
                    .testTag("stories.callCard.join"),
            ) {
                Text(
                    join,
                    color = Palette.Ink,
                    fontFamily = Gabarito,
                    fontWeight = FontWeight.ExtraBold,
                    fontSize = with(LocalDensity.current) { (u * 0.036f).toSp() },
                    maxLines = 1,
                )
            }
        }
    }
}

/** The dot beside the status: pulses while people are in, still otherwise. */
@Composable
private fun LiveDot(state: CallCardState, size: Dp) {
    val color = when (state) {
        CallCardState.Live -> Palette.Signal
        CallCardState.Full -> Palette.Warning
        else -> Color.White.copy(alpha = 0.4f)
    }
    val pulse = if (state == CallCardState.Live) {
        // Infinite transitions follow the animator duration scale too: at zero the dot simply stays lit.
        val transition = rememberInfiniteTransition(label = "live-dot")
        val alpha by transition.animateFloat(
            initialValue = 1f,
            targetValue = 0.35f,
            animationSpec = infiniteRepeatable(tween(900, easing = LinearEasing), RepeatMode.Reverse),
            label = "live-dot-alpha",
        )
        alpha
    } else {
        1f
    }
    Box(Modifier.size(size).alpha(pulse).clip(CircleShape).background(color))
}

/** The same card, in the editor: nothing live is known about a room that has not been posted, so its roster is the preview. */
@Composable
fun CallLayerPreview(layer: CallLayer, faces: List<CallFace>, count: Int, canvasWidthPx: Float) {
    StoryCallCard(
        state = callCardState("live", count),
        roomName = layer.roomName,
        serverName = layer.serverName,
        serverId = layer.serverId,
        serverIconUrl = layer.serverIconUrl,
        faces = faces,
        count = count,
        canvasWidthPx = canvasWidthPx,
        showJoin = true,
    )
}
