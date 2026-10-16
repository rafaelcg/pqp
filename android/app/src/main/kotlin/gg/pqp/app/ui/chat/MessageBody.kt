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
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.platform.LocalContext
import androidx.compose.foundation.text.InlineTextContent
import androidx.compose.foundation.text.appendInlineContent
import androidx.compose.ui.text.Placeholder
import androidx.compose.ui.text.PlaceholderVerticalAlign
import androidx.compose.ui.unit.em
import androidx.lifecycle.compose.collectAsStateWithLifecycle
import coil3.compose.AsyncImage
import gg.pqp.app.PqpApplication
import gg.pqp.app.bau.BauShare
import gg.pqp.app.core.Backend
import gg.pqp.app.core.ServerEmoji
import gg.pqp.app.ui.theme.Spacing
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.flow.map

/**
 * The server whose custom emoji the messages below may show (`CustomEmojiProvider` on the web). Null
 * in a conversation, where every `<:name:id>` reads as `:name:`: an emoji belongs to its server.
 */
val LocalEmojiServerId = staticCompositionLocalOf<String?> { null }

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
    val openBau = LocalOpenBauPost.current
    val emoji = rememberServerEmoji(blocks)

    Column(modifier) {
        blocks.forEachIndexed { index, block ->
            if (index > 0) Spacer(Modifier.height(Spacing.xs))
            val last = index == blocks.lastIndex
            when (block) {
                is ChatBlock.Paragraph -> Text(
                    text = annotate(block.spans, selfUsername, if (last) editedMark else null, openBau, emoji),
                    inlineContent = emojiContent(block.spans, emoji),
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
                        text = annotate(block.spans, selfUsername, if (last) editedMark else null, openBau, emoji),
                        inlineContent = emojiContent(block.spans, emoji),
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

/**
 * The emoji of the server these messages are in, by id, or empty (a conversation, a server not read yet,
 * a read that failed: every token then draws as `:name:`). Reads the server's list the first time one is
 * shown, and asks again, at most every 30 s, when a message names an id the list does not hold (somebody
 * added one since), which is what keeps other members current without a socket frame.
 */
@Composable
private fun rememberServerEmoji(blocks: List<ChatBlock>): Map<String, ServerEmoji> {
    val serverId = LocalEmojiServerId.current
    val store = (LocalContext.current.applicationContext as? PqpApplication)?.serverEmoji
    val wanted = remember(blocks) { emojiIdsIn(blocks) }
    if (serverId == null || store == null || wanted.isEmpty()) return emptyMap()

    LaunchedEffect(store, serverId) { store.load(serverId) }
    val list by remember(store, serverId) {
        store.lists.map { it[serverId] }.distinctUntilChanged()
    }.collectAsStateWithLifecycle(null)
    val byId = remember(list) { list?.associateBy { it.id }.orEmpty() }
    LaunchedEffect(byId, wanted) {
        if (list != null && wanted.any { it !in byId }) store.noteUnknown(serverId)
    }
    return byId
}

private fun emojiIdsIn(blocks: List<ChatBlock>): Set<String> {
    val ids = HashSet<String>()
    for (block in blocks) {
        val spans = when (block) {
            is ChatBlock.Paragraph -> block.spans
            is ChatBlock.Quote -> block.spans
            is ChatBlock.Code -> continue
        }
        spans.forEach { span -> span.emoji?.let { ids += it.id } }
    }
    return ids
}

private fun inlineKey(id: String) = "emoji:$id"

/** One inline picture per distinct emoji in [spans] that the server has, sized to the line like the web's 1.375em. */
@Composable
private fun emojiContent(spans: List<ChatSpan>, emoji: Map<String, ServerEmoji>): Map<String, InlineTextContent> {
    if (emoji.isEmpty()) return emptyMap()
    return remember(spans, emoji) {
        val out = LinkedHashMap<String, InlineTextContent>()
        for (span in spans) {
            val ref = span.emoji ?: continue
            val known = emoji[ref.id] ?: continue
            val key = inlineKey(ref.id)
            if (key in out) continue
            val url = Backend.absolute(known.url) ?: continue
            out[key] = InlineTextContent(
                Placeholder(width = 1.375.em, height = 1.375.em, placeholderVerticalAlign = PlaceholderVerticalAlign.TextCenter),
            ) { alt ->
                AsyncImage(model = url, contentDescription = alt, modifier = Modifier.fillMaxSize())
            }
        }
        out
    }
}

@Composable
private fun annotate(
    spans: List<ChatSpan>,
    selfUsername: String?,
    editedMark: String?,
    openBau: (BauPostTarget) -> Unit,
    emoji: Map<String, ServerEmoji>,
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
            // A custom emoji the server has is a picture in the text; one it does not have is `:name:`, as typed.
            val picture = span.emoji?.takeIf { it.id in emoji && Backend.absolute(emoji.getValue(it.id).url) != null }
            if (picture != null) {
                appendInlineContent(inlineKey(picture.id), span.text)
                return@forEach
            }
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
                // A same-instance Baú address opens in the app, not the browser.
                // Everything else keeps the platform's default link handling.
                val bau = BauShare.refOfUrl(span.link)
                val annotation = if (bau != null) {
                    LinkAnnotation.Url(span.link, linkStyles) { openBau(BauPostTarget(bau)) }
                } else {
                    LinkAnnotation.Url(span.link, linkStyles)
                }
                withLink(annotation) {
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
