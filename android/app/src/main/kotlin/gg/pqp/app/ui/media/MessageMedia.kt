package gg.pqp.app.ui.media

import android.text.format.Formatter
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.clickable
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.aspectRatio
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.CircleShape
import androidx.compose.material3.Icon
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.saveable.rememberSaveable
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.LocalContext
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.core.Attachment
import gg.pqp.app.core.Backend
import gg.pqp.app.ui.theme.PqpIcons
import gg.pqp.app.ui.theme.Sizes
import gg.pqp.app.ui.theme.Spacing

/**
 * Everything a message can carry that is not words.
 *
 * Lifted out of `ChatScreen` rather than grown inside it, because "how a
 * picture is framed" and "how a transcript is laid out" are two different
 * jobs that were sharing one function, and only one of them was wrong.
 */

/**
 * The frame every inline picture loads into.
 *
 * A floor and a ceiling rather than a fixed height: the floor is what the
 * picture loads into, so the transcript does not jump when it arrives, and the
 * ceiling is what stops a tall screenshot owning the whole screen. Copied
 * verbatim from what the image branch already did, so nothing about an image
 * changes shape in this commit.
 */
private val MEDIA_MIN_HEIGHT = 120.dp
private val MEDIA_MAX_HEIGHT = 260.dp

/**
 * One attachment, drawn as whatever it is.
 *
 * Three cases, and the middle one is new. An image renders inline, and now
 * animates if it is animated, because the loader finally has a decoder for it
 * (see `PqpApplication.newImageLoader`). A **video** renders as a card that
 * has fetched nothing at all and plays in [VideoPlayerDialog] when tapped;
 * `preload="none"` is what the web calls the same rule. Anything else is a
 * chip, unchanged.
 */
@Composable
fun MessageAttachment(
    attachment: Attachment,
    api: ApiClient,
    modifier: Modifier = Modifier,
) {
    when {
        attachment.isVideo -> VideoAttachment(attachment, api, modifier)
        attachment.isImage -> ImageAttachment(attachment, modifier)
        else -> FileChip(attachment, modifier)
    }
}

@Composable
private fun ImageAttachment(attachment: Attachment, modifier: Modifier = Modifier) {
    // A picker GIF's filename is the provider's title (Klipy today, and the
    // GIPHY and Tenor rows stored before it), which is a description and
    // reads well; an uploaded file's is a filename, which does not, but it is
    // still the only thing known about it. Neither says "this moves", so an
    // animated one says so, once, in the accessible name.
    val label = if (attachment.isAnimatedImage) {
        stringResource(R.string.attachment_animated_image, attachment.filename)
    } else {
        attachment.filename
    }

    AsyncImage(
        model = Backend.absolute(attachment.url),
        contentDescription = label,
        contentScale = ContentScale.Crop,
        modifier = modifier
            .testTag("attachment-image")
            .fillMaxWidth(0.8f)
            .heightIn(min = MEDIA_MIN_HEIGHT, max = MEDIA_MAX_HEIGHT)
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(
                width = Sizes.hairline,
                color = MaterialTheme.colorScheme.outline,
                shape = MaterialTheme.shapes.medium,
            ),
    )
}

/**
 * A GIF pasted as a link rather than sent through the picker.
 *
 * Same frame as an image attachment, because to a reader it is the same thing.
 * See [GifLinks] for why a body is allowed to become a picture at all.
 */
@Composable
fun InlineGif(url: String, modifier: Modifier = Modifier) {
    AsyncImage(
        model = url,
        contentDescription = stringResource(R.string.attachment_gif),
        contentScale = ContentScale.Crop,
        modifier = modifier
            .testTag("inline-gif")
            .fillMaxWidth(0.8f)
            .heightIn(min = MEDIA_MIN_HEIGHT, max = MEDIA_MAX_HEIGHT)
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(
                width = Sizes.hairline,
                color = MaterialTheme.colorScheme.outline,
                shape = MaterialTheme.shapes.medium,
            ),
    )
}

/**
 * A video, before anybody has asked for it.
 *
 * This composable makes **no network request**. Not a thumbnail, not a range
 * request for the moov atom, nothing: a channel of clips costs its reader zero
 * bytes until a finger lands on one, which is the same promise `preload="none"`
 * makes on the web. The consequence is an honest one and worth stating: there
 * is no poster frame, because the only way to have one would be to download
 * the video in order to decide whether to download the video.
 *
 * Tapping opens a player over the whole screen rather than swapping a player
 * into this row. One player at a time is the only arrangement that is honest
 * about a scrolling list: a per-row `ExoPlayer` means a codec, a surface and a
 * buffer per visible video, all competing for the same audio focus as a voice
 * call that may be running behind this screen.
 */
@Composable
private fun VideoAttachment(
    attachment: Attachment,
    api: ApiClient,
    modifier: Modifier = Modifier,
) {
    // Saveable: a rotation while the player is open must not close it.
    var playing by rememberSaveable(attachment.id) { mutableStateOf(false) }

    val context = LocalContext.current
    val size = remember(attachment.byteSize) {
        if (attachment.byteSize > 0) {
            Formatter.formatShortFileSize(context, attachment.byteSize)
        } else {
            null
        }
    }
    val openLabel = stringResource(R.string.attachment_play_video, attachment.filename)

    Column(
        modifier = modifier
            .testTag("attachment-video")
            .fillMaxWidth(0.8f)
            .clip(MaterialTheme.shapes.medium)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(
                width = Sizes.hairline,
                color = MaterialTheme.colorScheme.outline,
                shape = MaterialTheme.shapes.medium,
            )
            // On the Column and not on the Box, so the filename row is part of
            // the target. A 44dp play button is the minimum, not the whole
            // affordance, and the row underneath reads as part of the same
            // object.
            .clickable(onClickLabel = openLabel) { playing = true },
    ) {
        Box(
            modifier = Modifier
                .fillMaxWidth()
                .aspectRatio(videoAspect(attachment))
                // Darker than the card, so the play button has something to be
                // a hole in. `surfaceContainerLowest` is the scheme's deepest
                // step and reads as "screen" rather than as "panel".
                .background(MaterialTheme.colorScheme.surfaceContainerLowest),
            contentAlignment = Alignment.Center,
        ) {
            Box(
                modifier = Modifier
                    .size(56.dp)
                    .clip(CircleShape)
                    .background(MaterialTheme.colorScheme.primary),
                contentAlignment = Alignment.Center,
            ) {
                Icon(
                    imageVector = PqpIcons.Play,
                    // The Column already carries the label. A second one here
                    // makes TalkBack announce the same video twice.
                    contentDescription = null,
                    tint = MaterialTheme.colorScheme.onPrimary,
                    modifier = Modifier
                        .size(Sizes.iconAction)
                        // Optical centring. A triangle's centre of area sits
                        // behind its centre of bounds, so a play glyph centred
                        // by its box reads as leaning left.
                        .padding(start = 3.dp),
                )
            }
        }

        Row(
            modifier = Modifier.padding(horizontal = Spacing.md, vertical = Spacing.sm),
            verticalAlignment = Alignment.CenterVertically,
        ) {
            Text(
                text = attachment.filename,
                style = MaterialTheme.typography.bodySmall,
                color = MaterialTheme.colorScheme.onSurface,
                maxLines = 1,
                overflow = TextOverflow.Ellipsis,
                modifier = Modifier.weight(1f, fill = false),
            )
            if (size != null) {
                Spacer(Modifier.width(Spacing.sm))
                Text(
                    text = size,
                    style = MaterialTheme.typography.bodySmall,
                    color = MaterialTheme.colorScheme.onSurfaceVariant,
                    maxLines = 1,
                )
            }
        }
    }

    if (playing) {
        VideoPlayerDialog(
            attachment = attachment,
            api = api,
            onDismiss = { playing = false },
        )
    }
}

/**
 * Anything with no renderer: a PDF, a text file, an audio clip.
 *
 * Deliberately not lime. Lime means "act on this"; a file somebody attached is
 * a thing, not an action, and colouring it like a link is what made the old row
 * look like the only tappable object on the screen.
 */
@Composable
private fun FileChip(attachment: Attachment, modifier: Modifier = Modifier) {
    Row(
        modifier = modifier
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .padding(horizontal = Spacing.md, vertical = Spacing.sm),
        verticalAlignment = Alignment.CenterVertically,
    ) {
        Icon(
            imageVector = PqpIcons.Attach,
            contentDescription = null,
            tint = MaterialTheme.colorScheme.onSurfaceVariant,
            modifier = Modifier.size(Sizes.iconInline),
        )
        Spacer(Modifier.width(Spacing.sm))
        Text(
            text = attachment.filename,
            style = MaterialTheme.typography.bodySmall,
            color = MaterialTheme.colorScheme.onSurface,
            maxLines = 1,
            overflow = TextOverflow.Ellipsis,
        )
    }
}
