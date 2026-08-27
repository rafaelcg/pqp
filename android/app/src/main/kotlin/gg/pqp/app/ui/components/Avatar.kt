package gg.pqp.app.ui.components

import androidx.compose.animation.core.animateDpAsState
import androidx.compose.animation.core.spring
import androidx.compose.foundation.background
import androidx.compose.foundation.border
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.graphics.Color
import androidx.compose.ui.layout.ContentScale
import androidx.compose.material3.Text
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import coil3.compose.AsyncImage
import gg.pqp.app.core.Backend
import gg.pqp.app.ui.theme.Gabarito
import gg.pqp.app.ui.theme.Palette

/**
 * A picture when there is one, initials when there is not.
 *
 * ## The colour, which is the part that changed
 *
 * The monogram used to pick from six hand-written literals: a teal, a maroon, a
 * brown, an olive. Six colours chosen one at a time never agree with each other,
 * and a list of them looked like a list of unrelated apps' icons. They also had
 * nothing to do with pqp, and white-on-dark initials at 40dp are hard to read
 * besides.
 *
 * The rule now is the one the iOS client already uses: **hue is derived from a
 * stable hash of the seed, and saturation and lightness are fixed.** Every
 * monogram in the app is therefore a bright colour of the same weight, with the
 * ink colour on top, so a column of them reads as one designed set rather than
 * as six accidents. The same person is the same colour on every screen and
 * between launches, and the same colour as on iOS when the seed is the same id.
 *
 * `seed` defaults to the name so no call site has to change, but anything that
 * has an id should pass it: two people called "Ana" should not be the same
 * colour, and one person who renames themselves should not change colour.
 */
@Composable
fun Avatar(
    name: String,
    url: String?,
    modifier: Modifier = Modifier,
    size: Dp = 40.dp,
    cornerRadius: Dp = size / 2,
    seed: String = name,
    /**
     * A lime ring, animated in and out. The one place a person's picture is
     * allowed to carry the signal colour, and it means exactly one thing:
     * this person is talking right now.
     */
    speaking: Boolean = false,
) {
    val shape = RoundedCornerShape(cornerRadius)
    val resolved = Backend.absolute(url)

    // The ring is drawn INSIDE the avatar's own bounds, with the picture inset
    // to match. Drawing it outside would mean every avatar in a list reserving
    // 6dp it almost never uses, and a row that changes height the moment
    // somebody starts talking.
    val ring by animateDpAsState(
        targetValue = if (speaking) 2.5.dp else 0.dp,
        animationSpec = spring(dampingRatio = 0.7f, stiffness = 1400f),
        label = "speaking-ring",
    )

    Box(
        modifier = modifier
            .size(size)
            .then(if (ring > 0.dp) Modifier.border(ring, Palette.Signal, shape) else Modifier)
            .padding(ring + if (ring > 0.dp) 1.5.dp else 0.dp)
            .clip(shape)
            .background(monogramColor(seed)),
        contentAlignment = Alignment.Center,
    ) {
        if (resolved != null) {
            AsyncImage(
                model = resolved,
                contentDescription = null,
                contentScale = ContentScale.Crop,
                modifier = Modifier.fillMaxSize(),
            )
        } else {
            Text(
                text = initials(name),
                // Ink, not white. The derived colours below are bright by
                // construction, and white on a bright ground is the one
                // pairing that fails a contrast check at every hue.
                color = Palette.InkDeep,
                fontFamily = Gabarito,
                fontWeight = FontWeight.ExtraBold,
                fontSize = (size.value * 0.38f).sp,
                // The face is set solid; a line height taken from the theme
                // would push two capitals off centre in a circle.
                lineHeight = (size.value * 0.38f).sp,
            )
        }
    }
}

/**
 * The seed's colour.
 *
 * djb2 rather than `String.hashCode`, and that is not superstition:
 * `hashCode` on short similar strings (`general`, `geral`) clusters, so a
 * server list of near-identical names came out three shades of the same teal.
 * The multiply-and-add spreads them.
 *
 * Kept as a plain function so anything that wants to be "this person's colour"
 * (a banner, a chart, a speaking ring on a tile) derives the same one rather
 * than picking its own and drifting.
 */
fun monogramColor(seed: String): Color {
    var hash = 5381L
    for (byte in seed.toByteArray()) {
        hash = (hash * 33 + byte) and 0xFFFFFFFFL
    }
    val hue = (hash % 360L).toFloat()
    return Color.hsv(hue, SATURATION, VALUE)
}

// Fixed, so every monogram in the app is the same brightness and the same
// intensity of colour. Matched to the iOS client's 0.55 / 0.82.
private const val SATURATION = 0.55f
private const val VALUE = 0.82f

private fun initials(name: String): String {
    val words = name.trim().split(Regex("\\s+")).filter { it.isNotEmpty() }
    return when {
        words.isEmpty() -> "?"
        words.size == 1 -> words[0].take(2).uppercase()
        else -> (words[0].take(1) + words[1].take(1)).uppercase()
    }
}
