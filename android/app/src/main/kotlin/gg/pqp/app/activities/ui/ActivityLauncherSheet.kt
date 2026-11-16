package gg.pqp.app.activities.ui

import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.animateContentSize
import androidx.compose.animation.core.spring
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.navigationBarsPadding
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.foundation.verticalScroll
import androidx.compose.material3.CircularProgressIndicator
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.ModalBottomSheet
import androidx.compose.material3.Text
import androidx.compose.material3.rememberModalBottomSheetState
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.alpha
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.role
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.activities.ActivityRules
import gg.pqp.app.activities.ActivityRules.StartFailure
import gg.pqp.app.activities.ActivityStarter
import gg.pqp.app.activities.ActivityTile
import gg.pqp.app.ui.components.EmptyState
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Spacing

/**
 * The picker (`app-launcher.tsx` on a phone: a sheet): what can happen in this
 * channel. A tile that cannot start here stays on screen, dimmed, with its
 * reason written, never hidden, so a person learns that it exists and where it
 * works.
 *
 * One tap on a tile that can start starts it (the consent sheet comes first the
 * first time per app); the tile shows a spinner while the request is out, and
 * the sheet closes as the screen opens onto the activity. A failure is a line
 * at the foot in the server's own classes, never a raw code.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun ActivityLauncherSheet(
    tiles: List<ActivityTile>,
    state: ActivityStarter.State,
    liveByName: String?,
    onStart: (ActivityTile) -> Unit,
    onDismiss: () -> Unit,
) {
    val sheetState = rememberModalBottomSheetState(skipPartiallyExpanded = false)
    ModalBottomSheet(
        onDismissRequest = onDismiss,
        sheetState = sheetState,
        modifier = Modifier.testTag("activities.launcher"),
    ) {
        Column(
            modifier = Modifier
                .fillMaxWidth()
                .navigationBarsPadding()
                .padding(bottom = Spacing.lg)
                .animateContentSize(spring(stiffness = 500f)),
        ) {
            Text(
                text = stringResource(R.string.activities_title),
                style = MaterialTheme.typography.titleLarge,
                color = MaterialTheme.colorScheme.onSurface,
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )
            Text(
                text = stringResource(R.string.activities_launcher_subtitle),
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.padding(horizontal = Spacing.gutter),
            )
            Spacer(Modifier.height(Spacing.md))
            if (tiles.isEmpty()) {
                EmptyState(
                    icon = PqpIcons.Activities,
                    title = stringResource(R.string.activities_empty_title),
                    text = stringResource(R.string.activities_empty_body),
                    modifier = Modifier.height(260.dp),
                )
            } else {
                Column(Modifier.verticalScroll(rememberScrollState())) {
                    tiles.forEach { tile ->
                        TileRow(
                            tile = tile,
                            starting = state.starting == tile.id,
                            locked = state.starting != null,
                            onClick = { onStart(tile) },
                        )
                    }
                }
            }
            AnimatedVisibility(visible = state.failure != null) {
                val text = when (state.failure) {
                    StartFailure.SessionLive ->
                        liveByName?.let { stringResource(R.string.activities_start_live_by, it) }
                            ?: stringResource(R.string.activities_start_live)
                    StartFailure.CannotStart -> stringResource(R.string.activities_start_cannot)
                    StartFailure.Unavailable -> stringResource(R.string.activities_start_unavailable)
                    StartFailure.RateLimited -> stringResource(R.string.activities_start_rate_limited)
                    else -> stringResource(R.string.activities_start_failed)
                }
                Text(
                    text = text,
                    style = MaterialTheme.typography.bodyMedium,
                    color = MaterialTheme.colorScheme.error,
                    modifier = Modifier
                        .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
                        .testTag("activities.launcher.failure"),
                )
            }
        }
    }
}

@Composable
private fun TileRow(tile: ActivityTile, starting: Boolean, locked: Boolean, onClick: () -> Unit) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val locale = activityLocale()
    val app = tile.app
    val canStart = tile.reason == null
    val name = app.displayName(locale)
    val phoneWatches = !ActivityRules.phoneMayPlay(app)
    val sub = tile.reason?.let { tileReasonText(it) }
        ?: if (phoneWatches) stringResource(R.string.activities_phone_watch_only) else sizeText(app.players.max)
    val enabled = canStart && !locked && !tile.running
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .fillMaxWidth()
            .alpha(if (canStart || tile.running) 1f else 0.6f)
            .semantics(mergeDescendants = true) {
                role = Role.Button
                contentDescription = "$name. $sub"
            }
            .clickable(enabled = enabled) {
                haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                onClick()
            }
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md)
            .testTag("activities.tile.${app.id}"),
    ) {
        ActivityBadge(app, size = 48.dp, dim = !canStart)
        Spacer(Modifier.width(Spacing.md))
        Column(Modifier.weight(1f)) {
            Text(
                text = name,
                style = MaterialTheme.typography.titleMedium,
                fontWeight = FontWeight.SemiBold,
                color = colors.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = app.displayDescription(locale),
                style = MaterialTheme.typography.bodySmall,
                color = colors.onSurfaceVariant,
                maxLines = 2,
                overflow = TextOverflow.Ellipsis,
            )
            Text(
                text = sub,
                style = MaterialTheme.typography.labelMedium,
                color = if (canStart) colors.primary else colors.onSurfaceVariant,
                modifier = Modifier.padding(top = 2.dp),
            )
        }
        Spacer(Modifier.width(Spacing.md))
        when {
            starting -> CircularProgressIndicator(modifier = Modifier.size(22.dp), strokeWidth = 2.dp)
            tile.running -> Text(
                text = stringResource(R.string.activities_running_here),
                style = MaterialTheme.typography.labelMedium,
                color = colors.primary,
                maxLines = 2,
                modifier = Modifier.width(72.dp),
            )
            canStart -> FilledTonalButton(
                onClick = {
                    haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                    onClick()
                },
                enabled = !locked,
            ) { Text(stringResource(R.string.activities_start)) }
        }
    }
}

@Composable
private fun sizeText(max: Int): String =
    if (max <= 1) stringResource(R.string.activities_size_solo) else stringResource(R.string.activities_size_up_to, max)
