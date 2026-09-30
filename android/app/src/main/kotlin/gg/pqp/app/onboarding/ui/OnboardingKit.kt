package gg.pqp.app.onboarding.ui

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.content.Intent
import android.provider.Settings
import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.animateColorAsState
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.animation.core.tween
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.scaleIn
import androidx.compose.animation.scaleOut
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableFloatStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.runtime.withFrameNanos
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.geometry.Size
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.drawscope.rotate
import androidx.compose.ui.graphics.graphicsLayer
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.clearAndSetSemantics
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.heading
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.ui.theme.LocalIsDark
import gg.pqp.app.ui.theme.Palette
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.sin
import kotlin.random.Random
import kotlinx.coroutines.delay

/**
 * The pieces every first-run screen shares: the progress rail, the header,
 * the buttons, the copy feedback and the confetti. Kept out of the flow so the
 * flow reads as the steps and nothing else.
 */

/**
 * "Remove animations" in Accessibility (or developer options' animator scale
 * at zero).
 *
 * Compose already scales its own animation clocks by this setting, so springs
 * and fades settle instantly without any help. Read here for the two things it
 * does not cover: the confetti, which runs on a hand-driven frame loop, and
 * the staggered delays, which are `delay()` calls a zero scale does not touch.
 */
@Composable
fun rememberReduceMotion(): Boolean {
    val context = LocalContext.current
    return remember(context) {
        Settings.Global.getFloat(
            context.contentResolver,
            Settings.Global.ANIMATOR_DURATION_SCALE,
            1f,
        ) == 0f
    }
}

/**
 * The progress rail: one segment per screen, the current one stretched.
 *
 * The web draws the same thing as dots (`step-dots.tsx`); stretched segments
 * are the Android reading of it, and the stretch is a spring so the step
 * change is felt in the rail as well as in the content. TalkBack hears
 * "Step 2 of 4" and nothing about the shapes.
 */
@Composable
fun StepRail(index: Int, total: Int, modifier: Modifier = Modifier) {
    val description = stringResource(R.string.onboarding_progress, index + 1, total)
    Row(
        modifier = modifier.clearAndSetSemantics { contentDescription = description },
        horizontalArrangement = Arrangement.spacedBy(6.dp),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        repeat(total) { position ->
            val active = position == index
            val done = position < index
            val width by animateDpAsState(
                targetValue = if (active) 28.dp else 8.dp,
                animationSpec = spring(dampingRatio = 0.62f, stiffness = 420f),
                label = "rail-width",
            )
            val color by animateColorAsState(
                targetValue = when {
                    active -> MaterialTheme.colorScheme.primary
                    done -> MaterialTheme.colorScheme.primary.copy(alpha = 0.45f)
                    else -> MaterialTheme.colorScheme.outline
                },
                animationSpec = tween(220),
                label = "rail-color",
            )
            Box(
                Modifier
                    .width(width)
                    .height(8.dp)
                    .clip(CircleShape)
                    .background(color),
            )
        }
    }
}

/** Eyebrow, title and one sentence, the same three lines on every step. */
@Composable
fun StepHeader(
    eyebrow: String,
    title: String,
    description: String,
    icon: ImageVector,
    modifier: Modifier = Modifier,
) {
    Column(modifier) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Box(
                modifier = Modifier
                    .size(24.dp)
                    .clip(RoundedCornerShape(7.dp))
                    .background(MaterialTheme.colorScheme.primary.copy(alpha = 0.16f)),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    icon,
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.primary,
                    modifier = Modifier.size(14.dp),
                )
            }
            Spacer(Modifier.width(Spacing.sm))
            Text(
                text = eyebrow.uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.primary,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
        }
        Spacer(Modifier.height(Spacing.md))
        Text(
            text = title,
            style = MaterialTheme.typography.headlineMedium,
            color = MaterialTheme.colorScheme.onBackground,
            modifier = Modifier.semantics { heading() },
        )
        Spacer(Modifier.height(Spacing.sm))
        Text(
            text = description,
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
    }
}

/**
 * The one lime button on a screen. `quiet` steps it back to the tonal colour,
 * which the ready step uses until something has been copied: copying is that
 * screen's point, and the way in only becomes the loud thing after.
 */
@Composable
fun PrimaryButton(
    text: String,
    onClick: () -> Unit,
    modifier: Modifier = Modifier,
    enabled: Boolean = true,
    busy: Boolean = false,
    quiet: Boolean = false,
) {
    val container by animateColorAsState(
        targetValue = if (quiet) MaterialTheme.colorScheme.surfaceContainerHigh else MaterialTheme.colorScheme.primary,
        animationSpec = tween(260),
        label = "primary-container",
    )
    val content by animateColorAsState(
        targetValue = if (quiet) MaterialTheme.colorScheme.onSurface else MaterialTheme.colorScheme.onPrimary,
        animationSpec = tween(260),
        label = "primary-content",
    )
    Button(
        onClick = onClick,
        enabled = enabled && !busy,
        shape = MaterialTheme.shapes.small,
        colors = ButtonDefaults.buttonColors(containerColor = container, contentColor = content),
        modifier = modifier
            .fillMaxWidth()
            .heightIn(min = 52.dp),
    ) {
        if (busy) {
            CircularProgressIndicator(
                modifier = Modifier.size(Sizes.iconInline),
                strokeWidth = 2.dp,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            Spacer(Modifier.width(Spacing.sm))
        }
        Text(text, maxLines = 2, overflow = TextOverflow.Ellipsis)
    }
}

/** The copy glyph turning into a check, with a little overshoot. */
@Composable
fun CopyGlyph(copied: Boolean, modifier: Modifier = Modifier, tint: Color = Color.Unspecified) {
    AnimatedContent(
        targetState = copied,
        transitionSpec = {
            (scaleIn(spring(dampingRatio = 0.5f, stiffness = 700f), initialScale = 0.6f) + fadeIn(tween(90)))
                .togetherWith(scaleOut(targetScale = 0.6f) + fadeOut(tween(90)))
        },
        label = "copy-glyph",
        modifier = modifier,
    ) { done ->
        Icon(
            imageVector = if (done) PqpIcons.Confirm else PqpIcons.Copy,
            contentDescription = null,
            tint = if (done) successColor() else tint.takeOrElse(),
            modifier = Modifier.size(18.dp),
        )
    }
}

@Composable
private fun Color.takeOrElse(): Color =
    if (this == Color.Unspecified) androidx.compose.material3.LocalContentColor.current else this

@Composable
fun successColor(): Color = if (LocalIsDark.current) Palette.Success else Color(0xFF2E8A3C)

/**
 * The haptic vocabulary of first run, three words:
 * `tick` for a door or a toggle, `confirm` for something landing (a copy,
 * a room made), `celebrate` for arriving.
 */
class OnboardingHaptics(private val perform: (HapticFeedbackType) -> Unit) {
    fun tick() = perform(HapticFeedbackType.SegmentTick)
    fun confirm() = perform(HapticFeedbackType.Confirm)
    fun celebrate() = perform(HapticFeedbackType.LongPress)
    fun reject() = perform(HapticFeedbackType.Reject)
}

@Composable
fun rememberOnboardingHaptics(): OnboardingHaptics {
    val haptics = LocalHapticFeedback.current
    return remember(haptics) { OnboardingHaptics { haptics.performHapticFeedback(it) } }
}

/** True when the text reached the clipboard. A "Copied" that lies is worse than none. */
fun copyToClipboard(context: Context, label: String, text: String): Boolean = runCatching {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText(label, text))
}.isSuccess

/** The system share sheet. Where the text goes is the phone's business. */
fun shareText(context: Context, text: String, chooserTitle: String) {
    val send = Intent(Intent.ACTION_SEND).apply {
        type = "text/plain"
        putExtra(Intent.EXTRA_TEXT, text)
    }
    runCatching { context.startActivity(Intent.createChooser(send, chooserTitle)) }
}

/**
 * Something that rises into place `delayMillis` after it is first composed:
 * 14dp and a fade, on the standard spring. With "remove animations" on it is
 * simply there.
 */
@Composable
fun Modifier.riseIn(delayMillis: Int = 0, distance: Dp = 14.dp): Modifier {
    val reduce = rememberReduceMotion()
    val progress = remember { Animatable(if (reduce) 1f else 0f) }
    LaunchedEffect(Unit) {
        if (reduce) return@LaunchedEffect
        if (delayMillis > 0) delay(delayMillis.toLong())
        progress.animateTo(1f, spring(dampingRatio = 0.8f, stiffness = 300f))
    }
    return this.graphicsLayer {
        val p = progress.value
        alpha = p.coerceIn(0f, 1f)
        translationY = (1f - p) * distance.toPx()
    }
}

// ------------------------------------------------------------------ confetti

private class Piece(
    val angle: Float,
    val speed: Float,
    val spin: Float,
    val color: Color,
    val w: Float,
    val h: Float,
    val round: Boolean,
    val sway: Float,
)

private val ConfettiColors = listOf(
    Palette.Signal,
    Palette.SignalDim,
    Palette.Warning,
    Palette.Success,
    Color(0xFF8AB4F8),
    Color(0xFFF28FAD),
    Palette.Paper,
)

/**
 * One burst, about 2.6 s, then nothing: no layer left behind to intercept a
 * tap. Pieces leave from a point near the top third, fan out upward and fall
 * with a little sway, the way paper does. Skipped entirely under "remove
 * animations", where the moment is the haptic and the words.
 */
@Composable
fun ConfettiBurst(modifier: Modifier = Modifier, originY: Float = 0.32f, seed: Int = 7) {
    if (rememberReduceMotion()) return
    val pieces = remember(seed) {
        val random = Random(seed)
        List(110) {
            val spread = (random.nextFloat() - 0.5f) * 1.9f
            Piece(
                angle = (-PI / 2).toFloat() + spread,
                speed = 520f + random.nextFloat() * 760f,
                spin = (random.nextFloat() - 0.5f) * 900f,
                color = ConfettiColors[random.nextInt(ConfettiColors.size)],
                w = 5f + random.nextFloat() * 5f,
                h = 8f + random.nextFloat() * 8f,
                round = random.nextFloat() < 0.22f,
                sway = random.nextFloat() * 2f * PI.toFloat(),
            )
        }
    }
    var t by remember { mutableFloatStateOf(0f) }
    var running by remember { mutableStateOf(true) }
    LaunchedEffect(Unit) {
        val start = withFrameNanos { it }
        while (true) {
            val now = withFrameNanos { it }
            t = (now - start) / 1_000_000_000f
            if (t > DURATION) break
        }
        running = false
    }
    if (!running) return
    Canvas(modifier.fillMaxSize()) {
        val origin = Offset(size.width / 2f, size.height * originY)
        val gravity = 1500f * density / 2.6f
        val fade = ((DURATION - t) / 0.7f).coerceIn(0f, 1f)
        pieces.forEach { p ->
            // Speed decays (air), gravity accumulates, and a sine sway makes
            // the fall read as paper rather than as gravel.
            val drag = 1f - (t / DURATION) * 0.55f
            val vx = cos(p.angle) * p.speed * density / 2.6f * drag
            val vy = sin(p.angle) * p.speed * density / 2.6f * drag
            val x = origin.x + vx * t + sin(p.sway + t * 5f) * 10f * density
            val y = origin.y + vy * t + 0.5f * gravity * t * t
            val w = p.w * density
            val h = p.h * density
            rotate(degrees = p.spin * t, pivot = Offset(x, y)) {
                if (p.round) {
                    drawCircle(p.color.copy(alpha = fade), radius = w / 1.6f, center = Offset(x, y))
                } else {
                    drawRect(
                        color = p.color.copy(alpha = fade),
                        topLeft = Offset(x - w / 2f, y - h / 2f),
                        size = Size(w, h * (0.35f + 0.65f * kotlin.math.abs(cos(t * 6f + p.sway)))),
                    )
                }
            }
        }
    }
}

private const val DURATION = 2.6f
