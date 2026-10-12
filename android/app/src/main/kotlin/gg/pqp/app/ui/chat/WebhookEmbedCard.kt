package gg.pqp.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.IntrinsicSize
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.platform.LocalUriHandler
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import gg.pqp.app.core.WebhookEmbed
import gg.pqp.app.ui.theme.Spacing

/**
 * One embed a webhook sent (Discord's shape): the coloured edge, the title as
 * the link, the description, the fields, the footer. It is what an RSS feed's
 * post is made of, so a feed post on Android used to be a bare link where the
 * web and iOS drew the item (forum QA P20).
 *
 * Plain text throughout: the description is the sender's, and a feed never
 * needs markdown rendered to be read. Images are not drawn, the same as the
 * web's card for a webhook embed.
 */
@Composable
fun WebhookEmbedCard(embed: WebhookEmbed, modifier: Modifier = Modifier) {
    val uriHandler = LocalUriHandler.current
    val edge = embed.color?.let { embedColor(it) } ?: MaterialTheme.colorScheme.primary
    val url = embed.url?.takeIf { it.startsWith("https://") || it.startsWith("http://") }
    Row(
        modifier = modifier
            .padding(top = Spacing.xs)
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .height(IntrinsicSize.Min)
            .clip(RoundedCornerShape(8.dp))
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .then(
                if (url != null) {
                    Modifier.clickable { runCatching { uriHandler.openUri(url) } }
                } else {
                    Modifier
                },
            )
            .testTag("message.webhookEmbed"),
    ) {
        Box(
            Modifier
                .width(3.dp)
                .fillMaxHeight()
                .background(edge),
        )
        Column(
            modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.sm + 2.dp),
            verticalArrangement = Arrangement.spacedBy(Spacing.xs),
        ) {
            embed.title?.takeIf { it.isNotBlank() }?.let { title ->
                Text(
                    text = title,
                    style = MaterialTheme.typography.titleSmall,
                    color = if (url != null) MaterialTheme.colorScheme.primary else MaterialTheme.colorScheme.onSurface,
                    maxLines = 3,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            embed.description?.takeIf { it.isNotBlank() }?.let { description ->
                Text(
                    text = description,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 8,
                    overflow = TextOverflow.Ellipsis,
                )
            }
            embed.fields.filter { it.name.isNotBlank() || it.value.isNotBlank() }.forEach { field ->
                Column {
                    if (field.name.isNotBlank()) {
                        Text(
                            text = field.name,
                            style = MaterialTheme.typography.labelMedium,
                            fontWeight = FontWeight.SemiBold,
                        )
                    }
                    if (field.value.isNotBlank()) {
                        Text(
                            text = field.value,
                            style = MaterialTheme.typography.bodySmall,
                            color = MaterialTheme.colorScheme.onSurfaceVariant,
                        )
                    }
                }
            }
            embed.footer?.text?.takeIf { it.isNotBlank() }?.let { footer ->
                Text(
                    text = footer,
                    // Not labelSmall: that role is the uppercase section
                    // rule, tracked wide.
                    style = MaterialTheme.typography.labelMedium,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                    overflow = TextOverflow.Ellipsis,
                )
            }
        }
    }
}

/** A packed 24-bit RGB integer, as Discord sends it, at full opacity. */
internal fun embedColor(packed: Int): Color =
    Color(
        red = (packed shr 16) and 0xFF,
        green = (packed shr 8) and 0xFF,
        blue = packed and 0xFF,
    )
