package gg.pqp.app.activities.ui

import androidx.compose.animation.AnimatedContent
import androidx.compose.animation.AnimatedVisibility
import androidx.compose.animation.core.spring
import androidx.compose.animation.expandVertically
import androidx.compose.animation.fadeIn
import androidx.compose.animation.fadeOut
import androidx.compose.animation.shrinkVertically
import androidx.compose.animation.slideInVertically
import androidx.compose.animation.slideOutVertically
import androidx.compose.animation.togetherWith
import androidx.compose.foundation.BorderStroke
import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.FilledTonalButton
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Surface
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.hapticfeedback.HapticFeedbackType
import androidx.compose.ui.platform.LocalHapticFeedback
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.pluralStringResource
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.activities.ActivityApp
import gg.pqp.app.activities.ActivityRules
import gg.pqp.app.activities.ActivityRules.StripAction
import gg.pqp.app.activities.ActivityRules.StripFace
import gg.pqp.app.activities.ActivitySession
import gg.pqp.app.ui.theme.Spacing

/**
 * The strip above a channel that has a live activity: the one place a person who
 * is not inside learns it exists, who started it and how many are in, and the
 * one place they take part from (the strip of `app-session-strip.tsx`).
 *
 * It is for everybody who can see the channel (D13), stays while the session
 * exists, and says what the one button does for THIS person: Entrar where a
 * phone can play, Assistir where it can only look, Voltar pra ela when they are
 * already inside. It appears on a spring and the count changes on a short
 * slide, both of which the system's animator scale turns into a cut.
 */
@Composable
fun ActivityStrip(
    session: ActivitySession?,
    app: ActivityApp?,
    startedByName: String?,
    viewerId: String?,
    onAction: (StripAction) -> Unit,
    modifier: Modifier = Modifier,
) {
    val locale = activityLocale()
    // Keep the last session while the strip animates out, so it does not collapse on an empty card.
    val shown = remember { arrayOfNulls<ActivitySession>(1) }
    if (session != null) shown[0] = session
    AnimatedVisibility(
        visible = session != null,
        enter = fadeIn(spring(stiffness = 500f)) + expandVertically(spring(dampingRatio = 0.85f, stiffness = 420f)),
        exit = fadeOut(spring(stiffness = 700f)) + shrinkVertically(spring(stiffness = 700f)),
        modifier = modifier,
    ) {
        val live = session ?: shown[0] ?: return@AnimatedVisibility
        StripBody(live, app, startedByName, ActivityRules.stripFace(live, app, viewerId), locale, onAction)
    }
}

@Composable
private fun StripBody(
    session: ActivitySession,
    app: ActivityApp?,
    startedByName: String?,
    face: StripFace,
    locale: String,
    onAction: (StripAction) -> Unit,
) {
    val colors = MaterialTheme.colorScheme
    val haptics = LocalHapticFeedback.current
    val name = app?.displayName(locale) ?: session.appId
    val action = ActivityRules.stripAction(app, face)
    val description = stringResource(R.string.activities_strip_description, name)
    Surface(
        shape = MaterialTheme.shapes.medium,
        color = colors.surfaceContainer,
        border = BorderStroke(1.dp, colors.outline),
        modifier = Modifier
            .fillMaxWidth()
            .padding(horizontal = Spacing.gutter, vertical = Spacing.sm)
            .semantics { contentDescription = description }
            .testTag("activities.strip"),
    ) {
        Row(
            modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.md),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            ActivityBadge(app)
            Spacer(Modifier.width(Spacing.md))
            Column(Modifier.weight(1f)) {
                Row(verticalAlignment = Alignment.CenterVertically) {
                    Text(
                        text = name,
                        style = MaterialTheme.typography.titleSmall,
                        fontWeight = FontWeight.SemiBold,
                        color = colors.onSurface,
                        maxLines = 1,
                        overflow = TextOverflow.Ellipsis,
                        modifier = Modifier.weight(1f, fill = false),
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    // The live dot. Static on purpose: a pulse is motion nobody asked for in a list of chats.
                    androidx.compose.foundation.layout.Box(
                        Modifier.size(7.dp).clip(CircleShape).background(colors.primary),
                    )
                }
                val who = startedByName?.let { stringResource(R.string.activities_strip_started_by, it) }
                    ?: stringResource(R.string.activities_strip_started_by_unknown)
                AnimatedContent(
                    targetState = session.players to session.spectators,
                    transitionSpec = {
                        (slideInVertically(spring(stiffness = 600f)) { it / 2 } + fadeIn()) togetherWith
                            (slideOutVertically(spring(stiffness = 600f)) { -it / 2 } + fadeOut())
                    },
                    label = "activity-count",
                ) { (players, watching) ->
                    val count = when {
                        players == 0 && watching == 0 -> stringResource(R.string.activities_strip_nobody)
                        watching > 0 -> pluralStringResource(R.plurals.activities_strip_inside, players, players) + ", " +
                            pluralStringResource(R.plurals.activities_strip_watching, watching, watching)
                        else -> pluralStringResource(R.plurals.activities_strip_inside, players, players)
                    }
                    Text(
                        text = "$who · $count",
                        style = MaterialTheme.typography.bodySmall,
                        color = colors.onSurfaceVariant,
                        maxLines = 2,
                        overflow = TextOverflow.Ellipsis,
                    )
                }
            }
            if (action != StripAction.None) {
                Spacer(Modifier.width(Spacing.md))
                ActionButton(action) {
                    haptics.performHapticFeedback(HapticFeedbackType.ContextClick)
                    onAction(action)
                }
            }
        }
    }
}

@Composable
private fun ActionButton(action: StripAction, onClick: () -> Unit) {
    val padding = PaddingValues(horizontal = Spacing.lg, vertical = 0.dp)
    when (action) {
        StripAction.Join -> Button(onClick, contentPadding = padding, modifier = Modifier.testTag("activities.strip.join")) {
            Text(stringResource(R.string.activities_join))
        }

        StripAction.Watch -> FilledTonalButton(onClick, contentPadding = padding, modifier = Modifier.testTag("activities.strip.watch")) {
            Text(stringResource(R.string.activities_watch))
        }

        StripAction.Back -> FilledTonalButton(onClick, contentPadding = padding, modifier = Modifier.testTag("activities.strip.back")) {
            Text(stringResource(R.string.activities_back_to_app))
        }

        StripAction.Full -> Text(
            text = stringResource(R.string.activities_strip_full),
            style = MaterialTheme.typography.labelLarge,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )

        StripAction.ComputerOnly -> Text(
            text = stringResource(R.string.activities_strip_computer_only),
            style = MaterialTheme.typography.labelMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            maxLines = 2,
            modifier = Modifier.width(72.dp),
        )

        StripAction.None -> Unit
    }
}
