package gg.pqp.app.stories.ui

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.BoxWithConstraints
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.offset
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.wrapContentSize
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.Text
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.geometry.Offset
import androidx.compose.ui.layout.onGloballyPositioned
import androidx.compose.ui.layout.positionInRoot
import androidx.compose.ui.platform.LocalDensity
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.font.FontWeight
import androidx.compose.ui.text.rememberTextMeasurer
import androidx.compose.ui.text.style.TextAlign
import androidx.compose.ui.unit.Constraints
import androidx.compose.ui.unit.IntOffset
import androidx.compose.ui.unit.dp
import androidx.compose.ui.unit.sp
import gg.pqp.app.stories.StoryTextFit
import kotlin.math.roundToInt

/**
 * What the viewer's chrome covers while a reply is being typed, in root pixels:
 * the bottom of the header and the top of the footer (reactions and the reply
 * field, riding on the keyboard). Both null when nothing but the canvas's own
 * safe area is to be kept clear.
 */
data class StoryTextAvoid(val headerBottom: Float? = null, val footerTop: Float? = null)

/**
 * A text story from before layers: its words, sized into the canvas's safe
 * area and, with the keyboard up, into what is left between the header and the
 * footer. [TextCard] is the same card at a fixed size, for the small quote.
 */
@Composable
fun FittedTextCard(
    text: String,
    background: String?,
    avoid: StoryTextAvoid,
    modifier: Modifier = Modifier,
) {
    val measurer = rememberTextMeasurer()
    val density = LocalDensity.current
    var origin by remember { mutableStateOf(Offset.Zero) }
    val family = MaterialTheme.typography.headlineLarge.fontFamily
    val color = textOn(background)

    BoxWithConstraints(
        modifier = modifier
            .fillMaxSize()
            .background(backgroundBrush(background))
            .onGloballyPositioned { origin = it.positionInRoot() },
    ) {
        val box = StoryTextFit.box(
            width = constraints.maxWidth.toFloat(),
            height = constraints.maxHeight.toFloat(),
            headerBottom = avoid.headerBottom?.minus(origin.y),
            footerTop = avoid.footerTop?.minus(origin.y),
            gap = with(density) { 12.dp.toPx() },
        )
        val boxWidth = box.width.roundToInt()
        val boxHeight = box.height.roundToInt()
        val size = remember(text, boxWidth, boxHeight, family) {
            StoryTextFit.fontSize { sp ->
                val style = TextStyle(
                    fontSize = sp.sp,
                    lineHeight = (sp + 6).sp,
                    fontFamily = family,
                    fontWeight = FontWeight.Bold,
                    textAlign = TextAlign.Center,
                )
                measurer.measure(text, style, constraints = Constraints(maxWidth = boxWidth)).size.height <= boxHeight
            }
        }
        Text(
            text = text,
            color = color,
            fontSize = size.sp,
            lineHeight = (size + 6).sp,
            fontFamily = family,
            fontWeight = FontWeight.Bold,
            textAlign = TextAlign.Center,
            modifier = Modifier
                .offset { IntOffset(box.left.roundToInt(), box.top.roundToInt()) }
                .size(
                    with(density) { boxWidth.toDp() },
                    with(density) { boxHeight.toDp() },
                )
                .wrapContentSize(Alignment.Center),
        )
    }
}
