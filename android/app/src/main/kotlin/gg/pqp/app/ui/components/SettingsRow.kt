package gg.pqp.app.ui.components

import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.text.style.TextOverflow
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * A row on a settings surface: a glyph, a label, and either a value or a way in.
 *
 * It exists so that "you", "your data" and anything else that grows a preference
 * later are the same row rather than three stacks of buttons that happen to be
 * near each other. The old shape was a column of `OutlinedButton`s and
 * `TextButton`s at full width, which is why the account screen read as a form:
 * a button says "press me to do something now", and most of what is on that
 * screen is a fact or a place to go.
 *
 * Height is a **minimum**, not a fixed size, so a reader who has turned their
 * font up gets a taller row instead of a clipped one. The glyph sits in the
 * 20dp inline box, muted, so it labels the row rather than competing with it,
 * and there is no divider: rows are grouped by a `SectionLabel` and separated
 * by rhythm.
 */
@Composable
fun SettingsRow(
    icon: ImageVector,
    label: String,
    modifier: Modifier = Modifier,
    value: String? = null,
    /** Tints both the glyph and the label. `error` is how a row says it is destructive. */
    contentColor: Color = Color.Unspecified,
    navigates: Boolean = false,
    /** A row in flight: still readable, still saying what it is, not pressable again. */
    enabled: Boolean = true,
    onClick: (() -> Unit)? = null,
) {
    val dim = if (enabled) 1f else DISABLED_ALPHA
    val resolved = if (contentColor == Color.Unspecified) {
        MaterialTheme.colorScheme.onSurface
    } else {
        contentColor
    }.copy(alpha = dim)
    val glyph = if (contentColor == Color.Unspecified) {
        MaterialTheme.colorScheme.onSurfaceVariant
    } else {
        contentColor
    }.copy(alpha = dim)

    Row(
        modifier = modifier
            .fillMaxWidth()
            .then(
                if (onClick != null) {
                    Modifier.clickable(enabled = enabled, onClick = onClick)
                } else {
                    Modifier
                },
            )
            .heightIn(min = Sizes.personRow)
            .padding(horizontal = Spacing.gutter, vertical = Spacing.md),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = icon,
            contentDescription = null,
            tint = glyph,
            modifier = Modifier.size(Sizes.iconInline),
        )
        Spacer(Modifier.width(Spacing.md))
        Text(
            text = label,
            style = MaterialTheme.typography.bodyLarge,
            color = resolved,
            modifier = Modifier.weight(1f),
        )
        if (value != null) {
            Spacer(Modifier.width(Spacing.md))
            Text(
                text = value,
                style = MaterialTheme.typography.bodyMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant.copy(alpha = dim),
                textAlign = TextAlign.End,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
        }
        if (navigates) {
            Spacer(Modifier.width(Spacing.sm))
            Icon(
                imageVector = PqpIcons.Forward,
                contentDescription = null,
                tint = MaterialTheme.colorScheme.onSurfaceVariant,
                modifier = Modifier.size(Sizes.iconInline),
            )
        }
    }
}

/** Material's own disabled content alpha, so a dimmed row matches a dimmed button. */
private const val DISABLED_ALPHA = 0.38f
