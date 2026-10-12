package gg.pqp.app.nudge.ui

import android.content.Context
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.provider.Settings
import androidx.compose.animation.core.Animatable
import androidx.compose.animation.core.keyframes
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.material3.Icon
import androidx.compose.material3.IconButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableLongStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.LiveRegionMode
import androidx.compose.ui.semantics.liveRegion
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import gg.pqp.app.R
import gg.pqp.app.nudge.NudgeRefusal
import gg.pqp.app.nudge.NudgeRefusalReason
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.delay

/**
 * The app bar's bolt. Rests for the cooldown after a send, and says so in its
 * label ("Chamar a atenção de novo em 7 s") rather than greying out without a
 * reason.
 */
@Composable
fun NudgeButton(holdUntilMs: Long, onNudge: () -> Unit) {
    var now by remember { mutableLongStateOf(android.os.SystemClock.elapsedRealtime()) }
    LaunchedEffect(holdUntilMs) {
        now = android.os.SystemClock.elapsedRealtime()
        while (now < holdUntilMs) {
            delay(250)
            now = android.os.SystemClock.elapsedRealtime()
        }
    }
    val resting = now < holdUntilMs
    val label = if (resting) {
        stringResource(R.string.nudge_action_cooldown, ((holdUntilMs - now + 999) / 1000).toInt())
    } else {
        stringResource(R.string.nudge_action)
    }
    IconButton(
        onClick = onNudge,
        enabled = !resting,
        modifier = Modifier.testTag("chat.nudge"),
    ) {
        Icon(
            imageVector = PqpIcons.Nudge,
            contentDescription = label,
            modifier = Modifier.size(Sizes.iconAction),
        )
    }
}

/**
 * A nudge in the transcript: a centred line, not a bubble, because nobody
 * typed it. "Tu chamou a atenção de Gabi." or "Gabi chamou tua atenção!".
 */
@Composable
fun NudgeLine(authorName: String, mine: Boolean, otherName: String) {
    Row(
        horizontalArrangement = Arrangement.Center,
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .testTag("chat.nudgeLine"),
    ) {
        Icon(
            PqpIcons.Nudge,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.primary,
            modifier = Modifier.size(16.dp),
        )
        Text(
            text = if (mine) {
                stringResource(R.string.nudge_sent, otherName)
            } else {
                stringResource(R.string.nudge_received, authorName)
            },
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.padding(start = Spacing.xs),
        )
    }
}

/** Why a nudge did not land, in one short line above the composer. */
@Composable
fun NudgeRefusalLine(refusal: NudgeRefusal?, otherName: String, onExpired: () -> Unit) {
    if (refusal == null) return
    LaunchedEffect(refusal) {
        delay(REFUSAL_SHOWN_MS)
        onExpired()
    }
    val text = when (refusal.reason) {
        NudgeRefusalReason.Cooldown -> stringResource(R.string.nudge_refused_cooldown)
        NudgeRefusalReason.Unanswered -> stringResource(R.string.nudge_refused_unanswered, otherName)
        NudgeRefusalReason.Busy -> stringResource(R.string.nudge_refused_busy, otherName)
        NudgeRefusalReason.SelfOff -> stringResource(R.string.nudge_refused_self_off)
        NudgeRefusalReason.Unavailable -> stringResource(R.string.nudge_refused_unavailable)
    }
    Text(
        text = text,
        style = MaterialTheme.typography.bodySmall,
        color = MaterialTheme.colorScheme.onSurfaceVariant,
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.xs)
            .semantics { liveRegion = LiveRegionMode.Polite }
            .testTag("chat.nudgeRefused"),
    )
}

/**
 * The shake: a few quick swings either side, about half a second. Compose
 * already scales it by the animator duration scale; at zero ("remove
 * animations") it is skipped outright rather than run as one jump.
 */
suspend fun Animatable<Float, *>.shake(context: Context) {
    if (!animationsOn(context)) return
    animateTo(
        targetValue = 0f,
        animationSpec = keyframes {
            durationMillis = 480
            0f at 0
            -18f at 50
            18f at 110
            -14f at 170
            14f at 230
            -8f at 300
            8f at 370
            0f at 480
        },
    )
}

private fun animationsOn(context: Context): Boolean =
    Settings.Global.getFloat(context.contentResolver, Settings.Global.ANIMATOR_DURATION_SCALE, 1f) > 0f

/**
 * A short double buzz. Not a ring: a nudge is a poke, and it obeys the
 * phone's own vibration settings like any app haptic.
 */
fun buzz(context: Context) {
    val vibrator = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
        (context.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as? VibratorManager)?.defaultVibrator
    } else {
        @Suppress("DEPRECATION")
        context.getSystemService(Context.VIBRATOR_SERVICE) as? Vibrator
    }
    if (vibrator?.hasVibrator() != true) return
    runCatching { vibrator.vibrate(VibrationEffect.createWaveform(longArrayOf(0, 90, 70, 140), -1)) }
}

/**
 * "Deixar me chamarem a atenção": the two-way opt-out, in the account screen.
 * Drawn only while the `nudge` flag is on. Optimistic, and put back if the
 * server refuses the write.
 */
@Composable
fun NudgeSettingsRow(session: gg.pqp.app.core.SessionStore, modifier: Modifier = Modifier) {
    var enabled by remember { androidx.compose.runtime.mutableStateOf(false) }
    LaunchedEffect(session) {
        gg.pqp.app.nudge.FunConfigs.forget()
        enabled = gg.pqp.app.nudge.FunConfigs.resolve(session.api).nudge
    }
    if (!enabled) return
    val phase by session.phase.collectAsStateWithLifecycle()
    // One source: the session. The switch shows what the session says, and a
    // tap moves the session first (see `NudgePreference`), so a remount or any
    // other screen never reads a value from before the change.
    val allowed = (phase as? gg.pqp.app.core.SessionPhase.Ready)?.me?.preferences?.allowNudges != false
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = modifier
            .fillMaxWidth()
            .testTag("you.allowNudges"),
    ) {
        androidx.compose.foundation.layout.Column(Modifier.weight(1f)) {
            Text(
                text = stringResource(R.string.nudge_allow),
                style = MaterialTheme.typography.titleMedium,
            )
            Text(
                text = stringResource(R.string.nudge_allow_hint),
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
        androidx.compose.foundation.layout.Spacer(Modifier.size(12.dp))
        androidx.compose.material3.Switch(
            checked = allowed,
            onCheckedChange = { wanted -> gg.pqp.app.nudge.NudgePreference.change(session, wanted) },
        )
    }
}

private const val REFUSAL_SHOWN_MS = 6_000L
