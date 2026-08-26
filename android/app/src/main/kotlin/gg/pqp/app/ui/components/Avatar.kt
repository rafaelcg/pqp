package gg.pqp.app.ui.components

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import gg.pqp.app.core.Backend
import kotlin.math.absoluteValue

/**
 * A picture when there is one, initials when there is not.
 *
 * The fallback colour is derived from the name rather than random, so the same
 * person is the same colour on every screen and between launches. A random one
 * would make a member list flicker on every recomposition.
 */
@Composable
fun Avatar(
    name: String,
    url: String?,
    modifier: Modifier = Modifier,
    size: Dp = 40.dp,
    cornerRadius: Dp = size / 2,
) {
    val shape = RoundedCornerShape(cornerRadius)
    val resolved = Backend.absolute(url)

    Box(
        modifier = modifier
            .size(size)
            .clip(shape)
            .background(tintFor(name)),
        contentAlignment = Alignment.Center,
    ) {
        if (resolved != null) {
            AsyncImage(
                model = resolved,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.size(size),
            )
        } else {
            Text(
                text = initials(name),
                color = Color.White,
                fontWeight = FontWeight.Bold,
                fontSize = (size.value / 2.6f).sp,
                style = MaterialTheme.typography.labelLarge,
            )
        }
    }
}

private val TINTS = listOf(
    Color(0xFF4C7A2E),
    Color(0xFF2E6A7A),
    Color(0xFF6A3E7A),
    Color(0xFF7A5A2E),
    Color(0xFF7A2E44),
    Color(0xFF2E4A7A),
)

private fun tintFor(name: String): Color =
    TINTS[(name.hashCode().absoluteValue) % TINTS.size]

private fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when {
        words.isEmpty() -> "?"
        words.size == 1 -> words[0].take(2).uppercase()
        else -> (words[0].take(1) + words[1].take(1)).uppercase()
    }
}
