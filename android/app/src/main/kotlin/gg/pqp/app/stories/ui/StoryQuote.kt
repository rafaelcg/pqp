package gg.pqp.app.stories.ui

import androidx.compose.foundation.Canvas
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.layout.widthIn
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.platform.testTag
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.style.TextOverflow
import androidx.compose.ui.unit.dp
import coil3.compose.AsyncImage
import gg.pqp.app.R
import gg.pqp.app.core.ApiClient
import gg.pqp.app.stories.StoriesRules
import gg.pqp.app.stories.StoryCard
import gg.pqp.app.stories.storyCard
import gg.pqp.app.ui.theme.Spacing

/**
 * The story a DM reply quotes. While the story lives: its thumbnail (or text
 * card) and caption, and how long is left. After: a hatched "Story expirou"
 * plate with no picture and no caption, because the 24 h promise holds inside
 * conversations too. The server enforces that (`/card` never returns media
 * past expiry); this only draws what it says.
 */
@Composable
fun StoryQuote(api: ApiClient, storyId: String, mine: Boolean) {
    var card by remember(storyId) { mutableStateOf<StoryCard?>(null) }
    LaunchedEffect(storyId) {
        card = runCatching { api.storyCard(storyId) }.getOrElse { StoryCard(storyId = storyId, state = "expired") }
    }
    val current = card ?: return
    val live = current.state == "live"
    Row(
        verticalAlignment = Alignment.CenterVertically,
        modifier = Modifier
            .padding(bottom = Spacing.xs)
            .widthIn(max = 300.dp)
            .clip(MaterialTheme.shapes.small)
            .background(MaterialTheme.colorScheme.surfaceContainer)
            .border(1.dp, MaterialTheme.colorScheme.outlineVariant, MaterialTheme.shapes.small)
            .padding(Spacing.sm)
            .testTag("stories.quote"),
    ) {
        Box(
            Modifier
                .size(width = 40.dp, height = 56.dp)
                .clip(MaterialTheme.shapes.extraSmall),
        ) {
            when {
                !live -> Hatched()
                current.kind == "text" -> TextCard(current.text.orEmpty(), current.background, fontSize = 7)
                current.posterUrl != null -> AsyncImage(
                    model = absolute(current.posterUrl),
                    contentDescription = null,
                    contentScale = ContentScale.Crop,
                    modifier = Modifier.fillMaxSize(),
                )
                else -> Hatched()
            }
        }
        Spacer(Modifier.width(Spacing.sm))
        Column {
            Text(
                stringResource(if (mine) R.string.stories_quote_replied_to else R.string.stories_quote_replied).uppercase(),
                style = MaterialTheme.typography.labelSmall,
                color = MaterialTheme.colorScheme.onSurfaceVariant,
            )
            if (live) {
                (current.caption ?: current.text)?.takeIf { it.isNotBlank() }?.let {
                    Text(it, style = MaterialTheme.typography.bodyMedium, maxLines = 1, overflow = TextOverflow.Ellipsis)
                }
                StoriesRules.left(current.expiresAt, System.currentTimeMillis())?.let {
                    Text(
                        stringResource(R.string.stories_quote_left, it),
                        style = MaterialTheme.typography.bodySmall,
                        color = MaterialTheme.colorScheme.onSurfaceVariant,
                    )
                }
            } else {
                Text(stringResource(R.string.stories_quote_expired), style = MaterialTheme.typography.bodyMedium)
            }
        }
    }
}

@Composable
private fun Hatched() {
    val line = MaterialTheme.colorScheme.outlineVariant
    Canvas(Modifier.fillMaxSize().background(MaterialTheme.colorScheme.surfaceContainerHigh)) {
        val step = 8.dp.toPx()
        var x = -size.height
        while (x < size.width) {
            drawLine(line, Offset(x, size.height), Offset(x + size.height, 0f), strokeWidth = 2f)
            x += step
        }
    }
}
