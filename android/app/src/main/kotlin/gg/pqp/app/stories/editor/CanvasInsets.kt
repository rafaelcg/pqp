package gg.pqp.app.stories.editor

import androidx.compose.foundation.layout.WindowInsets
import androidx.compose.foundation.layout.asPaddingValues
import androidx.compose.foundation.layout.navigationBars
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.statusBars
import androidx.compose.runtime.Composable
import androidx.compose.ui.Modifier
import androidx.compose.ui.unit.Dp
import androidx.compose.ui.unit.dp

/**
 * Where the tools go around a 9:16 canvas.
 *
 * On a screen taller than 9:16 the canvas leaves a bar above and below it.
 * Tool buttons wear a translucent disc, and a disc across the canvas edge shows
 * as a dark half circle on the picture and nothing on the bar. So the tools
 * never straddle: they sit inside the canvas, a little in from its edge (the
 * bars stay empty), or, on a screen that is 9:16 or close to it, under the
 * system bars as always.
 */
object CanvasInsets {

    /** How far in from the canvas edge the tools sit when they are inside it. */
    val INSET = 12.dp

    /** The height of one bar above or below a 9:16 canvas as wide as it can be: 0 on a 9:16 screen or a wider one. */
    fun gap(maxWidth: Dp, maxHeight: Dp): Dp {
        val canvasHeight = minOf(maxWidth, maxHeight * 9f / 16f) * 16f / 9f
        return ((maxHeight - canvasHeight) / 2f).coerceAtLeast(0.dp)
    }

    /** Top padding for tools given the bar: inside the canvas when the bar is deeper than the status bar. */
    fun top(gap: Dp, statusBar: Dp): Dp = if (gap > statusBar) gap + INSET else statusBar

    /** Bottom padding for tools given the bar: inside the canvas when the bar is deeper than the navigation bar. */
    fun bottom(gap: Dp, navigationBar: Dp): Dp = if (gap > navigationBar) gap + INSET else navigationBar
}

/** Tools along the top: below the status bar, or inside the canvas when there is a bar above it. */
@Composable
fun Modifier.toolsTop(gap: Dp): Modifier {
    val status = WindowInsets.statusBars.asPaddingValues().calculateTopPadding()
    return padding(top = CanvasInsets.top(gap, status))
}

/** Tools along the bottom: above the navigation bar, or inside the canvas when there is a bar below it. */
@Composable
fun Modifier.toolsBottom(gap: Dp): Modifier {
    val nav = WindowInsets.navigationBars.asPaddingValues().calculateBottomPadding()
    return padding(bottom = CanvasInsets.bottom(gap, nav))
}
