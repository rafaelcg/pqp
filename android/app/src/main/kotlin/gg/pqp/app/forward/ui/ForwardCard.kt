package gg.pqp.app.forward.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.widthIn
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.compose.runtime.staticCompositionLocalOf
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.vector.ImageVector
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.semantics.Role
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.SubcomposeAsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.Backend
import gg.pqp.app.forward.ForwardCardModel
import gg.pqp.app.forward.ForwardCards
import gg.pqp.app.forward.ForwardGlyph
import gg.pqp.app.forward.ForwardOrigin
import gg.pqp.app.forward.MessageForward
import gg.pqp.app.ui.components.Avatar
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/** What a tap on a forward card does. Provided once, above the nav graph. */
val LocalOpenForward = staticCompositionLocalOf<(MessageForward) -> Unit> { {} }

private val THUMB = 72.dp

/**
 * A forwarded Baú post or message, as a compact card under the forwarder's own
 * words: the source server's icon and "Encaminhado de <server> · Baú" (or
 * "· #canal"), the title, a three-line excerpt, a thumbnail when the snapshot
 * has one, and a tap that opens the source.
 *
 * Plain text throughout: the snapshot is never re-resolved, so a name in it is
 * not a mention and nothing here is a link. Twin of the web's and iOS's card.
 */
@Composable
fun ForwardCard(
    forward: MessageForward,
    modifier: Modifier = Modifier,
    onOpen: () -> Unit = LocalOpenForward.current.let { open -> { open(forward) } },
) {
    val model = remember(forward) { ForwardCards.model(forward) }
    ForwardCardContent(model, onOpen, modifier)
}

@Composable
fun ForwardCardContent(
    model: ForwardCardModel,
    onOpen: () -> Unit,
    modifier: Modifier = Modifier,
) {
    val colors = MaterialTheme.colorScheme
    val shape = RoundedCornerShape(12.dp)
    val header = when (val origin = model.origin) {
        ForwardOrigin.Bau -> stringResource(R.string.forward_card_from_bau, model.serverName)
        is ForwardOrigin.Channel -> if (origin.name.isEmpty()) {
            stringResource(R.string.forward_card_from_server, model.serverName)
        } else {
            stringResource(R.string.forward_card_from_channel, model.serverName, origin.name)
        }
    }
    val summary = model.spokenSummary()
    val a11y = if (summary.isEmpty()) {
        stringResource(R.string.forward_card_aria_empty, header)
    } else {
        stringResource(R.string.forward_card_aria, header, summary)
    }

    Column(
        modifier = modifier
            .widthIn(max = 420.dp)
            .fillMaxWidth()
            .clip(shape)
            .background(colors.surfaceContainer)
            .border(Sizes.hairline, colors.outline, shape)
            .clickable(role = Role.Button, onClick = onOpen)
            .semantics { contentDescription = a11y }
            .testTag("forward.card")
            .padding(Spacing.md),
        verticalArrangement = Arrangement.spacedBy(Spacing.sm),
    ) {
        Row(verticalAlignment = Alignment.CenterVertically) {
            Icon(
                imageVector = PqpIcons.ForwardMessage,
                contentDescription = null,
                tint = colors.onSurfaceVariant,
                modifier = Modifier.size(14.dp),
            )
            Spacer(Modifier.size(Spacing.xs + 2.dp))
            Avatar(
                name = model.serverName,
                url = model.serverIconUrl,
                size = 20.dp,
                cornerRadius = 6.dp,
            )
            Spacer(Modifier.size(Spacing.sm))
            Text(
                text = header,
                style = MaterialTheme.typography.labelMedium,
                color = colors.onSurfaceVariant,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false).testTag("forward.card.header"),
            )
            if (model.restricted) {
                Spacer(Modifier.size(Spacing.sm))
                Icon(
                    imageVector = PqpIcons.PrivateChannel,
                    contentDescription = stringResource(R.string.forward_card_restricted),
                    tint = colors.onSurfaceVariant,
                    modifier = Modifier.size(14.dp).testTag("forward.card.restricted"),
                )
            }
        }

        if (model.isEmpty) {
            Text(
                text = stringResource(R.string.forward_card_empty),
                style = MaterialTheme.typography.bodyMedium,
                color = colors.onSurfaceVariant,
                modifier = Modifier.testTag("forward.card.empty"),
            )
        } else {
            Row(horizontalArrangement = Arrangement.spacedBy(Spacing.md)) {
                Column(
                    modifier = Modifier.weight(1f),
                    verticalArrangement = Arrangement.spacedBy(2.dp),
                ) {
                    model.heading?.let { heading ->
                        Text(
                            text = heading,
                            style = MaterialTheme.typography.titleSmall,
                            fontWeight = FontWeight.Bold,
                            maxLines = 2,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.testTag("forward.card.heading"),
                        )
                    }
                    if (model.excerpt.isNotEmpty()) {
                        Text(
                            text = model.excerpt,
                            style = MaterialTheme.typography.bodyMedium,
                            color = colors.onSurfaceVariant,
                            maxLines = 3,
                            overflow = TextOverflow.Ellipsis,
                            modifier = Modifier.testTag("forward.card.excerpt"),
                        )
                    }
                }
                if (model.thumbUrl != null || model.glyph != null) {
                    Thumb(model)
                }
            }
        }
    }
}

/** The picture, or a plate with a glyph for what the source had when no picture was stored. */
@Composable
private fun Thumb(model: ForwardCardModel) {
    val colors = MaterialTheme.colorScheme
    val plateShape = RoundedCornerShape(8.dp)
    val glyph = model.glyph
    Box(
        modifier = Modifier
            .size(THUMB)
            .clip(plateShape)
            .background(colors.surfaceContainerHigh)
            .testTag("forward.card.thumb"),
        contentAlignment = Alignment.Center,
    ) {
        val plate: @Composable () -> Unit = {
            if (glyph != null) {
                Icon(
                    imageVector = glyphIcon(glyph),
                    contentDescription = null,
                    tint = colors.onSurfaceVariant,
                    modifier = Modifier.size(24.dp),
                )
            }
        }
        val url = Backend.absolute(model.thumbUrl)
        if (url != null) {
            SubcomposeAsyncImage(
                model = url,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(THUMB),
                // Loading and failure both fall back to the plate, so a card
                // never shows a broken-image icon where a poster should be.
                loading = { Box(Modifier.size(THUMB), Alignment.Center) { plate() } },
                error = { Box(Modifier.size(THUMB), Alignment.Center) { plate() } },
            )
            if (glyph == ForwardGlyph.Youtube || glyph == ForwardGlyph.Video) {
                Icon(
                    imageVector = PqpIcons.Play,
                    contentDescription = null,
                    tint = colors.onPrimary,
                    modifier = Modifier
                        .size(28.dp)
                        .background(colors.primary, androidx.compose.foundation.shape.CircleShape)
                        .padding(6.dp),
                )
            }
        } else {
            plate()
        }
    }
}

private fun glyphIcon(glyph: ForwardGlyph): ImageVector = when (glyph) {
    ForwardGlyph.Image -> PqpIcons.Image
    ForwardGlyph.Video -> PqpIcons.Video
    ForwardGlyph.Youtube -> PqpIcons.Play
    ForwardGlyph.Embed -> PqpIcons.Link
}
