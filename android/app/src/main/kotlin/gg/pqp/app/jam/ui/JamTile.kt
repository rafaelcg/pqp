package gg.pqp.app.jam.ui

import androidx.compose.animation.AnimatedVisibilityScope
import androidx.compose.animation.ExperimentalSharedTransitionApi
import androidx.compose.animation.SharedTransitionScope
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.FastOutSlowInEasing
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.Image
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.interaction.MutableInteractionSource
import androidx.compose.foundation.interaction.collectIsPressedAsState
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.remember
import androidx.compose.runtime.rememberCoroutineScope
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.draw.drawBehind
import androidx.compose.ui.draw.scale
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.graphics.Brush
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.PathEffect
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.drawscope.Stroke
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.jam.JamInstrument
import gg.pqp.app.jam.JamNeed
import gg.pqp.app.jam.JamPreview
import gg.pqp.app.jam.JamSongSummary
import gg.pqp.app.jam.JamTileSize
import gg.pqp.app.jam.JamWho
import gg.pqp.app.onboarding.ui.rememberReduceMotion
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.launch

/** What a tile needs to take part in the tile-to-song shared element transition; null where there is none. */
@OptIn(ExperimentalSharedTransitionApi::class)
class JamSharedScope(val transition: SharedTransitionScope, val visibility: AnimatedVisibilityScope)

/** The shared bounds of a song's card: the same key on the wall's tile and on the song's header. */
@OptIn(ExperimentalSharedTransitionApi::class)
@Composable
fun Modifier.jamSongBounds(scope: JamSharedScope?, songId: String): Modifier {
    if (scope == null) return this
    return with(scope.transition) {
        this@jamSongBounds.sharedBounds(
            sharedContentState = rememberSharedContentState(key = "jam-song-$songId"),
            animatedVisibilityScope = scope.visibility,
            boundsTransform = { _, _ -> spring(dampingRatio = 0.86f, stiffness = 380f) },
            resizeMode = SharedTransitionScope.ResizeMode.scaleToBounds(ContentScale.Crop),
        )
    }
}

/** The colour a song's tile is drawn in: the dominant (first) instrument's. */
fun jamGround(song: JamSongSummary): Color =
    JamWho.instruments(song).firstOrNull()?.color() ?: JamInstrument.Guitar.color()

/**
 * One song as a tile on the wall.
 *
 *  - A song with video shows a poster frame under a scrim, with light text.
 *  - An audio-only song is a block of its instrument's colour drawing the mix's
 *    waveform from `peaks` in ink. A song with no track yet is an outlined
 *    empty tile.
 *  - Title, who is on it (names once the detail has been read), what it needs.
 *
 * It settles in on a spring (once, staggered by [enterDelayMs]), a live arrival
 * pops in with a lime ring and a "nova" mark, a press leans into the tile, and
 * under "remove animations" it simply appears.
 */
@Composable
fun JamTile(
    song: JamSongSummary,
    size: JamTileSize,
    preview: JamPreview?,
    fresh: Boolean,
    enterDelayMs: Long,
    animateEnter: Boolean,
    shared: JamSharedScope?,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val reduce = rememberReduceMotion()
    val colors = MaterialTheme.colorScheme
    val need = remember(song) { JamNeed.of(song) }
    val empty = song.trackCount == 0
    val poster = if (preview?.hasVideo == true) rememberJamPoster(preview.posterUrl) else null
    val hasPoster = poster != null
    val ground = if (empty) colors.surfaceContainer else jamGround(song)
    val onGround = when {
        empty -> colors.onSurface
        hasPoster -> Color.White
        else -> JamInk
    }
    val shape = RoundedCornerShape(if (size == JamTileSize.Small) 18.dp else 22.dp)

    // Entrance: alpha and scale on one spring. Skipped under reduced motion and for tiles that were already settled.
    val enter = remember { Animatable(if (reduce || !animateEnter && !fresh) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (enter.value < 1f) {
            if (enterDelayMs > 0) kotlinx.coroutines.delay(enterDelayMs)
            enter.animateTo(1f, spring(dampingRatio = if (fresh) 0.55f else 0.8f, stiffness = 320f))
        }
    }

    // The waveform draws in once its numbers arrive.
    val draw = remember { Animatable(if (reduce) 1f else 0f) }
    val envelopeReady = preview != null
    LaunchedEffect(envelopeReady) {
        if (envelopeReady && draw.value < 1f) draw.animateTo(1f, tween(650, easing = FastOutSlowInEasing))
    }

    val interactions = remember { MutableInteractionSource() }
    val pressed by interactions.collectIsPressedAsState()
    val lean = remember { Animatable(1f) }
    LaunchedEffect(pressed) { lean.animateTo(if (pressed && !reduce) 0.965f else 1f, spring(dampingRatio = 0.7f, stiffness = 1400f)) }

    val who = JamWho.line(song, preview?.contributors)
    val subtitle = listOfNotNull(
        song.artist?.takeIf { it.isNotBlank() } ?: stringResource(R.string.jam_original).takeIf { !empty },
        who.takeIf { it.isNotEmpty() },
    ).joinToString(" · ")
    val needText = need.text()
    val description = stringResource(R.string.jam_tile_description, song.title, subtitle.ifEmpty { who }, needText)

    Box(
        modifier = modifier
            .jamSongBounds(shared, song.id)
            .graphicsLayer {
                alpha = enter.value.coerceIn(0f, 1f)
                val s = (0.86f + 0.14f * enter.value) * lean.value
                scaleX = s
                scaleY = s
            }
            .clip(shape)
            .background(ground)
            .then(
                if (empty) {
                    Modifier.drawBehind {
                        drawRoundRect(
                            color = colors.outline,
                            cornerRadius = androidx.compose.ui.geometry.CornerRadius(22.dp.toPx()),
                            style = Stroke(width = 1.5.dp.toPx(), pathEffect = PathEffect.dashPathEffect(floatArrayOf(14f, 10f))),
                        )
                    }
                } else {
                    Modifier
                },
            )
            .then(if (fresh) Modifier.border(BorderStroke(2.dp, colors.primary), shape) else Modifier)
            .clickable(interactionSource = interactions, indication = null, onClick = onClick)
            .clearAndSetSemantics {
                contentDescription = description
                role = Role.Button
            }
            .testTag("jam.tile.${song.id}"),
    ) {
        if (poster != null) {
            Image(
                bitmap = poster,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
            Box(
                Modifier
                    .fillMaxSize()
                    .background(
                        Brush.verticalGradient(
                            0f to Color.Transparent,
                            0.45f to Color(0x33000000),
                            1f to Color(0xCC05080C),
                        ),
                    ),
            )
        } else if (!empty) {
            // The mix's waveform in ink across the upper part of the tile.
            JamWaveform(
                values = preview?.envelope.orEmpty(),
                color = JamInk.copy(alpha = 0.78f),
                draw = { draw.value },
                barWidthPx = if (size == JamTileSize.Small) 5f else 7f,
                gapPx = if (size == JamTileSize.Small) 4f else 5f,
                minHeightPx = 4f,
                modifier = Modifier
                    .fillMaxWidth()
                    .fillMaxHeight(if (size == JamTileSize.Hero) 0.5f else 0.42f)
                    .padding(top = 28.dp, start = 14.dp, end = 14.dp),
            )
        }

        // Instruments, top left: one glyph each, so "who plays what" reads before a word does.
        if (!empty) {
            Row(
                Modifier.align(Alignment.TopStart).padding(12.dp),
                horizontalArrangement = Arrangement.spacedBy(4.dp),
            ) {
                JamWho.instruments(song).take(5).forEach { instrument ->
                    Icon(instrument.icon(), contentDescription = null, tint = onGround, modifier = Modifier.size(16.dp))
                }
            }
        }

        if (fresh) {
            Text(
                text = stringResource(R.string.jam_tile_new),
                style = MaterialTheme.typography.labelSmall,
                fontWeight = FontWeight.Bold,
                color = colors.onPrimary,
                modifier = Modifier
                    .align(Alignment.TopEnd)
                    .padding(10.dp)
                    .clip(RoundedCornerShape(50))
                    .background(colors.primary)
                    .padding(horizontal = 8.dp, vertical = 2.dp),
            )
        }

        Column(
            Modifier.align(Alignment.BottomStart).padding(14.dp),
            verticalArrangement = Arrangement.spacedBy(2.dp),
        ) {
            Text(
                text = song.title,
                style = if (size == JamTileSize.Hero) MaterialTheme.typography.headlineSmall else MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.ExtraBold,
                color = onGround,
                maxLines = if (size == JamTileSize.Hero) 3 else 2,
                overflow = TextOverflow.Ellipsis,
            )
            if (subtitle.isNotEmpty()) {
                Text(
                    text = subtitle,
                    style = MaterialTheme.typography.labelMedium,
                    color = onGround.copy(alpha = 0.82f),
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            Spacer6()
            NeedChip(need, text = needText, onGround = onGround, empty = empty, poster = hasPoster)
        }
    }
}

@Composable
private fun Spacer6() = androidx.compose.foundation.layout.Spacer(Modifier.size(width = 1.dp, height = 6.dp))

/** The "falta voz" pill: ink on a lime tile reads as a stamp; on a poster it is a lime pill. */
@Composable
private fun NeedChip(need: JamNeed, text: String, onGround: Color, empty: Boolean, poster: Boolean) {
    val colors = MaterialTheme.colorScheme
    val callout = need.isCallout
    val (background, content) = when {
        callout && poster -> colors.primary to colors.onPrimary
        callout || (!empty && !poster) -> JamInk to Color(0xFFF0EEE8)
        poster -> Color(0x66000000) to Color.White
        else -> colors.surfaceContainerHigh to colors.onSurfaceVariant
    }
    Text(
        text = text,
        style = MaterialTheme.typography.labelMedium,
        fontWeight = FontWeight.SemiBold,
        color = content,
        maxLines = 1,
        overflow = TextOverflow.Ellipsis,
        modifier = Modifier
            .clip(RoundedCornerShape(50))
            .background(background)
            .padding(horizontal = Spacing.sm + 2.dp, vertical = 3.dp),
    )
}
