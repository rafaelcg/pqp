package gg.pqp.app.bau.ui

import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import gg.pqp.app.R
import gg.pqp.app.bau.BauChannelRefs
import gg.pqp.app.core.Channel

/**
 * A post's text with its `#channel` references drawn as links that open the
 * channel in the app. The grammar and the privacy rule are in
 * [BauChannelRefs]: a channel this person cannot see is a muted, unlinked
 * "#canal-indisponível", never a name.
 */
@Composable
fun BauChannelText(
    text: String,
    channels: List<Channel>,
    onOpenChannel: (Channel) -> Unit,
    modifier: Modifier = Modifier,
    style: TextStyle = MaterialTheme.typography.bodyLarge,
) {
    val scheme = MaterialTheme.colorScheme
    val unavailable = stringResource(R.string.bau_channel_unavailable)
    val parts = remember(text, channels) { BauChannelRefs.parse(text, channels) }
    val linkStyles = TextLinkStyles(
        style = SpanStyle(
            color = scheme.primary,
            fontWeight = FontWeight.Medium,
            background = scheme.primary.copy(alpha = 0.12f),
        ),
    )
    val annotated = remember(parts, linkStyles, unavailable, scheme, channels, onOpenChannel) {
        buildAnnotatedString {
            for (part in parts) {
                when (part) {
                    is BauChannelRefs.Part.Text -> append(part.value)
                    is BauChannelRefs.Part.Unavailable ->
                        withStyle(SpanStyle(color = scheme.onSurfaceVariant)) { append(unavailable) }
                    is BauChannelRefs.Part.Link -> {
                        val channel = channels.firstOrNull { it.id == part.id }
                        if (channel == null) {
                            append("#${part.name}")
                        } else {
                            withLink(
                                LinkAnnotation.Clickable(
                                    tag = "channel:${part.id}",
                                    styles = linkStyles,
                                    linkInteractionListener = { onOpenChannel(channel) },
                                ),
                            ) { append("#${part.name}") }
                        }
                    }
                }
            }
        }
    }
    Text(text = annotated, style = style, modifier = modifier)
}
