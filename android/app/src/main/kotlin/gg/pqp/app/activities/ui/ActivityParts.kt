package gg.pqp.app.activities.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.platform.LocalConfiguration
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityEndReason
import gg.pqp.app.activities.TileReason
import gg.pqp.app.ui.theme.PqpIcons

/** The language the person reads the app in, as a tag the manifest's i18n table is keyed by (`pt-BR`, `en`, `es`). */
@Composable
internal fun activityLocale(): String {
    val locales = LocalConfiguration.current.locales
    val first = if (locales.isEmpty) null else locales.get(0)
    return first?.toLanguageTag() ?: "en"
}

/** The glyph for a manifest's icon id (`APP_ICON_IDS`); the ones without a drawing of their own are the sparkle. */
internal fun activityIcon(iconId: String): ImageVector = when (iconId) {
    "gamepad" -> PqpIcons.ActivityGamepad
    "poll" -> PqpIcons.ActivityPoll
    "music" -> PqpIcons.JamChannel
    else -> PqpIcons.Sparkles
}

/** An app's icon in a soft rounded square: the one mark every surface (strip, tile, sheet, bar) draws it in. */
@Composable
internal fun ActivityBadge(app: ActivityApp?, size: Dp = 40.dp, modifier: Modifier = Modifier, dim: Boolean = false) {
    val colors = MaterialTheme.colorScheme
    Box(
        modifier = modifier
            .size(size)
            .clip(RoundedCornerShape(size * 0.3f))
            .background(if (dim) colors.surfaceContainerHigh else colors.primary.copy(alpha = 0.16f)),
        contentAlignment = Alignment.Center,
    ) {
        Icon(
            imageVector = activityIcon(app?.icon ?: "sparkles"),
            contentDescription = null,
            tint = if (dim) colors.onSurfaceVariant else colors.primary,
            modifier = Modifier.size(size * 0.52f),
        )
    }
}

@Composable
internal fun tileReasonText(reason: TileReason): String = stringResource(
    when (reason) {
        TileReason.VoiceOnly -> R.string.activities_reason_voice_only
        TileReason.TextOnly -> R.string.activities_reason_text_only
        TileReason.OffHere -> R.string.activities_reason_off_here
        TileReason.Community -> R.string.activities_reason_community
        TileReason.Unavailable -> R.string.activities_reason_unavailable
        TileReason.NeedsManage -> R.string.activities_reason_needs_manage
        TileReason.NoPermission -> R.string.activities_reason_no_permission
    },
)

/** The one sentence a session's ending gets, in the person's words and never the raw reason. */
@Composable
internal fun endReasonText(reason: ActivityEndReason?, selfEnded: Boolean = false): String = stringResource(
    when {
        selfEnded -> R.string.activities_ended_by_host
        reason == ActivityEndReason.Host -> R.string.activities_ended_by_host
        reason == ActivityEndReason.Moderator || reason == ActivityEndReason.Operator -> R.string.activities_ended_by_moderator
        reason == ActivityEndReason.Idle -> R.string.activities_ended_idle
        reason == ActivityEndReason.HostGone -> R.string.activities_ended_host_gone
        reason == ActivityEndReason.Empty -> R.string.activities_ended_empty
        reason == ActivityEndReason.MaxDuration -> R.string.activities_ended_max_duration
        reason == ActivityEndReason.ChannelGone -> R.string.activities_ended_channel_gone
        reason == ActivityEndReason.AppDisabled || reason == ActivityEndReason.FlagOff -> R.string.activities_ended_disabled
        else -> R.string.activities_ended_plain
    },
)
