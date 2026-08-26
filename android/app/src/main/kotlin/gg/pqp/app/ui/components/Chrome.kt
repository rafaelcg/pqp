package gg.pqp.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.PaddingValues
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Button
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.HorizontalDivider
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBarColors
import androidx.compose.material3.TopAppBarDefaults
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.dp
import gg.pqp.app.R
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * Chrome, in the sense the design doc uses the word: the frame around what a
 * person came to read, rather than the reading itself.
 *
 * On this product chrome is **deeper** than content, not lighter. An app bar,
 * a bottom navigation bar and the call strip all sit on `surfaceContainerLowest`
 * with the page on `background` above them, so the page reads as a sheet laid
 * on a rail. Material's instinct is the opposite, which is why these helpers
 * exist: they are the one place the decision is made, and a screen that wants
 * an app bar gets it right by calling one function.
 */
@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun pqpTopBarColors(): TopAppBarColors = TopAppBarDefaults.topAppBarColors(
    containerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
    // The same colour when the list underneath has been scrolled. Material
    // lightens a scrolled app bar to say "there is content beneath me"; the
    // hairline below says it more quietly and does not put a second shade of
    // grey on screen.
    scrolledContainerColor = MaterialTheme.colorScheme.surfaceContainerLowest,
    titleContentColor = MaterialTheme.colorScheme.onSurface,
    navigationIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
    actionIconContentColor = MaterialTheme.colorScheme.onSurfaceVariant,
)

/**
 * The same colours for a `LargeTopAppBar`.
 *
 * An alias rather than a call to `largeTopAppBarColors`, which Material has
 * deprecated in favour of the one above: the two differ only in which defaults
 * they fill in, and every value here is given explicitly, so there is nothing
 * left for them to differ about. Kept as its own name because a screen that
 * uses the large bar should not have to know that.
 */
@Composable
fun pqpLargeTopBarColors(): TopAppBarColors = pqpTopBarColors()

/**
 * The hairline that separates chrome from content.
 *
 * One pixel of `outline`, and it is the only line in the app. Rows inside a
 * list are separated by rhythm; a rule between every row is what makes a list
 * look like a form. A rule appears only where two different *kinds* of surface
 * meet: under an app bar, above the composer.
 */
@Composable
fun ChromeDivider(modifier: Modifier = Modifier) {
    HorizontalDivider(
        modifier = modifier,
        thickness = Sizes.hairline,
        color = MaterialTheme.colorScheme.outline,
    )
}

/**
 * An uppercase section rule: the channel-list categories, the friends screen's
 * groupings, anything the web app sets in caps in a sidebar.
 *
 * Uppercased here rather than at the call site so a translated string cannot
 * arrive already shouting in one language and not the other, and so pt-BR's
 * accented capitals go through one `uppercase()` with the default locale.
 */
@Composable
fun SectionLabel(
    text: String,
    modifier: Modifier = Modifier,
    trailing: (@Composable () -> Unit)? = null,
) {
    Box(
        modifier = modifier
            .fillMaxWidth()
            .padding(
                start = Spacing.gutter,
                end = Spacing.gutter,
                top = Spacing.xl,
                bottom = Spacing.sm,
            ),
    ) {
        Text(
            text = text.uppercase(),
            style = MaterialTheme.typography.labelSmall,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
        )
        trailing?.let {
            Box(Modifier.align(Alignment.CenterEnd)) { it() }
        }
    }
}

/**
 * What a screen says when a list is legitimately empty.
 *
 * Empty states are where products usually say nothing, and saying something
 * specific is most of the difference between "broken" and "ready". The icon is
 * drawn large and muted rather than tinted, because an empty screen is not the
 * place for the loud colour: there is nothing here to act on.
 *
 * The one-argument form is kept so the existing call sites read the same; it is
 * the shape almost every screen uses.
 */
@Composable
fun EmptyState(
    text: String,
    modifier: Modifier = Modifier,
    icon: ImageVector = PqpIcons.Empty,
    title: String? = null,
    actionLabel: String? = null,
    onAction: (() -> Unit)? = null,
) {
    Column(
        modifier = modifier
            .fillMaxSize()
            .padding(Spacing.xxl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = icon,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(26.dp),
            )
        }
        Spacer(Modifier.height(Spacing.lg))
        title?.let {
            Text(
                text = it,
                style = MaterialTheme.typography.headlineSmall,
                color = MaterialTheme.colorScheme.onSurface,
                textAlign = TextAlign.Center,
            )
            Spacer(Modifier.height(Spacing.sm))
        }
        Text(
            text = text,
            style = MaterialTheme.typography.bodyMedium,
            color = MaterialTheme.colorScheme.onSurfaceVariant,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 280.dp),
        )
        if (actionLabel != null && onAction != null) {
            Spacer(Modifier.height(Spacing.xl))
            Button(onClick = onAction, contentPadding = PaddingValues(horizontal = Spacing.xl, vertical = Spacing.md)) {
                Text(actionLabel)
            }
        }
    }
}

/**
 * The screen a person lands on when the session could not be established: a
 * server that did not answer, or an account this instance has blocked.
 *
 * Moved out of `ServersScreen.kt` in the design pass, along with `EmptyState`.
 * Both were being used by four screens from a file about servers, which is how
 * two agents end up editing one file to restyle two different things.
 */
@Composable
fun FailedScreen(reason: String, onRetry: (() -> Unit)?) {
    Column(
        modifier = Modifier
            .fillMaxSize()
            .padding(Spacing.xxl),
        verticalArrangement = Arrangement.Center,
        horizontalAlignment = Alignment.CenterHorizontally,
    ) {
        Box(
            modifier = Modifier
                .size(64.dp)
                .clip(CircleShape)
                .background(MaterialTheme.colorScheme.surfaceContainer),
            contentAlignment = Alignment.Center,
        ) {
            Icon(
                imageVector = PqpIcons.Warning,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.error,
                modifier = Modifier.size(26.dp),
            )
        }
        Spacer(Modifier.height(Spacing.lg))
        Text(
            text = reason.ifBlank { stringResource(R.string.error_network) },
            style = MaterialTheme.typography.bodyLarge,
            color = MaterialTheme.colorScheme.onSurface,
            textAlign = TextAlign.Center,
            modifier = Modifier.widthIn(max = 300.dp),
        )
        if (onRetry != null) {
            Spacer(Modifier.height(Spacing.lg))
            TextButton(onClick = onRetry) { Text(stringResource(R.string.connection_retry)) }
        }
    }
}
