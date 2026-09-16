package gg.pqp.app.ui.chat

import androidx.compose.foundation.background
import androidx.compose.foundation.horizontalScroll
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxHeight
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.rememberScrollState
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.text.AnnotatedString
import androidx.compose.ui.text.LinkAnnotation
import androidx.compose.ui.text.SpanStyle
import androidx.compose.ui.text.TextLinkStyles
import androidx.compose.ui.text.buildAnnotatedString
import androidx.compose.ui.text.font.FontFamily
import androidx.compose.ui.text.font.FontStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextDecoration
import androidx.compose.ui.text.withLink
import androidx.compose.ui.text.withStyle
import androidx.compose.ui.unit.dp
import gg.pqp.app.ui.theme.Spacing

/**
 * A message body, drawn the way the web bubble draws it.
 *
 * Bold, italic, strikethrough, inline code, fenced code, quotes, links and
 * mention chips. Parsing is [ChatMarkdown] and lives apart from Compose, so
 * the grammar is pinned by a JVM test rather than by a screenshot.
 *
 * [selfUsername] is the reader's own `username`, not their display name: the
 * wire format of a mention is `@username`, and highlighting a mention of
 * somebody else as though it named you is worse than not highlighting at all.
 *
 * `editedAt` rides along as the last run of the last paragraph rather than as
 * a row of its own, which is what keeps the mark wrapping with the sentence.
 */
@Composable
fun MessageBody(
    body: String,
    editedMark: String? = null,
    selfUsername: String? = null,
    modifier: Modifier = Modifier,
) {
    val blocks = remember(body) { ChatMarkdown.parse(body) }

    Column(modifier) {
        blocks.forEachIndexed { index, block ->
            if (index > 0) Spacer(Modifier.height(Spacing.xs))
            val last = index == blocks.lastIndex
            when (block) {
                is ChatBlock.Paragraph -> Text(
                    text = annotate(block.spans, selfUsername, if (last) editedMark else null),
                    style = MaterialTheme.typography.bodyLarge,
                )

                is ChatBlock.Quote -> Row(Modifier.height(androidx.compose.foundation.layout.IntrinsicSize.Min)) {
                    Box(
                        Modifier
                            .width(2.dp)
                            .fillMaxHeight()
                            .background(MaterialTheme.colorScheme.outline),
                    )
                    Spacer(Modifier.width(Spacing.sm))
                    Text(
                        text = annotate(block.spans, selfUsername, if (last) editedMark else null),
                        style = MaterialTheme.typography.bodyLarge,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }

                is ChatBlock.Code -> Box(
                    Modifier
                        .fillMaxWidth()
                        .clip(MaterialTheme.shapes.small)
                        .background(MaterialTheme.colorScheme.surfaceContainerHigh)
                        .padding(Spacing.sm),
                ) {
                    // A snippet scrolls sideways rather than wrapping: a
                    // wrapped line of code is a line of code that lies about
                    // where it ends.
                    Text(
                        text = block.text,
                        style = MaterialTheme.typography.bodyMedium.copy(fontFamily = FontFamily.Monospace),
                        softWrap = false,
                        modifier = Modifier.horizontalScroll(rememberScrollState()),
                    )
                }
            }
        }

        // A body that is only attachments still has to carry the mark.
        if (blocks.isEmpty() && editedMark != null) {
            Text(
                text = editedMark,
                style = MaterialTheme.typography.labelMedium,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
        }
    }
}

@Composable
private fun annotate(
    spans: List<ChatSpan>,
    selfUsername: String?,
    editedMark: String?,
): AnnotatedString {
    val scheme = MaterialTheme.colorScheme
    val me = selfUsername?.lowercase()
    val linkStyles = TextLinkStyles(
        style = SpanStyle(color = scheme.primary, textDecoration = TextDecoration.Underline),
    )

    // Web's `.pqp-mention` gives every `@name` a tinted, accent-coloured pill
    // (`client/src/index.css`); this used to colour only a mention of the
    // reader and leave everybody else's name as a plain grey run, which is
    // why a busy channel read as flat here and not there. Every mention now
    // gets the pill; the two web reserves for louder cases are kept, just
    // applied to the right thing: a mention naming the reader (or
    // `@everyone` / `@here`, which always does) gets the stronger tint web
    // calls `.pqp-mention-self`, and a mass mention alone gets the bold
    // weight web calls `.pqp-mention-mass`.
    val mentionTint = scheme.primary

    return buildAnnotatedString {
        spans.forEach { span ->
            val isMassMention = span.mention?.let {
                it.equals("everyone", true) || it.equals("here", true)
            } == true
            val mentionsMe = span.mention != null && (span.mention.lowercase() == me || isMassMention)
            val style = SpanStyle(
                fontWeight = if (span.bold || isMassMention) FontWeight.SemiBold else null,
                fontStyle = if (span.italic) FontStyle.Italic else null,
                textDecoration = if (span.strike) TextDecoration.LineThrough else null,
                fontFamily = if (span.code) FontFamily.Monospace else null,
                color = when {
                    span.mention != null -> mentionTint
                    span.code -> scheme.onSurfaceVariant
                    else -> androidx.compose.ui.graphics.Color.Unspecified
                },
                background = when {
                    span.code -> scheme.surfaceContainerHigh
                    span.mention != null -> mentionTint.copy(alpha = if (mentionsMe) 0.26f else 0.12f)
                    else -> androidx.compose.ui.graphics.Color.Unspecified
                },
            )

            if (span.link != null) {
                withLink(LinkAnnotation.Url(span.link, linkStyles)) {
                    withStyle(style) { append(span.text) }
                }
            } else {
                withStyle(style) { append(span.text) }
            }
        }

        if (editedMark != null) {
            append(" ")
            withStyle(
                SpanStyle(
                    color = scheme.onSurfaceVariant,
                    fontSize = MaterialTheme.typography.labelMedium.fontSize,
                ),
            ) { append(editedMark) }
        }
    }
}
